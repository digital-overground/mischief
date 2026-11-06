import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import {
  client,
  CreateElicitationRequest as CreateElicitationRequestGuard,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

export interface HostAgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HostAcpSession {
  configOptions?: SessionConfigOption[] | null;
  sessionId: string;
}

export interface HostPromptImage {
  data: string;
  mimeType: string;
}

export interface HostAcpHandlers {
  elicitation: (
    request: Extract<CreateElicitationRequest, { mode: "form" }>
  ) => Promise<CreateElicitationResponse>;
  error: (error: Error) => void;
  permission: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  update: (sessionId: string, update: SessionUpdate) => void;
}

/** One long-lived Agent process shared by every client of the Host. */
export class HostAcpConnection {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private starting?: Promise<void>;
  private disposed = false;
  private supportsImages = false;
  private readonly launch: HostAgentLaunch;
  private readonly handlers: HostAcpHandlers;

  constructor(launch: HostAgentLaunch, handlers: HostAcpHandlers) {
    this.launch = launch;
    this.handlers = handlers;
  }

  async inspect(): Promise<void> {
    await this.agent();
  }

  async create(cwd: string): Promise<HostAcpSession> {
    const agent = await this.agent();
    const response = await agent.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });
    return {
      configOptions: response.configOptions,
      sessionId: response.sessionId,
    };
  }

  async load(sessionId: string, cwd: string): Promise<HostAcpSession> {
    const agent = await this.agent();
    const response = await agent.request(methods.agent.session.load, {
      cwd,
      mcpServers: [],
      sessionId,
    });
    return { configOptions: response.configOptions, sessionId };
  }

  async prompt(
    sessionId: string,
    text: string,
    images: HostPromptImage[]
  ): Promise<"cancelled" | "completed"> {
    const agent = await this.agent();
    if (images.length > 0 && !this.supportsImages) {
      throw new Error("This Agent does not support pasted images");
    }
    const prompt: ContentBlock[] = [
      ...(text.length > 0 ? [{ text, type: "text" as const }] : []),
      ...images.map((image) => ({ ...image, type: "image" as const })),
    ];
    const response = await agent.request(methods.agent.session.prompt, {
      prompt,
      sessionId,
    });
    return response.stopReason === "cancelled" ? "cancelled" : "completed";
  }

  async cancel(sessionId: string): Promise<void> {
    const agent = await this.agent();
    await agent.notify(methods.agent.session.cancel, { sessionId });
  }

  async setConfig(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    const agent = await this.agent();
    await agent.request(
      methods.agent.session.setConfigOption,
      typeof value === "boolean"
        ? { configId, sessionId, type: "boolean", value }
        : { configId, sessionId, value }
    );
  }

  dispose(): void {
    this.disposed = true;
    this.connection?.close();
    this.connection = undefined;
    this.starting = undefined;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  private async agent() {
    if (!this.connection) {
      this.starting ??= this.start();
      try {
        await this.starting;
      } catch (error) {
        this.starting = undefined;
        this.dispose();
        throw error;
      }
    }
    if (!this.connection) {
      throw new Error("Agent connection did not start");
    }
    return this.connection.agent;
  }

  private async start(): Promise<void> {
    this.disposed = false;
    const child = spawn(this.launch.command, this.launch.args, {
      env: { ...process.env, ...this.launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        this.handlers.error(new Error(message));
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
            `Agent exited${code === null ? ` (${signal ?? "unknown"})` : ` (${code})`}`
          )
        );
      }
    });

    const output = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!child.stdin.writable) {
          throw new Error("Agent input closed");
        }
        if (!child.stdin.write(Buffer.from(chunk))) {
          await once(child.stdin, "drain");
        }
      },
    });
    let inputClosed = false;
    const input = new ReadableStream<Uint8Array>({
      cancel: () => {
        inputClosed = true;
      },
      start: (controller) => {
        child.stdout.on("data", (chunk: Buffer | string) => {
          if (!inputClosed) {
            controller.enqueue(new Uint8Array(Buffer.from(chunk)));
          }
        });
        child.stdout.on("end", () => {
          if (!inputClosed) {
            inputClosed = true;
            controller.close();
          }
        });
        child.stdout.on("error", (error) => {
          if (!inputClosed) {
            inputClosed = true;
            controller.error(error);
          }
        });
      },
    });
    const app = client({ name: "mischief-host" })
      .onRequest(methods.client.elicitation.create, async ({ params }) =>
        CreateElicitationRequestGuard.isForm(params)
          ? await this.handlers.elicitation(params)
          : { action: "decline" }
      )
      .onRequest(
        methods.client.session.requestPermission,
        async ({ params }) => await this.handlers.permission(params)
      )
      .onNotification(methods.client.session.update, async ({ params }) => {
        await Promise.resolve();
        this.handlers.update(params.sessionId, params.update);
      });
    const connection = app.connect(ndJsonStream(output, input));
    this.connection = connection;
    const initialized = connection.agent.request(methods.agent.initialize, {
      clientCapabilities: {
        elicitation: { form: {} },
        plan: {},
      },
      clientInfo: {
        name: "mischief-host",
        title: "Mischief Host",
        version: "0.3.2",
      },
      protocolVersion: 1,
    });
    const childError = async (): Promise<never> => {
      const errors: unknown = await once(child, "error");
      throw Array.isArray(errors) ? errors[0] : errors;
    };
    const response = await Promise.race([initialized, childError()]);
    this.supportsImages =
      response.agentCapabilities?.promptCapabilities?.image === true;
  }
}
