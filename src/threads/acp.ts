import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { Client } from "@agentclientprotocol/sdk";

import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentHandlers,
} from "./threads";

export interface AgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

class AcpConnection implements AgentConnection {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private starting?: Promise<void>;
  private disposed = false;
  private readonly launch: AgentLaunch;
  private readonly handlers: AgentHandlers;
  private readonly log: (message: string) => void;

  constructor(
    launch: AgentLaunch,
    handlers: AgentHandlers,
    log: (message: string) => void
  ) {
    this.launch = launch;
    this.handlers = handlers;
    this.log = log;
  }

  async create(cwd: string) {
    await this.start();
    return this.requireConnection().newSession({ cwd, mcpServers: [] });
  }

  async load(sessionId: string, cwd: string) {
    await this.start();
    return this.requireConnection().loadSession({
      cwd,
      mcpServers: [],
      sessionId,
    });
  }

  async prompt(sessionId: string, text: string, messageId: string) {
    await this.start();
    return this.requireConnection().prompt({
      _meta: { "magpi-acp/client-message-id": messageId },
      prompt: [{ text, type: "text" }],
      sessionId,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.start();
    await this.requireConnection().cancel({ sessionId });
  }

  async setConfig(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    await this.start();
    await this.requireConnection().setSessionConfigOption(
      typeof value === "boolean"
        ? { configId, sessionId, type: "boolean", value }
        : { configId, sessionId, value }
    );
  }

  dispose(): void {
    this.disposed = true;
    this.connection = undefined;
    this.starting = undefined;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  private async start(): Promise<void> {
    if (this.connection) {
      return;
    }
    this.disposed = false;
    this.starting ??= this.startInternal();
    try {
      await this.starting;
    } catch (error) {
      this.starting = undefined;
      this.dispose();
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.launch.command, this.launch.args, {
      env: { ...process.env, ...this.launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        this.log(message);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.connection = undefined;
      this.starting = undefined;
      if (!this.disposed) {
        this.handlers.error(
          new Error(
            `MagPi ACP exited${code === null ? ` (${signal ?? "unknown"})` : ` (${code})`}`
          )
        );
      }
    });

    const output = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!child.stdin.writable) {
          throw new Error("MagPi ACP input closed");
        }
        if (!child.stdin.write(Buffer.from(chunk))) {
          await once(child.stdin, "drain");
        }
      },
    });
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout.on("data", (chunk: Buffer | string) => {
          controller.enqueue(new Uint8Array(Buffer.from(chunk)));
        });
        child.stdout.on("end", () => controller.close());
        child.stdout.on("error", (error) => controller.error(error));
      },
    });
    const client: Client = {
      requestPermission: (request) => this.handlers.permission(request),
      sessionUpdate: async ({ update }) => {
        await this.handlers.update(update);
      },
      unstable_createElicitation: (request) =>
        this.handlers.elicitation(request),
    };
    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(output, input)
    );
    this.connection = connection;

    const initialized = connection.initialize({
      clientCapabilities: {
        _meta: { "terminal-auth": true },
        elicitation: { form: {} },
        plan: {},
      },
      clientInfo: { name: "mischief", title: "Mischief", version: "0.1.0" },
      protocolVersion: 1,
    });
    const childError = async (): Promise<never> => {
      const [error] = await once(child, "error");
      throw error;
    };
    await Promise.race([initialized, childError()]);
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("MagPi ACP is not connected");
    }
    return this.connection;
  }
}

export const acpConnectionFactory =
  (
    launch: AgentLaunch,
    log: (message: string) => void
  ): AgentConnectionFactory =>
  (handlers) =>
    new AcpConnection(launch, handlers, log);
