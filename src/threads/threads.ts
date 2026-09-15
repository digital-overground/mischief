import { randomUUID } from "node:crypto";

import type {
  DatabaseThread,
  ProfileDatabase,
  ProfileDatabaseChange,
} from "../profile-database/profile-database";
import { archiveCompletedPlan, reduceTranscript } from "./transcript";

const STREAMING_IDLE_MS = 300;

export interface ThreadConfigChoice {
  value: string;
  name: string;
  description?: string;
}

export interface ThreadConfigGroup {
  name: string;
  options: ThreadConfigChoice[];
}

export type ThreadConfigOption =
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "select";
      currentValue: string;
      options: (ThreadConfigChoice | ThreadConfigGroup)[];
    }
  | {
      id: string;
      name: string;
      description?: string;
      category?: string;
      type: "boolean";
      currentValue: boolean;
    };

export interface AgentSession {
  sessionId: string;
  configOptions: ThreadConfigOption[];
}

export interface AgentPromptResult {
  stopReason: "completed" | "cancelled";
}

export interface PromptImage {
  data: string;
  mimeType: string;
}

export interface AgentPermissionRequest {
  message: string;
  options: { id: string; name: string; kind: string }[];
}

export type AgentPermissionResponse =
  | { optionId: string }
  | { cancelled: true };

export interface AgentElicitationRequest {
  message: string;
  context?: string;
  fields: ElicitationField[];
}

export type AgentElicitationResponse =
  | { action: "accept"; values: Record<string, unknown> }
  | { action: "cancel" };

export type AgentToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface AgentToolUpdate {
  toolCallId: string;
  toolKind?: AgentToolKind;
  title?: string;
  status?: string;
  input?: string;
  output?: string;
  terminalOutput?: string;
  locations?: { path: string; line?: number }[];
  diffs?: { path: string; oldText?: string; newText: string }[];
}

export interface ThreadCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export type AgentUpdate =
  | {
      type: "message";
      kind: "user" | "assistant" | "thought";
      text?: string;
      images?: PromptImage[];
      messageId?: string;
    }
  | ({ type: "tool" } & AgentToolUpdate)
  | {
      type: "plan";
      text: string;
      allCompleted: boolean;
      entries: PlanEntry[];
    }
  | { type: "usage"; usage: ThreadUsage }
  | { type: "commands"; commands: ThreadCommand[] }
  | { type: "config"; options: ThreadConfigOption[] }
  | { type: "sessionInfo"; title?: string; updatedAt?: string };

export interface AgentError extends Error {
  readonly authentication?: TerminalAuthentication;
}

export interface AgentHandlers {
  error: (error: AgentError) => void;
  elicitation: (
    request: AgentElicitationRequest
  ) => Promise<AgentElicitationResponse>;
  permission: (
    request: AgentPermissionRequest
  ) => Promise<AgentPermissionResponse>;
  update: (update: AgentUpdate) => void;
}

export interface AgentConnection {
  cancel: (sessionId: string) => Promise<void>;
  create: (cwd: string) => Promise<AgentSession>;
  dispose: () => void;
  fork: (
    sessionId: string,
    cwd: string,
    messageId: string
  ) => Promise<AgentSession>;
  load: (sessionId: string, cwd: string) => Promise<AgentSession>;
  prompt: (
    sessionId: string,
    text: string,
    messageId: string,
    images: PromptImage[]
  ) => Promise<AgentPromptResult>;
  rollback: (sessionId: string, messageId: string) => Promise<void>;
  setConfig: (
    sessionId: string,
    configId: string,
    value: string | boolean
  ) => Promise<void>;
}

const indicatorFor = (
  status: ThreadStatus,
  unread: boolean
): ThreadIndicator => {
  if (status === "running") {
    return "active";
  }
  if (status === "waiting") {
    return "waiting";
  }
  if (status === "error") {
    return "error";
  }
  return unread ? "completed" : "idle";
};

const indicatorNeedsAttention = (indicator: ThreadIndicator): boolean =>
  indicator === "waiting" || indicator === "completed" || indicator === "error";

export type AgentConnectionFactory = (
  handlers: AgentHandlers
) => AgentConnection;

export interface PlanEntry {
  content: string;
  status: string;
}

export type ThreadStatus = "idle" | "running" | "waiting" | "error";
export type ThreadIndicator =
  | "active"
  | "waiting"
  | "completed"
  | "idle"
  | "error";

export interface TranscriptItem {
  id: string;
  kind:
    | "user"
    | "assistant"
    | "thought"
    | "tool"
    | "plan"
    | "completedPlan"
    | "system";
  text?: string;
  allCompleted?: boolean;
  planEntries?: PlanEntry[];
  images?: PromptImage[];
  title?: string;
  status?: string;
  toolKind?: AgentToolKind;
  input?: string;
  output?: string;
  locations?: { path: string; line?: number }[];
  diffs?: { path: string; oldText?: string; newText: string }[];
  queued?: number;
  cancelled?: boolean;
}

export interface ThreadSummary {
  id: string;
  workspace: string;
  name: string;
  status: ThreadStatus;
  indicator: ThreadIndicator;
  needsAttention: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ElicitationField {
  name: string;
  label: string;
  description?: string;
  type: "text" | "number" | "boolean" | "select" | "multiselect";
  required: boolean;
  defaultValue?: string | number | boolean | string[];
  options?: { value: string; name: string; description?: string }[];
}

export type ThreadInteraction =
  | {
      id: string;
      kind: "permission";
      message: string;
      options: { id: string; name: string; kind: string }[];
    }
  | {
      id: string;
      kind: "elicitation";
      message: string;
      context?: string;
      fields: ElicitationField[];
    };

export type ThreadInteractionResponse =
  | { action: "select"; optionId: string }
  | { action: "accept"; values: Record<string, unknown> }
  | { action: "cancel" };

export interface TerminalAuthentication {
  command: string;
  args: string[];
  env?: Record<string, string>;
  label: string;
}

export interface ThreadUsage {
  used: number;
  size: number;
}

export interface SteeringMessage {
  id: string;
  text: string;
}

const agentAuthentication = (
  error: unknown
): TerminalAuthentication | undefined =>
  error instanceof Error ? (error as AgentError).authentication : undefined;

export interface ThreadDetail {
  id: string | null;
  name: string;
  status: ThreadStatus;
  streaming: boolean;
  usage?: ThreadUsage;
  items: TranscriptItem[];
  commands: ThreadCommand[];
  configOptions: ThreadConfigOption[];
  interaction?: ThreadInteraction;
  authentication?: TerminalAuthentication;
  error?: string;
  drafts: string[];
  steering: SteeringMessage[];
}

export interface ThreadsSnapshot {
  workspace?: string;
  threads: ThreadSummary[];
  selected?: ThreadDetail;
}

export interface ThreadsChange {
  type: "transcript";
  threadId: string;
  item: TranscriptItem;
  streaming: boolean;
}

interface StoredThread {
  id: string;
  workspace: string;
  sessionId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: ThreadStatus;
  error?: string;
  retryText?: string;
  authentication?: TerminalAuthentication;
  manualName?: boolean;
  unread?: boolean;
  usage?: ThreadUsage;
}

interface Runtime {
  connection: AgentConnection;
  status: ThreadStatus;
  streaming: boolean;
  usage?: ThreadUsage;
  streamingTimer?: ReturnType<typeof setTimeout>;
  items: TranscriptItem[];
  commands: ThreadCommand[];
  configOptions: ThreadConfigOption[];
  drafts: string[];
  pending: { id: string; text: string; images: PromptImage[] }[];
  retryImages?: PromptImage[];
  setup?: Promise<string>;
  registration?: PromiseLike<void>;
  interaction?: ThreadInteraction;
  resolvePermission?: (response: AgentPermissionResponse) => void;
  resolveElicitation?: (response: AgentElicitationResponse) => void;
}

const threadUsage = (
  record: StoredThread,
  runtime?: Runtime
): { usage?: ThreadUsage } => {
  const usage = runtime?.usage ?? record.usage;
  return usage ? { usage } : {};
};

const hasPromptContent = (text: string, images: PromptImage[]): boolean =>
  Boolean(text.trim() || images.length);

const agentMessageId = (messageId: string): string =>
  messageId.startsWith("user:") ? messageId.slice(5) : messageId;

const stopStreaming = (runtime: Runtime): void => {
  if (runtime.streamingTimer) {
    clearTimeout(runtime.streamingTimer);
    runtime.streamingTimer = undefined;
  }
  runtime.streaming = false;
};

// These helpers are assigned after the class declaration.
// oxlint-disable prefer-const
let errorMessage: (error: unknown) => string;
let updateQueue: (runtime: Runtime) => void;
// oxlint-enable prefer-const

export class Threads {
  private readonly createConnection: AgentConnectionFactory;
  private readonly database: ProfileDatabase;
  private stored: StoredThread[];
  private persistence = Promise.resolve();
  private selectionSync = Promise.resolve();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<(change?: ThreadsChange) => void>();
  private readonly stopDatabaseListener: () => void;
  private workspace?: string;
  private selectedId?: string;
  private viewedId?: string;
  private draft = false;

  constructor(
    database: ProfileDatabase,
    createConnection: AgentConnectionFactory
  ) {
    this.createConnection = createConnection;
    this.database = database;
    this.stored = database.snapshot().threads.map(Threads.copyRecord);
    this.stopDatabaseListener = database.onChange(() => {
      const current = this.workspace;
      this.stored = [
        ...this.stored.filter((record) => record.workspace === current),
        ...database
          .snapshot()
          .threads.filter((record) => record.workspace !== current)
          .map(Threads.copyRecord),
      ];
      this.queueSelectionSync();
      this.emit();
    });
  }

  async openWorkspace(workspace: string): Promise<ThreadsSnapshot> {
    this.workspace = workspace;
    this.viewedId = undefined;
    this.stored = this.database.snapshot().threads.map(Threads.copyRecord);
    const records = this.records();
    const stopped = records.filter(
      (record) => record.status === "running" || record.status === "waiting"
    );
    for (const record of stopped) {
      record.status = "idle";
    }
    await Promise.all(stopped.map((record) => this.persist(record)));
    const selected = this.database
      .snapshot()
      .selections.find(
        (selection) => selection.workspace === workspace
      )?.threadId;
    this.selectedId = records.some((record) => record.id === selected)
      ? selected
      : records[0]?.id;
    this.draft = !this.selectedId;
    if (this.selectedId) {
      await this.load(this.requireRecord(this.selectedId));
    }
    this.emit();
    return this.snapshot();
  }

  onChange(listener: (change?: ThreadsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async newThread(): Promise<void> {
    if (!this.workspace) {
      return;
    }
    const now = new Date().toISOString();
    const record: StoredThread = {
      createdAt: now,
      id: randomUUID(),
      name: "New Thread",
      status: "idle",
      updatedAt: now,
      workspace: this.workspace,
    };
    this.stored.unshift(record);
    this.selectedId = record.id;
    this.viewedId = record.id;
    record.unread = false;
    this.draft = false;
    await this.register(record);
    this.emit();
    await this.createSession(record, this.runtime(record));
  }

  async select(id: string): Promise<string | undefined> {
    await this.selectionSync;
    const record = this.findRecord(id);
    if (!record) {
      return undefined;
    }
    if (record.workspace !== this.workspace) {
      await this.selectThread(record.workspace, id);
      return record.workspace;
    }
    this.selectedId = id;
    this.viewedId = id;
    record.unread = false;
    this.draft = false;
    await this.persist(record);
    await this.selectThread(record.workspace, id);
    this.emit();
    await this.load(record);
    return record.workspace;
  }

  async remove(id: string): Promise<void> {
    const record = this.findRecord(id);
    if (!record || record.workspace !== this.workspace) {
      return;
    }
    if (this.selectedId === id) {
      await this.cancel();
      this.viewedId = undefined;
    }
    this.runtimes.get(id)?.connection.dispose();
    this.runtimes.delete(id);
    this.stored = this.stored.filter((thread) => thread.id !== id);
    await this.apply({ id, type: "removeThread" });

    if (this.selectedId === id) {
      const [next] = this.records();
      this.selectedId = next?.id;
      this.viewedId = next?.id;
      this.draft = !next;
      await this.selectThread(record.workspace, next?.id);
      if (next) {
        await this.load(next);
      }
    }
    this.emit();
  }

  async rename(id: string, name: string): Promise<void> {
    const record = this.findRecord(id);
    const title = name.trim();
    if (!record || record.workspace !== this.workspace || !title) {
      return;
    }
    if (title.length > 200 || /[\r\n]/u.test(title)) {
      throw new Error("Invalid Thread name");
    }
    record.name = title;
    record.manualName = true;
    await this.persist(record);
    this.emit();
  }

  clearPlan(): void {
    const runtime = this.selectedId
      ? this.runtimes.get(this.selectedId)
      : undefined;
    if (!runtime?.items.some((item) => item.kind === "plan")) {
      return;
    }
    runtime.items = runtime.items.filter((item) => item.kind !== "plan");
    this.emit();
  }

  clearSteering(): void {
    const runtime = this.selectedRuntime();
    if (!runtime || runtime.pending.length < 2) {
      return;
    }
    const queued = new Set(runtime.pending.splice(1).map((item) => item.id));
    runtime.items = runtime.items.filter((item) => !queued.has(item.id));
    this.emit();
  }

  removeSteering(id: string): void {
    const runtime = this.selectedRuntime();
    const index = runtime?.pending.findIndex((item) => item.id === id) ?? -1;
    if (!runtime || index < 1) {
      return;
    }
    runtime.pending.splice(index, 1);
    runtime.items = runtime.items.filter((item) => item.id !== id);
    updateQueue(runtime);
    this.emit();
  }

  async sendSteering(id: string): Promise<void> {
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    const index = runtime?.pending.findIndex((item) => item.id === id) ?? -1;
    if (!record?.sessionId || !runtime || index < 1) {
      return;
    }
    const [message] = runtime.pending.splice(index, 1);
    runtime.pending.splice(1, 0, message);
    updateQueue(runtime);
    await runtime.connection.cancel(record.sessionId);
  }

  async prompt(text: string, images: PromptImage[] = []): Promise<void> {
    const message = text;
    if (!hasPromptContent(message, images) || !this.workspace) {
      return;
    }

    let registration: PromiseLike<void> | undefined;
    let record = this.selectedId
      ? this.requireRecord(this.selectedId)
      : undefined;
    if (!record) {
      const now = new Date().toISOString();
      record = {
        createdAt: now,
        id: randomUUID(),
        name: "New Thread",
        retryText: message,
        status: "idle",
        updatedAt: now,
        workspace: this.workspace,
      };
      this.stored.unshift(record);
      this.selectedId = record.id;
      this.draft = false;
      registration = this.register(record);
    }

    this.viewedId = record.id;
    record.unread = false;
    const runtime = this.runtime(record);
    if (registration) {
      runtime.registration = registration;
    }
    const messageId = randomUUID();
    const item: TranscriptItem = {
      id: messageId,
      kind: "user",
      text: message || "Pasted image",
      ...(images.length ? { images } : {}),
      ...(runtime.pending.length ? { queued: runtime.pending.length } : {}),
    };
    runtime.items.push(item);
    runtime.pending.push({ id: messageId, images, text: message });
    runtime.status = "running";
    record.error = undefined;
    record.authentication = undefined;
    record.updatedAt = new Date().toISOString();
    void this.persist(record);
    this.emit();

    if (runtime.pending.length === 1) {
      await this.runPrompt(record, runtime, item);
    }
  }

  private async runPrompt(
    record: StoredThread,
    runtime: Runtime,
    item: TranscriptItem
  ): Promise<void> {
    const pending = runtime.pending.find((message) => message.id === item.id);
    if (!pending) {
      return;
    }
    let completed = false;
    try {
      await runtime.registration;
      runtime.registration = undefined;
      if (!record.sessionId) {
        await this.createSession(record, runtime);
      }
      if (!record.sessionId) {
        throw new Error(record.error ?? "Agent unavailable");
      }
      const result = await runtime.connection.prompt(
        record.sessionId,
        pending.text,
        pending.id,
        pending.images
      );
      if (result.stopReason === "cancelled") {
        item.cancelled = true;
      } else {
        archiveCompletedPlan(runtime.items);
        completed = true;
      }
      record.retryText = undefined;
      runtime.retryImages = undefined;
      record.authentication = undefined;
      record.updatedAt = new Date().toISOString();
    } catch (error) {
      runtime.registration = undefined;
      runtime.status = "error";
      record.error = errorMessage(error);
      record.retryText = pending.text;
      runtime.retryImages = pending.images;
      record.authentication =
        agentAuthentication(error) ?? record.authentication;
    } finally {
      runtime.pending = runtime.pending.filter(
        (message) => message.id !== pending.id
      );
      updateQueue(runtime);
      if (runtime.status !== "error" && !runtime.interaction) {
        runtime.status = runtime.pending.length ? "running" : "idle";
      }
      if (runtime.status !== "running") {
        stopStreaming(runtime);
      }
      if (completed && runtime.status === "idle" && !runtime.interaction) {
        record.unread = this.viewedId !== record.id;
      }
    }
    await this.persist(record);
    this.emit();
    const [next] = runtime.pending;
    const nextItem = next
      ? runtime.items.find((candidate) => candidate.id === next.id)
      : undefined;
    if (runtime.status === "running" && nextItem) {
      void this.runPrompt(record, runtime, nextItem);
    }
  }

  async retry(): Promise<void> {
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    if (!record) {
      return;
    }
    if (record.retryText !== undefined) {
      const runtime = this.runtimes.get(record.id);
      if (!record.sessionId && runtime) {
        runtime.items = [];
      }
      await this.prompt(record.retryText, runtime?.retryImages);
      return;
    }
    if (!record.sessionId) {
      await this.createSession(record, this.runtime(record));
      return;
    }
    this.runtimes.get(record.id)?.connection.dispose();
    this.runtimes.delete(record.id);
    record.error = undefined;
    record.authentication = undefined;
    await this.load(record);
    this.emit();
  }

  async setConfig(configId: string, value: string | boolean): Promise<void> {
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    if (!record?.sessionId || !runtime) {
      return;
    }
    const option = runtime.configOptions.find(
      (candidate) => candidate.id === configId
    );
    if (!option) {
      throw new Error(`Unknown Thread configuration: ${configId}`);
    }
    if (option.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new TypeError(`Invalid value for ${configId}`);
      }
    } else {
      const values = option.options.flatMap((candidate) =>
        "value" in candidate
          ? [candidate.value]
          : candidate.options.map((item) => item.value)
      );
      if (typeof value !== "string" || !values.includes(value)) {
        throw new Error(`Invalid value for ${configId}`);
      }
    }
    await runtime.connection.setConfig(record.sessionId, configId, value);
    option.currentValue = value;
    this.emit();
  }

  respond(id: string, response: ThreadInteractionResponse): void {
    const active = [...this.runtimes.entries()].find(
      ([, runtime]) => runtime.interaction?.id === id
    );
    const runtime = active?.[1];
    const record = active ? this.findRecord(active[0]) : undefined;
    if (!runtime?.interaction || !record) {
      return;
    }

    if (
      runtime.interaction.kind === "permission" &&
      runtime.resolvePermission
    ) {
      const selected =
        response.action === "select" &&
        runtime.interaction.options.some(
          (option) => option.id === response.optionId
        )
          ? { optionId: response.optionId }
          : { cancelled: true as const };
      const resolve = runtime.resolvePermission;
      runtime.resolvePermission = undefined;
      runtime.interaction = undefined;
      stopStreaming(runtime);
      runtime.status = "running";
      void this.persist(record);
      this.emit();
      resolve(selected);
      return;
    }

    if (
      runtime.interaction.kind === "elicitation" &&
      runtime.resolveElicitation
    ) {
      const result: AgentElicitationResponse =
        response.action === "accept"
          ? { action: "accept", values: response.values }
          : { action: "cancel" };
      const resolve = runtime.resolveElicitation;
      runtime.resolveElicitation = undefined;
      runtime.interaction = undefined;
      stopStreaming(runtime);
      runtime.status = "running";
      void this.persist(record);
      this.emit();
      resolve(result);
    }
  }

  async cancel(): Promise<void> {
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    if (!record || !runtime) {
      return;
    }
    await Threads.cancelRuntime(record, runtime);
    await this.persist(record);
    this.emit();
  }

  async fork(messageId: string): Promise<void> {
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    const message = runtime?.items.find(
      (item) => item.id === messageId && item.kind === "user"
    );
    if (!record?.sessionId || !runtime || !message || !this.workspace) {
      return;
    }
    if (runtime.status !== "idle") {
      throw new Error("Wait for the current turn to finish before forking");
    }

    const setup = await runtime.connection.fork(
      record.sessionId,
      record.workspace,
      agentMessageId(messageId)
    );
    const now = new Date().toISOString();
    const fork: StoredThread = {
      createdAt: now,
      id: randomUUID(),
      name: `${record.name} (fork)`,
      sessionId: setup.sessionId,
      status: "idle",
      updatedAt: now,
      workspace: record.workspace,
    };
    this.stored.unshift(fork);
    this.selectedId = fork.id;
    this.viewedId = fork.id;
    await this.register(fork);
    await this.load(fork);
    const forkRuntime = this.runtimes.get(fork.id);
    if (forkRuntime && message.text) {
      forkRuntime.drafts.push(message.text);
    }
    this.emit();
  }

  async rollback(messageId: string): Promise<void> {
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    const message = runtime?.items.find(
      (item) => item.id === messageId && item.kind === "user"
    );
    if (!record?.sessionId || !runtime || !message) {
      return;
    }
    if (runtime.status !== "idle") {
      await Threads.cancelRuntime(record, runtime);
    }
    await runtime.connection.rollback(
      record.sessionId,
      agentMessageId(messageId)
    );
    runtime.items = runtime.items.slice(0, runtime.items.indexOf(message));
    if (message.text) {
      runtime.drafts.push(message.text);
    }
    record.error = undefined;
    record.authentication = undefined;
    await this.persist(record);
    this.emit();
  }

  async closeWorkspace(): Promise<void> {
    if (!this.workspace) {
      return;
    }
    const records = this.records();
    await Promise.all(
      records.map(async (record) => {
        const runtime = this.runtimes.get(record.id);
        if (!runtime) {
          return;
        }
        await Threads.cancelRuntime(record, runtime);
        await this.persist(record);
        runtime.connection.dispose();
        this.runtimes.delete(record.id);
      })
    );
    this.workspace = undefined;
    this.selectedId = undefined;
    this.viewedId = undefined;
    this.draft = false;
    this.emit();
  }

  markViewed(): void {
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    if (!record) {
      return;
    }
    this.viewedId = record.id;
    if (!record.unread) {
      return;
    }
    record.unread = false;
    void this.persist(record);
    this.emit();
  }

  markHidden(): void {
    this.viewedId = undefined;
  }

  consumeDrafts(): void {
    const runtime = this.selectedId
      ? this.runtimes.get(this.selectedId)
      : undefined;
    if (!runtime?.drafts.length) {
      return;
    }
    runtime.drafts = [];
    this.emit();
  }

  snapshot(): ThreadsSnapshot {
    const threads = this.stored
      .toSorted(
        (left, right) =>
          left.workspace.localeCompare(right.workspace) ||
          right.createdAt.localeCompare(left.createdAt)
      )
      .map((record) => {
        const status = this.runtimes.get(record.id)?.status ?? record.status;
        const indicator = indicatorFor(status, Boolean(record.unread));
        return {
          createdAt: record.createdAt,
          id: record.id,
          indicator,
          name: record.name,
          needsAttention: indicatorNeedsAttention(indicator),
          status,
          updatedAt: record.updatedAt,
          workspace: record.workspace,
        };
      });
    const selected = this.selectedDetail();
    return {
      ...(this.workspace ? { workspace: this.workspace } : {}),
      ...(selected ? { selected } : {}),
      threads,
    };
  }

  // oxlint-disable-next-line complexity -- snapshot assembles optional Thread state
  private selectedDetail(): ThreadDetail | undefined {
    if (!this.workspace) {
      return undefined;
    }
    const record = this.selectedId
      ? this.findRecord(this.selectedId)
      : undefined;
    if (this.draft || !record) {
      return {
        commands: [],
        configOptions: [],
        drafts: [],
        id: null,
        items: [],
        name: "New Thread",
        status: "idle",
        steering: [],
        streaming: false,
      };
    }
    const runtime = this.runtimes.get(record.id);
    const items =
      runtime?.items ??
      (record.retryText
        ? [
            {
              id: `retry:${record.id}`,
              kind: "user" as const,
              text: record.retryText,
            },
          ]
        : []);
    return {
      ...(record.authentication
        ? { authentication: record.authentication }
        : {}),
      ...threadUsage(record, runtime),
      commands: runtime?.commands ?? [],
      configOptions: runtime?.configOptions ?? [],
      ...(record.error ? { error: record.error } : {}),
      drafts: runtime?.drafts ?? [],
      id: record.id,
      ...(runtime?.interaction ? { interaction: runtime.interaction } : {}),
      items,
      name: record.name,
      status: runtime?.status ?? record.status,
      steering:
        runtime?.pending.slice(1).map(({ id, text }) => ({ id, text })) ?? [],
      streaming: Boolean(runtime?.streaming),
    };
  }

  async dispose(): Promise<void> {
    this.stopDatabaseListener();
    await this.closeWorkspace();
    await this.persistence;
    await this.selectionSync;
    this.listeners.clear();
  }

  private markStreaming(runtime: Runtime, text: string): void {
    if (!text) {
      return;
    }
    runtime.streaming = true;
    if (runtime.streamingTimer) {
      clearTimeout(runtime.streamingTimer);
    }
    runtime.streamingTimer = setTimeout(() => {
      runtime.streamingTimer = undefined;
      runtime.streaming = false;
      this.emit();
    }, STREAMING_IDLE_MS);
  }

  private static async cancelRuntime(
    record: StoredThread,
    runtime: Runtime
  ): Promise<void> {
    stopStreaming(runtime);
    runtime.resolvePermission?.({ cancelled: true });
    runtime.resolveElicitation?.({ action: "cancel" });
    runtime.resolvePermission = undefined;
    runtime.resolveElicitation = undefined;
    runtime.interaction = undefined;

    const [active, ...queued] = runtime.pending;
    runtime.drafts.push(...queued.map((prompt) => prompt.text));
    const queuedIds = new Set(queued.map((prompt) => prompt.id));
    runtime.items = runtime.items.filter((item) => !queuedIds.has(item.id));
    runtime.pending = active ? [active] : [];
    const activeItem =
      active && runtime.items.find((item) => item.id === active.id);
    if (activeItem) {
      activeItem.cancelled = true;
    }
    if (record.sessionId) {
      await runtime.connection.cancel(record.sessionId);
    }
    runtime.status = "idle";
  }

  private async createSession(
    record: StoredThread,
    runtime: Runtime
  ): Promise<void> {
    try {
      runtime.setup ??= (async () => {
        const setup = await runtime.connection.create(record.workspace);
        runtime.configOptions = setup.configOptions ?? [];
        this.emit();
        return setup.sessionId;
      })();
      record.sessionId = await runtime.setup;
      record.error = undefined;
      record.authentication = undefined;
      if (!runtime.pending.length && !runtime.interaction) {
        runtime.status = "idle";
      }
    } catch (error) {
      stopStreaming(runtime);
      runtime.status = "error";
      record.error = errorMessage(error);
      record.authentication = agentAuthentication(error);
    } finally {
      runtime.setup = undefined;
    }
    await this.persist(record);
    this.emit();
  }

  private async load(record: StoredThread): Promise<void> {
    if (!record.sessionId || this.runtimes.has(record.id)) {
      return;
    }
    const runtime = this.runtime(record);
    try {
      const setup = await runtime.connection.load(
        record.sessionId,
        record.workspace
      );
      runtime.configOptions = setup.configOptions ?? [];
      stopStreaming(runtime);
      runtime.status = "idle";
      record.error = undefined;
      record.authentication = undefined;
    } catch (error) {
      stopStreaming(runtime);
      runtime.status = "error";
      record.error = errorMessage(error);
      record.authentication = agentAuthentication(error);
    }
    await this.persist(record);
    this.emit();
  }

  private runtime(record: StoredThread): Runtime {
    let runtime = this.runtimes.get(record.id);
    if (runtime) {
      return runtime;
    }
    runtime = {
      commands: [],
      configOptions: [],
      connection: this.createConnection({
        elicitation: (request) => this.handleElicitation(record, request),
        error: (error) => {
          record.error = errorMessage(error);
          record.authentication = error.authentication;
          const active = this.runtimes.get(record.id);
          if (active) {
            stopStreaming(active);
            active.status = "error";
          }
          void this.persist(record);
          this.emit();
        },
        permission: (request) => this.handlePermission(record, request),
        update: (update) => this.handleUpdate(record, update),
      }),
      drafts: [],
      items: [],
      pending: [],
      status: record.status,
      streaming: false,
    };
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  private handlePermission(
    record: StoredThread,
    request: AgentPermissionRequest
  ): Promise<AgentPermissionResponse> {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) {
      return Promise.resolve({ cancelled: true });
    }
    stopStreaming(runtime);
    runtime.status = "waiting";
    runtime.interaction = {
      id: randomUUID(),
      kind: "permission",
      message: request.message,
      options: request.options,
    };
    void this.persist(record);
    this.emit();
    // oxlint-disable-next-line promise/avoid-new
    return new Promise((resolve) => {
      runtime.resolvePermission = resolve;
    });
  }

  private handleElicitation(
    record: StoredThread,
    request: AgentElicitationRequest
  ): Promise<AgentElicitationResponse> {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) {
      return Promise.resolve({ action: "cancel" });
    }
    stopStreaming(runtime);
    runtime.status = "waiting";
    runtime.interaction = {
      ...(request.context ? { context: request.context } : {}),
      fields: request.fields,
      id: randomUUID(),
      kind: "elicitation",
      message: request.message,
    };
    void this.persist(record);
    this.emit();
    // oxlint-disable-next-line promise/avoid-new
    return new Promise((resolve) => {
      runtime.resolveElicitation = resolve;
    });
  }

  // oxlint-disable-next-line complexity -- routes each Agent update
  private handleUpdate(record: StoredThread, update: AgentUpdate): void {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) {
      return;
    }
    if (update.type === "message" && update.kind !== "user") {
      this.markStreaming(runtime, update.text ?? "");
    }
    const item = reduceTranscript(runtime.items, update);
    const archivedPlan =
      update.type === "plan" &&
      update.allCompleted &&
      runtime.status === "idle";
    if (archivedPlan) {
      archiveCompletedPlan(runtime.items);
    }
    if (update.type === "usage") {
      runtime.usage = update.usage;
      record.usage = update.usage;
      void this.persist(record);
    } else if (update.type === "commands") {
      runtime.commands = update.commands;
    } else if (update.type === "config") {
      runtime.configOptions = update.options;
    } else if (update.type === "sessionInfo") {
      const title = update.title?.trim();
      let changed = false;
      if (
        !record.manualName &&
        title &&
        title.length <= 200 &&
        !/[\r\n]/u.test(title)
      ) {
        record.name = title;
        changed = true;
      }
      if (
        update.updatedAt &&
        update.updatedAt.length <= 100 &&
        Number.isFinite(Date.parse(update.updatedAt))
      ) {
        record.updatedAt = update.updatedAt;
        changed = true;
      }
      if (changed) {
        void this.persist(record);
      }
    }
    this.emit(
      item && !archivedPlan
        ? {
            item: { ...item },
            streaming: runtime.streaming,
            threadId: record.id,
            type: "transcript",
          }
        : undefined
    );
  }

  private queueSelectionSync(): void {
    const previous = this.selectionSync;
    const operation = (async () => {
      await previous;
      const { workspace } = this;
      if (!workspace) {
        return;
      }
      const selected = this.database
        .snapshot()
        .selections.find(
          (selection) => selection.workspace === workspace
        )?.threadId;
      if (!selected || selected === this.selectedId) {
        return;
      }
      const record = this.findRecord(selected);
      if (!record || record.workspace !== workspace) {
        return;
      }
      this.selectedId = selected;
      this.viewedId = selected;
      this.draft = false;
      record.unread = false;
      await this.persist(record);
      await this.load(record);
      this.emit();
    })();
    this.selectionSync = (async () => {
      try {
        await operation;
      } catch {
        // Keep later selection updates available after one failed restore.
      }
    })();
  }

  private records(): StoredThread[] {
    return this.stored
      .filter((record) => record.workspace === this.workspace)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private findRecord(id: string): StoredThread | undefined {
    return this.stored.find((record) => record.id === id);
  }

  private selectedRuntime(): Runtime | undefined {
    return this.selectedId ? this.runtimes.get(this.selectedId) : undefined;
  }

  private requireRecord(id: string): StoredThread {
    const record = this.findRecord(id);
    if (!record) {
      throw new Error(`Unknown Thread: ${id}`);
    }
    return record;
  }

  private static copyRecord(record: DatabaseThread): StoredThread {
    return {
      ...record,
      ...(record.authentication
        ? {
            authentication: {
              ...record.authentication,
              args: [...record.authentication.args],
              ...(record.authentication.env
                ? { env: { ...record.authentication.env } }
                : {}),
            },
          }
        : {}),
      ...(record.usage ? { usage: { ...record.usage } } : {}),
    };
  }

  private apply(change: ProfileDatabaseChange): Promise<void> {
    const previous = this.persistence;
    const operation = (async () => {
      await previous;
      await this.database.apply(change);
    })();
    this.persistence = (async () => {
      try {
        await operation;
      } catch {
        // Keep later independent writes available after one failed write.
      }
    })();
    return operation;
  }

  private persist(record: StoredThread): Promise<void> {
    if (!this.stored.includes(record)) {
      return Promise.resolve();
    }
    record.status = this.runtimes.get(record.id)?.status ?? record.status;
    return this.apply({
      thread: Threads.copyRecord(record),
      type: "putThread",
    });
  }

  private async register(record: StoredThread): Promise<void> {
    await this.persist(record);
    await this.selectThread(record.workspace, record.id);
  }

  private selectThread(workspace: string, threadId?: string): Promise<void> {
    return this.apply({
      ...(threadId ? { threadId } : {}),
      type: "selectThread",
      workspace,
    });
  }

  private emit(change?: ThreadsChange): void {
    for (const listener of this.listeners) {
      listener(change);
    }
  }
}

updateQueue = (runtime: Runtime): void => {
  for (const [index, pending] of runtime.pending.entries()) {
    const item = runtime.items.find((candidate) => candidate.id === pending.id);
    if (!item) {
      continue;
    }
    item.queued = index || undefined;
  }
};

errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
