/* oxlint-disable no-await-in-loop, promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- connection retries are sequential; socket events settle request promises */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const MAX_PENDING_INPUT = 8 * 1024 * 1024;
const PROTOCOL_VERSION = 1;

export interface HostClientOptions {
  socketPath?: string;
  start?: () => Promise<void>;
  timeoutMs?: number;
}

export type HostEvent = Record<string, unknown> & { type: string };
export type HostConnectionState = "connecting" | "connected" | "unreachable";

export interface HostConnectionStatus {
  message?: string;
  state: HostConnectionState;
}

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const authentication = (
  value: unknown
): Record<string, unknown> | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("label" in value) ||
    typeof value.label !== "string"
  ) {
    return undefined;
  }
  if ("methodId" in value && typeof value.methodId === "string") {
    return { label: value.label, methodId: value.methodId };
  }
  const env = "env" in value ? value.env : undefined;
  if (
    !("command" in value) ||
    typeof value.command !== "string" ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    !value.args.every((argument) => typeof argument === "string") ||
    (env !== undefined &&
      (typeof env !== "object" ||
        env === null ||
        !Object.values(env).every((entry) => typeof entry === "string")))
  ) {
    return undefined;
  }
  return {
    args: value.args,
    command: value.command,
    ...(env === undefined ? {} : { env }),
    label: value.label,
  };
};

const startLaunchdHost = async (): Promise<void> => {
  if (process.platform !== "darwin") {
    throw new Error("Mischief Host requires macOS");
  }
  const service = `gui/${String(process.getuid?.() ?? -1)}/works.digitaloverground.mischief.host`;
  const child = spawn("/bin/launchctl", ["kickstart", service], {
    stdio: "ignore",
  });
  const result: unknown = await once(child, "exit");
  const code =
    Array.isArray(result) && typeof result[0] === "number"
      ? result[0]
      : undefined;
  if (code !== 0) {
    throw new Error(
      "Mischief Host is not installed. Open the Mischief macOS app first."
    );
  }
};

const openSocket = async (socketPath: string): Promise<Socket> =>
  // oxlint-disable-next-line promise/avoid-new -- node:net exposes connection completion through events.
  await new Promise<Socket>((resolve, reject) => {
    const socket = connect(socketPath);
    const failed = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once("connect", () => {
      socket.off("error", failed);
      resolve(socket);
    });
    socket.once("error", failed);
  });

export class HostClient {
  private automaticReconnect = false;
  private closed = false;
  private readonly connectionListeners = new Set<
    (status: HostConnectionStatus) => void
  >();
  private connectionStatus: HostConnectionStatus = { state: "connecting" };
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly options: HostClientOptions;
  private pendingInput = "";
  private readonly queuedEvents: HostEvent[] = [];
  private reconnecting?: Promise<void>;
  private readonly requests = new Map<string, PendingRequest>();
  private socket?: Socket;

  private constructor(options: HostClientOptions) {
    this.options = options;
  }

  static async connect(options: HostClientOptions = {}): Promise<HostClient> {
    const client = new HostClient(options);
    try {
      await client.establish(options.timeoutMs ?? 5000);
      client.automaticReconnect = true;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  static watch(options: HostClientOptions = {}): HostClient {
    const client = new HostClient(options);
    client.automaticReconnect = true;
    client.scheduleReconnect();
    return client;
  }

  onConnectionChange(
    listener: (status: HostConnectionStatus) => void
  ): () => void {
    this.connectionListeners.add(listener);
    listener({ ...this.connectionStatus });
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.queuedEvents.splice(0)) {
      listener(event);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  async request(
    action: string,
    fields: Record<string, unknown> = {}
  ): Promise<unknown> {
    const { socket } = this;
    if (this.closed || !socket || this.connectionStatus.state !== "connected") {
      throw new Error("Mischief Host is unreachable");
    }
    const requestId = randomUUID();
    const message = `${JSON.stringify({ ...fields, action, requestId, type: "command" })}\n`;
    if (Buffer.byteLength(message) > MAX_PENDING_INPUT) {
      throw new Error(
        "Message is too large to send (8 MB limit). Remove an image or send a smaller one."
      );
    }
    // oxlint-disable-next-line promise/avoid-new -- the Host result settles this request by ID.
    const result = new Promise<unknown>((resolve, reject) => {
      this.requests.set(requestId, { reject, resolve });
    });
    socket.write(message);
    return await result;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.automaticReconnect = false;
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectRequests(new Error("Mischief Host client closed"));
    this.listeners.clear();
    this.connectionListeners.clear();
  }

  private async establish(timeoutMs: number): Promise<void> {
    this.setConnectionStatus({ state: "connecting" });
    const socketPath =
      this.options.socketPath ??
      path.join(homedir(), "Library/Application Support/Mischief/host.sock");
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    try {
      await (this.options.start ?? startLaunchdHost)();
    } catch (error) {
      lastError = error;
    }
    while (!this.closed && Date.now() < deadline) {
      try {
        const socket = await openSocket(socketPath);
        this.attach(socket);
        await this.handshake();
        this.setConnectionStatus({ state: "connected" });
        return;
      } catch (error) {
        lastError = error;
        this.socket?.destroy();
        this.socket = undefined;
        await delay(50);
      }
    }
    const failure = new Error(
      `Could not connect to Mischief Host: ${errorMessage(lastError)}`,
      { cause: lastError }
    );
    this.setConnectionStatus({
      message: failure.message,
      state: "unreachable",
    });
    throw failure;
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.pendingInput = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => {
      if (this.socket === socket) {
        this.receive(chunk);
      }
    });
    socket.on("close", () => {
      this.disconnected(socket, new Error("Mischief Host disconnected"));
    });
    socket.on("error", (error) => {
      this.disconnected(socket, error);
    });
  }

  private async handshake(): Promise<void> {
    // oxlint-disable-next-line promise/avoid-new -- the protocol hello settles through the socket event handler.
    const hello = new Promise<unknown>((resolve, reject) => {
      this.requests.set("__hello", { reject, resolve });
    });
    this.socket?.write(
      `${JSON.stringify({ type: "hello", version: PROTOCOL_VERSION })}\n`
    );
    await Promise.race([
      hello,
      delay(5000).then(() => {
        throw new Error("Mischief Host handshake timed out");
      }),
    ]);
  }

  private receive(chunk: string): void {
    this.pendingInput += chunk;
    if (this.pendingInput.length > MAX_PENDING_INPUT) {
      this.socket?.destroy(new Error("Mischief Host message exceeded 8 MiB"));
      return;
    }
    let end = this.pendingInput.indexOf("\n");
    while (end !== -1) {
      const line = this.pendingInput.slice(0, end);
      this.pendingInput = this.pendingInput.slice(end + 1);
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        this.socket?.destroy(new Error("Mischief Host sent invalid JSON"));
        return;
      }
      this.message(message);
      end = this.pendingInput.indexOf("\n");
    }
  }

  // oxlint-disable-next-line complexity -- validates each versioned Host message variant.
  private message(message: unknown): void {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      typeof message.type !== "string"
    ) {
      this.socket?.destroy(new Error("Mischief Host sent an invalid message"));
      return;
    }
    if (message.type === "hello") {
      if (!("version" in message) || message.version !== PROTOCOL_VERSION) {
        this.socket?.destroy(new Error("Incompatible Mischief Host protocol"));
        return;
      }
      const handshake = this.requests.get("__hello");
      if (handshake) {
        this.requests.delete("__hello");
        handshake.resolve(message);
      }
      return;
    }
    if (
      message.type === "result" &&
      "requestId" in message &&
      typeof message.requestId === "string"
    ) {
      const pending = this.requests.get(message.requestId);
      if (!pending) {
        return;
      }
      this.requests.delete(message.requestId);
      if ("error" in message && typeof message.error === "string") {
        const error = new Error(message.error);
        const auth = authentication(
          "authentication" in message ? message.authentication : undefined
        );
        pending.reject(
          auth ? Object.assign(error, { authentication: auth }) : error
        );
      } else {
        pending.resolve("value" in message ? message.value : undefined);
      }
      return;
    }
    const event: HostEvent = { ...message, type: message.type };
    if (this.listeners.size === 0) {
      if (this.queuedEvents.length >= 1000) {
        this.socket?.destroy(
          new Error("Mischief Host sent too many events before subscription")
        );
        return;
      }
      this.queuedEvents.push(event);
    } else {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  private disconnected(socket: Socket, error: Error): void {
    if (this.closed || this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.rejectRequests(error);
    this.setConnectionStatus({ message: error.message, state: "unreachable" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.automaticReconnect || this.closed || this.reconnecting) {
      return;
    }
    this.reconnecting = (async () => {
      while (!this.closed && this.connectionStatus.state !== "connected") {
        try {
          await this.establish(this.options.timeoutMs ?? 1000);
        } catch {
          await delay(1000);
        }
      }
    })().finally(() => {
      this.reconnecting = undefined;
    });
  }

  private setConnectionStatus(status: HostConnectionStatus): void {
    if (
      this.connectionStatus.state === status.state &&
      this.connectionStatus.message === status.message
    ) {
      return;
    }
    this.connectionStatus = status;
    for (const listener of this.connectionListeners) {
      listener({ ...status });
    }
  }

  private rejectRequests(error: Error): void {
    for (const pending of this.requests.values()) {
      pending.reject(error);
    }
    this.requests.clear();
  }
}
