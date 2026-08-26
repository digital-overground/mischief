import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ClientSideConnection, ndJsonStream, type Client } from "@agentclientprotocol/sdk";
import type { AgentConnection, AgentConnectionFactory, AgentHandlers } from "./threads";

export interface AgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function acpConnectionFactory(
  launch: AgentLaunch,
  log: (message: string) => void,
): AgentConnectionFactory {
  return (handlers) => new AcpConnection(launch, handlers, log);
}

class AcpConnection implements AgentConnection {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private starting?: Promise<void>;
  private disposed = false;

  constructor(
    private readonly launch: AgentLaunch,
    private readonly handlers: AgentHandlers,
    private readonly log: (message: string) => void,
  ) {}

  async create(cwd: string) {
    await this.start();
    return this.requireConnection().newSession({ cwd, mcpServers: [] });
  }

  async load(sessionId: string, cwd: string) {
    await this.start();
    return this.requireConnection().loadSession({ sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string, messageId: string) {
    await this.start();
    return this.requireConnection().prompt({
      sessionId,
      prompt: [{ type: "text", text }],
      _meta: { "magpi-acp/client-message-id": messageId },
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.start();
    await this.requireConnection().cancel({ sessionId });
  }

  async setConfig(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    await this.start();
    await this.requireConnection().setSessionConfigOption(
      typeof value === "boolean"
        ? { sessionId, configId, type: "boolean", value }
        : { sessionId, configId, value },
    );
  }

  dispose(): void {
    this.disposed = true;
    this.connection = undefined;
    this.starting = undefined;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = undefined;
  }

  private async start(): Promise<void> {
    if (this.connection) return;
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) this.log(message);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.connection = undefined;
      this.starting = undefined;
      if (!this.disposed) {
        this.handlers.error(
          new Error(
            `MagPi ACP exited${code === null ? ` (${signal ?? "unknown"})` : ` (${code})`}`,
          ),
        );
      }
    });

    const output = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          if (!child.stdin.writable) {
            reject(new Error("MagPi ACP input closed"));
            return;
          }
          child.stdin.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()));
        }),
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
      sessionUpdate: async ({ update }) => this.handlers.update(update),
      unstable_createElicitation: (request) => this.handlers.elicitation(request),
    };
    const connection = new ClientSideConnection(() => client, ndJsonStream(output, input));
    this.connection = connection;

    const initialized = connection.initialize({
      protocolVersion: 1,
      clientInfo: { name: "mischief", title: "Mischief", version: "0.1.0" },
      clientCapabilities: {
        plan: {},
        elicitation: { form: {} },
        _meta: { "terminal-auth": true },
      },
    });
    await Promise.race([
      initialized,
      new Promise<never>((_, reject) => child.once("error", reject)),
    ]);
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) throw new Error("MagPi ACP is not connected");
    return this.connection;
  }
}
