import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  cwd?: string;
  env?: Record<string, string>;
}

export interface HostAcpSession {
  configOptions?: SessionConfigOption[] | null;
  operations: {
    branchSummary: boolean;
    forkMessage: boolean;
    treeNavigation: boolean;
  };
  sessionId: string;
}

export interface HostHistoryEntry {
  cwd: string;
  meta?: Record<string, unknown> | null;
  sessionId: string;
  title?: string;
  updatedAt?: string;
}

export interface HostPromptImage {
  data: string;
  mimeType: string;
}

interface HostAuthentication {
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  label: string;
  methodId?: string;
}

const MAX_CONTEXT_BYTES = 1_000_000;
const MAX_CONTEXT_FILES = 20;
const MAGPI_BRANCH_SUMMARY = "magpi-acp/branch-summary";
const MAGPI_MESSAGE_ACTIONS = "magpi-acp/message-target-actions";
const MAGPI_FORK_MESSAGE_ID = "magpi-acp/fork-message-id";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const stringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "string");

const authenticationLabel = (value: unknown, fallback?: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return typeof fallback === "string" ? fallback : "Authenticate";
};

const referencedPaths = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/(?:^|\s)@(?<path>[^\s]+)/gu)]
      .map((match) => match.groups?.path)
      .filter(
        (candidate): candidate is string =>
          typeof candidate === "string" &&
          candidate.length > 0 &&
          !candidate.endsWith("/")
      )
  ),
];

export interface HostAcpHandlers {
  elicitation: (
    request: Extract<CreateElicitationRequest, { mode: "form" }>
  ) => Promise<CreateElicitationResponse>;
  error: (error: Error) => void;
  permission: (
    request: RequestPermissionRequest
  ) => Promise<RequestPermissionResponse>;
  update: (
    sessionId: string,
    update: SessionUpdate,
    meta?: Record<string, unknown> | null
  ) => void;
}

/** One long-lived Agent process shared by every client of the Host. */
export class HostAcpConnection {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private starting?: Promise<void>;
  private readonly authMethods: unknown[] = [];
  private readonly cwd = new Map<string, string>();
  private disposed = false;
  private operations = {
    branchSummary: false,
    forkMessage: false,
    treeNavigation: false,
  };
  private supportsEmbeddedContext = false;
  private supportsHistory = false;
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
    return await this.call(async () => {
      const agent = await this.agent();
      const response = await agent.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      this.cwd.set(response.sessionId, cwd);
      return {
        configOptions: response.configOptions,
        operations: this.operations,
        sessionId: response.sessionId,
      };
    });
  }

  async load(sessionId: string, cwd: string): Promise<HostAcpSession> {
    return await this.call(async () => {
      const agent = await this.agent();
      const response = await agent.request(methods.agent.session.load, {
        cwd,
        mcpServers: [],
        sessionId,
      });
      this.cwd.set(sessionId, cwd);
      return {
        configOptions: response.configOptions,
        operations: this.operations,
        sessionId,
      };
    });
  }

  async prompt(
    sessionId: string,
    text: string,
    images: HostPromptImage[]
  ): Promise<"cancelled" | "completed"> {
    return await this.call(async () => {
      const agent = await this.agent();
      if (images.length > 0 && !this.supportsImages) {
        throw new Error("This Agent does not support pasted images");
      }
      const prompt = await this.promptContent(sessionId, text, images);
      const response = await agent.request(methods.agent.session.prompt, {
        prompt,
        sessionId,
      });
      return response.stopReason === "cancelled" ? "cancelled" : "completed";
    });
  }

  async forkMessage(
    sessionId: string,
    cwd: string,
    messageId: string
  ): Promise<HostAcpSession> {
    return await this.call(async () => {
      if (!this.operations.forkMessage) {
        throw new Error("This Agent does not support Fork at a message");
      }
      const agent = await this.agent();
      const response = await agent.request(methods.agent.session.fork, {
        _meta: { [MAGPI_FORK_MESSAGE_ID]: messageId },
        cwd,
        mcpServers: [],
        sessionId,
      });
      this.cwd.set(response.sessionId, cwd);
      return {
        configOptions: response.configOptions,
        operations: this.operations,
        sessionId: response.sessionId,
      };
    });
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
    await this.call(async () => {
      const agent = await this.agent();
      const result = await agent.request(
        methods.agent.session.setConfigOption,
        typeof value === "boolean"
          ? { configId, sessionId, type: "boolean", value }
          : { configId, sessionId, value }
      );
      if (result.configOptions !== undefined) {
        this.handlers.update(sessionId, {
          configOptions: result.configOptions,
          sessionUpdate: "config_option_update",
        });
      }
    });
  }

  async authenticate(methodId: string): Promise<void> {
    if (
      !this.authMethods.some(
        (method) => isRecord(method) && method.id === methodId
      )
    ) {
      throw new Error("Unknown Agent authentication method");
    }
    await this.call(async () => {
      const agent = await this.agent();
      await agent.request(methods.agent.authenticate, { methodId });
    });
  }

  async history(cwd: string): Promise<HostHistoryEntry[]> {
    return await this.call(async () => {
      const agent = await this.agent();
      if (!this.supportsHistory) {
        throw new Error("This Agent does not support Thread History");
      }
      const entries: HostHistoryEntry[] = [];
      let cursor: string | undefined;
      do {
        // Pages are cursor-dependent and must remain sequential.
        // oxlint-disable-next-line no-await-in-loop
        const page = await agent.request(methods.agent.session.list, {
          cwd,
          ...(cursor === undefined ? {} : { cursor }),
        });
        entries.push(
          ...page.sessions
            .filter((session) => session.cwd === cwd)
            .map((session) => ({
              cwd: session.cwd,
              ...(session._meta === undefined ? {} : { meta: session._meta }),
              sessionId: session.sessionId,
              ...(typeof session.title === "string"
                ? { title: session.title }
                : {}),
              ...(typeof session.updatedAt === "string"
                ? { updatedAt: session.updatedAt }
                : {}),
            }))
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined && cursor.length > 0);
      return entries;
    });
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

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const authentication = this.authenticationFor(error);
      if (authentication) {
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { authentication }
        );
      }
      throw error;
    }
  }

  // oxlint-disable-next-line complexity -- supports standard and legacy ACP authentication shapes.
  private authenticationFor(error: unknown): HostAuthentication | undefined {
    if (!isRecord(error) || error.code !== -32_000) {
      return undefined;
    }
    const data = isRecord(error.data) ? error.data : undefined;
    const advertised = Array.isArray(data?.authMethods)
      ? data.authMethods
      : this.authMethods;
    for (const candidate of advertised) {
      if (!isRecord(candidate)) {
        continue;
      }
      const { args, env } = candidate;
      if (
        candidate.type === "terminal" &&
        (args === undefined || stringArray(args)) &&
        (env === undefined || stringRecord(env))
      ) {
        return {
          args: [...this.launch.args, ...(args ?? [])],
          command: this.launch.command,
          ...(stringRecord(env) ? { env: { ...this.launch.env, ...env } } : {}),
          label: authenticationLabel(candidate.name),
        };
      }
      const meta = isRecord(candidate._meta) ? candidate._meta : undefined;
      const legacy = isRecord(meta?.["terminal-auth"])
        ? meta["terminal-auth"]
        : undefined;
      if (
        legacy &&
        typeof legacy.command === "string" &&
        stringArray(legacy.args)
      ) {
        return {
          args: legacy.args,
          command: legacy.command,
          ...(stringRecord(legacy.env) ? { env: legacy.env } : {}),
          label: authenticationLabel(legacy.label, candidate.name),
        };
      }
      if (typeof candidate.id === "string") {
        return {
          label: authenticationLabel(candidate.name),
          methodId: candidate.id,
        };
      }
    }
    return undefined;
  }

  private async promptContent(
    sessionId: string,
    text: string,
    images: HostPromptImage[]
  ): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [
      ...(text.length > 0 ? [{ text, type: "text" as const }] : []),
      ...images.map((image) => ({ ...image, type: "image" as const })),
    ];
    const cwd = this.cwd.get(sessionId);
    const references = referencedPaths(text);
    if (
      !this.supportsEmbeddedContext ||
      cwd === undefined ||
      !references.length
    ) {
      return blocks;
    }
    if (references.length > MAX_CONTEXT_FILES) {
      throw new Error(`Attach at most ${MAX_CONTEXT_FILES} context files`);
    }
    const root = await realpath(cwd);
    const resolved = await Promise.all(
      references.map(async (reference) => {
        let file: string;
        try {
          file = await realpath(path.resolve(root, reference));
        } catch {
          return null;
        }
        const relative = path.relative(root, file);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          return null;
        }
        const details = await stat(file);
        return details.isFile() ? { file, size: details.size } : null;
      })
    );
    const files = [
      ...new Map(
        resolved
          .filter(
            (item): item is { file: string; size: number } => item !== null
          )
          .map((item) => [item.file, item])
      ).values(),
    ];
    if (
      files.reduce((total, file) => total + file.size, 0) > MAX_CONTEXT_BYTES
    ) {
      throw new Error("Attached context exceeds 1 MB");
    }
    blocks.push(
      ...(await Promise.all(
        files.map(async ({ file }) => ({
          resource: {
            mimeType: "text/plain",
            text: await readFile(file, "utf-8"),
            uri: pathToFileURL(file).href,
          },
          type: "resource" as const,
        }))
      ))
    );
    return blocks;
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
    const hostDirectory = path.dirname(process.execPath);
    const inheritedPath = this.launch.env?.PATH ?? process.env.PATH ?? "";
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd ?? homedir(),
      env: {
        ...process.env,
        ...this.launch.env,
        PATH: [
          path.join(hostDirectory, "bin"),
          path.join(hostDirectory, "npm/bin"),
          hostDirectory,
          inheritedPath,
        ]
          .filter((entry) => entry.length > 0)
          .join(path.delimiter),
      },
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
        this.handlers.update(params.sessionId, params.update, params._meta);
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
    const capabilities = response.agentCapabilities;
    this.authMethods.splice(
      0,
      this.authMethods.length,
      ...(response.authMethods ?? [])
    );
    this.supportsImages = capabilities?.promptCapabilities?.image === true;
    this.supportsEmbeddedContext =
      capabilities?.promptCapabilities?.embeddedContext === true;
    this.supportsHistory = isRecord(capabilities?.sessionCapabilities?.list);
    const meta = isRecord(capabilities?._meta) ? capabilities._meta : undefined;
    const messageActions = meta?.[MAGPI_MESSAGE_ACTIONS] === true;
    this.operations = {
      branchSummary: meta?.[MAGPI_BRANCH_SUMMARY] === true,
      forkMessage:
        messageActions && isRecord(capabilities?.sessionCapabilities?.fork),
      // shortcut: tree navigation still needs cross-client transcript replacement; keep controls hidden until then.
      treeNavigation: false,
    };
  }
}
