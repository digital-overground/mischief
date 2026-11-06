/* oxlint-disable max-classes-per-file, no-use-before-define, promise/prefer-await-to-callbacks -- coordinator and its private connection share one protocol state machine */
import type {
  CreateElicitationRequest,
  RequestPermissionRequest,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import { isAgentId } from "../../../shared/threads/record";
import type { AgentId } from "../agents/update";
import {
  configOptions,
  elicitationRequest,
  elicitationResponse,
  permissionRequest,
  permissionResponse,
  translateSessionUpdate,
} from "../threads/acp/acp";
import type { AcpExtension } from "../threads/acp/models";
import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentHandlers,
  AgentHistoryEntry,
  AgentPromptResult,
  AgentSession,
  PromptImage,
} from "../threads/model";
import type { HostEvent } from "./host-client";

interface HostTransport {
  onEvent: (listener: (event: HostEvent) => void) => () => void;
  request: (
    action: string,
    fields?: Record<string, unknown>
  ) => Promise<unknown>;
}

interface HostThread {
  agentId: AgentId;
  configOptions?: unknown[] | null;
  error?: string;
  id: string;
  operations?: {
    branchSummary: boolean;
    forkMessage: boolean;
    treeNavigation: boolean;
  };
  sessionId?: string;
  workspace: string;
}

interface PendingPrompt {
  reject: (error: Error) => void;
  resolve: (result: AgentPromptResult) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hostOperations = (
  value: unknown
): HostThread["operations"] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.branchSummary !== "boolean" ||
    typeof value.forkMessage !== "boolean" ||
    typeof value.treeNavigation !== "boolean"
  ) {
    throw new Error("Mischief Host returned invalid Agent operations");
  }
  return {
    branchSummary: value.branchSummary,
    forkMessage: value.forkMessage,
    treeNavigation: value.treeNavigation,
  };
};

const hostThread = (value: unknown): HostThread => {
  if (
    !isRecord(value) ||
    typeof value.agentId !== "string" ||
    !isAgentId(value.agentId) ||
    typeof value.id !== "string" ||
    typeof value.workspace !== "string" ||
    (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
    (value.configOptions !== undefined &&
      value.configOptions !== null &&
      !Array.isArray(value.configOptions)) ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error("Mischief Host returned an invalid Thread");
  }
  return {
    agentId: value.agentId,
    ...(value.configOptions === undefined
      ? {}
      : { configOptions: value.configOptions }),
    ...(value.error === undefined ? {} : { error: value.error }),
    id: value.id,
    ...(value.operations === undefined
      ? {}
      : { operations: hostOperations(value.operations) }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    workspace: value.workspace,
  };
};

const promptId = (value: unknown): string => {
  if (!isRecord(value) || typeof value.promptId !== "string") {
    throw new Error("Mischief Host returned an invalid prompt result");
  }
  return value.promptId;
};

const unsupported = async (operation: string): Promise<never> =>
  await Promise.reject(
    new Error(`Mischief Host does not support ${operation} yet`)
  );

const agentSession = (thread: HostThread): AgentSession => {
  if (thread.sessionId === undefined) {
    throw new Error("Mischief Host Thread has no session");
  }
  // The signed Host forwards ACP SDK-parsed options over the private versioned protocol.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the array envelope is validated above.
  const rawOptions = thread.configOptions as Parameters<
    typeof configOptions
  >[0];
  return {
    configOptions: configOptions(rawOptions),
    operations: thread.operations ?? {
      branchSummary: false,
      forkMessage: false,
      treeNavigation: false,
    },
    sessionId: thread.sessionId,
  };
};

class HostAgentCoordinator {
  private readonly connections = new Set<HostAgentConnection>();
  private readonly deferredInteractions = new Map<string, HostEvent>();
  private readonly completed = new Map<string, AgentPromptResult | Error>();
  private readonly extensions?: (agentId: AgentId) => AcpExtension | undefined;
  private readonly interactions = new Set<string>();
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly threads = new Map<string, HostThread>();
  readonly transport: HostTransport;

  constructor(
    transport: HostTransport,
    extensions?: (agentId: AgentId) => AcpExtension | undefined
  ) {
    this.transport = transport;
    this.extensions = extensions;
    transport.onEvent((event) => {
      this.event(event);
    });
  }

  connection(handlers: AgentHandlers, agentId: AgentId): AgentConnection {
    const connection = new HostAgentConnection(this, handlers, agentId);
    this.connections.add(connection);
    return connection;
  }

  remove(connection: HostAgentConnection): void {
    this.connections.delete(connection);
  }

  attached(connection: HostAgentConnection): void {
    for (const [id, event] of this.deferredInteractions) {
      if (this.connectionFor(event) !== connection) {
        continue;
      }
      this.deferredInteractions.delete(id);
      if (event.type === "acpPermission") {
        void this.permission(event);
      } else if (event.type === "acpElicitation") {
        void this.elicitation(event);
      }
    }
  }

  threadFor(agentId: AgentId, sessionId: string, cwd?: string): HostThread {
    const thread = [...this.threads.values()].find(
      (candidate) =>
        candidate.agentId === agentId &&
        candidate.sessionId === sessionId &&
        (cwd === undefined || candidate.workspace === cwd)
    );
    if (!thread) {
      throw new Error("Thread is not owned by the Mischief Host");
    }
    return thread;
  }

  remember(thread: HostThread): void {
    this.threads.set(thread.id, thread);
  }

  extension(agentId: AgentId): AcpExtension | undefined {
    return this.extensions?.(agentId);
  }

  async waitForPrompt(id: string): Promise<AgentPromptResult> {
    const completed = this.completed.get(id);
    if (completed) {
      this.completed.delete(id);
      if (completed instanceof Error) {
        throw completed;
      }
      return completed;
    }
    // oxlint-disable-next-line promise/avoid-new -- completion arrives asynchronously from the Host by prompt ID.
    return await new Promise<AgentPromptResult>((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
    });
  }

  private event(event: HostEvent): void {
    switch (event.type) {
      case "threads": {
        if (Array.isArray(event.threads)) {
          for (const candidate of event.threads) {
            try {
              this.remember(hostThread(candidate));
            } catch {
              // Ignore one malformed snapshot entry; command responses remain strictly validated.
            }
          }
        }
        break;
      }
      case "threadPromptComplete": {
        if (
          typeof event.promptId === "string" &&
          (event.stopReason === "completed" || event.stopReason === "cancelled")
        ) {
          this.completePrompt(event.promptId, { stopReason: event.stopReason });
        }
        break;
      }
      case "threadPromptError": {
        if (
          typeof event.promptId === "string" &&
          typeof event.message === "string"
        ) {
          this.failPrompt(event.promptId, new Error(event.message));
        }
        break;
      }
      case "acpUpdate": {
        this.update(event);
        break;
      }
      case "acpPermission": {
        void this.permission(event);
        break;
      }
      case "acpElicitation": {
        void this.elicitation(event);
        break;
      }
      case "acpError": {
        if (
          typeof event.agentId === "string" &&
          typeof event.message === "string"
        ) {
          for (const connection of this.connections) {
            if (connection.agentId === event.agentId) {
              connection.handlers.error(new Error(event.message));
            }
          }
        }
        break;
      }
      default: {
        break;
      }
    }
  }

  private connectionFor(event: HostEvent): HostAgentConnection | undefined {
    let { threadId } = event;
    if (
      typeof threadId !== "string" &&
      isRecord(event.request) &&
      typeof event.request.sessionId === "string"
    ) {
      const { sessionId } = event.request;
      threadId = [...this.threads.values()].find(
        (thread) => thread.sessionId === sessionId
      )?.id;
    }
    if (typeof threadId !== "string") {
      return undefined;
    }
    return [...this.connections].find(
      (connection) => connection.threadId === threadId
    );
  }

  private update(event: HostEvent): void {
    const connection = this.connectionFor(event);
    if (
      !connection ||
      !isRecord(event.update) ||
      typeof event.update.sessionUpdate !== "string"
    ) {
      return;
    }
    // The signed Host receives this value from the ACP SDK's parsed SessionUpdate callback.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- outer private-protocol fields are validated above.
    const update = event.update as SessionUpdate;
    const translated = translateSessionUpdate(
      update,
      isRecord(event.meta) ? event.meta : undefined,
      this.extension(connection.agentId)
    );
    if (translated) {
      connection.handlers.update(translated);
    }
  }

  private async permission(event: HostEvent): Promise<void> {
    const connection = this.connectionFor(event);
    if (!connection && typeof event.interactionId === "string") {
      this.deferredInteractions.set(event.interactionId, event);
      return;
    }
    if (
      !connection ||
      typeof event.interactionId !== "string" ||
      this.interactions.has(event.interactionId) ||
      !isRecord(event.request) ||
      !Array.isArray(event.request.options) ||
      !isRecord(event.request.toolCall)
    ) {
      return;
    }
    this.interactions.add(event.interactionId);
    try {
      // The signed Host receives this request from the ACP SDK before forwarding it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- required request fields are checked above.
      const request = event.request as unknown as RequestPermissionRequest;
      const response = await connection.handlers.permission(
        permissionRequest(request)
      );
      await this.transport.request("acpRespondPermission", {
        interactionId: event.interactionId,
        response: permissionResponse(response),
      });
    } catch (error) {
      connection.handlers.error(
        error instanceof Error ? error : new Error(String(error))
      );
      try {
        await this.transport.request("acpRespondPermission", {
          interactionId: event.interactionId,
          response: { outcome: { outcome: "cancelled" } },
        });
      } catch (responseError) {
        connection.handlers.error(
          responseError instanceof Error
            ? responseError
            : new Error(String(responseError))
        );
      }
    } finally {
      this.interactions.delete(event.interactionId);
    }
  }

  private async elicitation(event: HostEvent): Promise<void> {
    const connection = this.connectionFor(event);
    if (!connection && typeof event.interactionId === "string") {
      this.deferredInteractions.set(event.interactionId, event);
      return;
    }
    if (
      !connection ||
      typeof event.interactionId !== "string" ||
      this.interactions.has(event.interactionId) ||
      !isRecord(event.request) ||
      event.request.mode !== "form" ||
      typeof event.request.message !== "string" ||
      !isRecord(event.request.requestedSchema)
    ) {
      return;
    }
    this.interactions.add(event.interactionId);
    try {
      // The signed Host receives this request from the ACP SDK before forwarding it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- form request envelope is checked above.
      const request = event.request as unknown as Extract<
        CreateElicitationRequest,
        { mode: "form" }
      >;
      const response = await connection.handlers.elicitation(
        elicitationRequest(request)
      );
      await this.transport.request("acpRespondElicitation", {
        interactionId: event.interactionId,
        response: elicitationResponse(request, response),
      });
    } catch (error) {
      connection.handlers.error(
        error instanceof Error ? error : new Error(String(error))
      );
      try {
        await this.transport.request("acpRespondElicitation", {
          interactionId: event.interactionId,
          response: { action: "cancel" },
        });
      } catch (responseError) {
        connection.handlers.error(
          responseError instanceof Error
            ? responseError
            : new Error(String(responseError))
        );
      }
    } finally {
      this.interactions.delete(event.interactionId);
    }
  }

  private completePrompt(id: string, result: AgentPromptResult): void {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      pending.resolve(result);
    } else {
      this.rememberCompletion(id, result);
    }
  }

  private failPrompt(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.delete(id);
      pending.reject(error);
    } else {
      this.rememberCompletion(id, error);
    }
  }

  private rememberCompletion(
    id: string,
    result: AgentPromptResult | Error
  ): void {
    this.completed.set(id, result);
    if (this.completed.size > 1000) {
      const oldest = this.completed.keys().next().value;
      if (typeof oldest === "string") {
        this.completed.delete(oldest);
      }
    }
  }
}

class HostAgentConnection implements AgentConnection {
  readonly agentId: AgentId;
  readonly handlers: AgentHandlers;
  private readonly coordinator: HostAgentCoordinator;
  private disposed = false;
  threadId?: string;

  constructor(
    coordinator: HostAgentCoordinator,
    handlers: AgentHandlers,
    agentId: AgentId
  ) {
    this.coordinator = coordinator;
    this.handlers = handlers;
    this.agentId = agentId;
  }

  async create(cwd: string, threadId?: string): Promise<AgentSession> {
    this.requireActive();
    const thread = hostThread(
      await this.coordinator.transport.request("threadCreate", {
        agentId: this.agentId,
        cwd,
        ...(threadId === undefined ? {} : { threadId }),
      })
    );
    if (threadId !== undefined && thread.id !== threadId) {
      throw new Error("Mischief Host returned another Thread ID");
    }
    this.assign(thread);
    return agentSession(thread);
  }

  async load(sessionId: string, cwd: string): Promise<AgentSession> {
    this.requireActive();
    const known = this.coordinator.threadFor(this.agentId, sessionId, cwd);
    const thread = hostThread(
      await this.coordinator.transport.request("threadLoad", {
        threadId: known.id,
      })
    );
    this.assign(thread);
    return agentSession(thread);
  }

  async prompt(
    sessionId: string,
    text: string,
    images: PromptImage[]
  ): Promise<AgentPromptResult> {
    this.requireSession(sessionId);
    const id = promptId(
      await this.coordinator.transport.request("threadPrompt", {
        images,
        text,
        threadId: this.threadId,
      })
    );
    return await this.coordinator.waitForPrompt(id);
  }

  async authenticate(methodId: string): Promise<void> {
    this.requireActive();
    await this.coordinator.transport.request("agentAuthenticate", {
      agentId: this.agentId,
      methodId,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.requireSession(sessionId);
    await this.coordinator.transport.request("threadCancel", {
      threadId: this.threadId,
    });
  }

  async history(cwd: string): Promise<AgentHistoryEntry[]> {
    this.requireActive();
    const value = await this.coordinator.transport.request("agentHistory", {
      agentId: this.agentId,
      cwd,
    });
    if (!Array.isArray(value)) {
      throw new TypeError("Mischief Host returned invalid Agent history");
    }
    return value.map((candidate) => {
      if (
        !isRecord(candidate) ||
        typeof candidate.sessionId !== "string" ||
        typeof candidate.cwd !== "string" ||
        (candidate.title !== undefined &&
          typeof candidate.title !== "string") ||
        (candidate.updatedAt !== undefined &&
          typeof candidate.updatedAt !== "string")
      ) {
        throw new TypeError("Mischief Host returned invalid Agent history");
      }
      return {
        cwd: candidate.cwd,
        ...(isRecord(candidate.meta)
          ? this.coordinator
              .extension(this.agentId)
              ?.sessionPreview?.(candidate.meta)
          : {}),
        sessionId: candidate.sessionId,
        ...(candidate.title === undefined ? {} : { title: candidate.title }),
        ...(candidate.updatedAt === undefined
          ? {}
          : { updatedAt: candidate.updatedAt }),
      };
    });
  }

  async forkMessage(): Promise<never> {
    this.requireActive();
    return await unsupported("message forking");
  }

  async navigateTreeMessage(): Promise<never> {
    this.requireActive();
    return await unsupported("message tree navigation");
  }

  async setConfig(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    this.requireSession(sessionId);
    await this.coordinator.transport.request("threadSetConfig", {
      configId,
      threadId: this.threadId,
      value,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.coordinator.remove(this);
  }

  private assign(thread: HostThread): void {
    if (thread.agentId !== this.agentId) {
      throw new Error("Mischief Host returned a Thread for another Agent");
    }
    if (thread.sessionId === undefined) {
      throw new Error(thread.error ?? "Mischief Host did not create a session");
    }
    this.threadId = thread.id;
    this.coordinator.remember(thread);
    this.coordinator.attached(this);
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new Error("Mischief Host connection is closed");
    }
  }

  private requireSession(sessionId: string): void {
    this.requireActive();
    if (this.threadId === undefined) {
      throw new Error("Mischief Host Thread is not loaded");
    }
    const thread = this.coordinator.threadFor(this.agentId, sessionId);
    if (thread.id !== this.threadId) {
      throw new Error("Mischief Host session does not match this Thread");
    }
  }
}

export const hostConnectionFactory = (
  transport: HostTransport,
  extension?: (agentId: AgentId) => AcpExtension | undefined
): AgentConnectionFactory => {
  const coordinator = new HostAgentCoordinator(transport, extension);
  return (handlers, agentId) => coordinator.connection(handlers, agentId);
};
