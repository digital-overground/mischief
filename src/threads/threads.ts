import { randomUUID } from "node:crypto";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

const STORAGE_KEY = "mischief.threads";

export interface ThreadsStorage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface AgentHandlers {
  update(update: SessionUpdate): void;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  elicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  error(error: unknown): void;
}

export interface AgentConnection {
  create(cwd: string): Promise<NewSessionResponse>;
  load(sessionId: string, cwd: string): Promise<LoadSessionResponse>;
  prompt(sessionId: string, text: string, messageId: string): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  setConfig(sessionId: string, configId: string, value: string | boolean): Promise<void>;
  dispose(): void;
}

export type AgentConnectionFactory = (handlers: AgentHandlers) => AgentConnection;

export type ThreadStatus = "idle" | "running" | "waiting" | "error";

export interface TranscriptItem {
  id: string;
  kind: "user" | "assistant" | "thought" | "tool" | "plan" | "system";
  text?: string;
  title?: string;
  status?: string;
  input?: string;
  output?: string;
  locations?: Array<{ path: string; line?: number }>;
  diffs?: Array<{ path: string; oldText?: string; newText: string }>;
  queued?: number;
  cancelled?: boolean;
}

export interface ThreadSummary {
  id: string;
  name: string;
  status: ThreadStatus;
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
  options?: Array<{ value: string; name: string }>;
}

export type ThreadInteraction =
  | {
      id: string;
      kind: "permission";
      message: string;
      options: Array<{ id: string; name: string; kind: string }>;
    }
  | {
      id: string;
      kind: "elicitation";
      message: string;
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

export interface ThreadDetail {
  id: string | null;
  name: string;
  status: ThreadStatus;
  items: TranscriptItem[];
  configOptions: SessionConfigOption[];
  interaction?: ThreadInteraction;
  authentication?: TerminalAuthentication;
  error?: string;
  drafts: string[];
}

export interface ThreadsSnapshot {
  workspace?: string;
  threads: ThreadSummary[];
  selected?: ThreadDetail;
}

interface StoredThread {
  id: string;
  workspace: string;
  sessionId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  retryText?: string;
  authentication?: TerminalAuthentication;
  manualName?: boolean;
}

interface StoredThreads {
  threads: StoredThread[];
  selected: Record<string, string>;
}

interface Runtime {
  connection: AgentConnection;
  status: ThreadStatus;
  items: TranscriptItem[];
  configOptions: SessionConfigOption[];
  drafts: string[];
  pending: Array<{ id: string; text: string }>;
  setup?: Promise<string>;
  registration?: PromiseLike<void>;
  interaction?: ThreadInteraction;
  resolvePermission?: (response: RequestPermissionResponse) => void;
  elicitationRequest?: Extract<CreateElicitationRequest, { mode: "form" }>;
  resolveElicitation?: (response: CreateElicitationResponse) => void;
}

export class Threads {
  private readonly stored: StoredThreads;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<() => void>();
  private workspace?: string;
  private selectedId?: string;
  private draft = false;

  constructor(
    private readonly storage: ThreadsStorage,
    private readonly createConnection: AgentConnectionFactory,
  ) {
    this.stored = readStored(storage);
  }

  async openWorkspace(workspace: string): Promise<ThreadsSnapshot> {
    this.workspace = workspace;
    const records = this.records();
    const selected = this.stored.selected[workspace];
    this.selectedId = records.some((record) => record.id === selected) ? selected : records[0]?.id;
    this.draft = !this.selectedId;
    if (this.selectedId) await this.load(this.requireRecord(this.selectedId));
    this.emit();
    return this.snapshot();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  newThread(): void {
    if (!this.workspace) return;
    this.selectedId = undefined;
    this.draft = true;
    this.emit();
  }

  async select(id: string): Promise<void> {
    const record = this.findRecord(id);
    if (!record || record.workspace !== this.workspace) return;
    this.selectedId = id;
    this.draft = false;
    this.stored.selected[record.workspace] = id;
    await this.persist();
    this.emit();
    await this.load(record);
  }

  async remove(id: string): Promise<void> {
    const record = this.findRecord(id);
    if (!record || record.workspace !== this.workspace) return;
    if (this.selectedId === id) await this.cancel();
    this.runtimes.get(id)?.connection.dispose();
    this.runtimes.delete(id);
    this.stored.threads = this.stored.threads.filter((thread) => thread.id !== id);

    if (this.selectedId === id) {
      const next = this.records()[0];
      this.selectedId = next?.id;
      this.draft = !next;
      if (next) this.stored.selected[record.workspace] = next.id;
      else delete this.stored.selected[record.workspace];
      await this.persist();
      if (next) await this.load(next);
    } else {
      await this.persist();
    }
    this.emit();
  }

  async rename(id: string, name: string): Promise<void> {
    const record = this.findRecord(id);
    const title = name.trim();
    if (!record || record.workspace !== this.workspace || !title) return;
    if (title.length > 200 || /[\r\n]/.test(title)) throw new Error("Invalid Thread name");
    record.name = title;
    record.manualName = true;
    await this.persist();
    this.emit();
  }

  async prompt(text: string): Promise<void> {
    const message = text;
    if (!message.trim() || !this.workspace) return;

    let registration: PromiseLike<void> | undefined;
    let record = this.selectedId ? this.requireRecord(this.selectedId) : undefined;
    if (!record) {
      const now = new Date().toISOString();
      record = {
        id: randomUUID(),
        workspace: this.workspace,
        name: "New Thread",
        createdAt: now,
        updatedAt: now,
        retryText: message,
      };
      this.stored.threads.unshift(record);
      this.stored.selected[this.workspace] = record.id;
      this.selectedId = record.id;
      this.draft = false;
      registration = this.persist();
    }

    const runtime = this.runtime(record);
    if (registration) runtime.registration = registration;
    const messageId = randomUUID();
    const item: TranscriptItem = {
      id: messageId,
      kind: "user",
      text: message,
      ...(runtime.pending.length ? { queued: runtime.pending.length } : {}),
    };
    runtime.items.push(item);
    runtime.pending.push({ id: messageId, text: message });
    runtime.status = "running";
    record.error = undefined;
    record.authentication = undefined;
    record.updatedAt = new Date().toISOString();
    void this.persist();
    this.emit();

    try {
      await runtime.registration;
      runtime.registration = undefined;
      if (!record.sessionId) {
        runtime.setup ??= runtime.connection.create(record.workspace).then((setup) => {
          runtime.configOptions = setup.configOptions ?? [];
          this.emit();
          return setup.sessionId;
        });
        try {
          record.sessionId = await runtime.setup;
        } finally {
          runtime.setup = undefined;
        }
      }
      const result = await runtime.connection.prompt(record.sessionId, message, messageId);
      if (result.stopReason === "cancelled") item.cancelled = true;
      record.retryText = undefined;
      record.authentication = undefined;
      record.updatedAt = new Date().toISOString();
    } catch (error) {
      runtime.registration = undefined;
      runtime.status = "error";
      record.error = errorMessage(error);
      record.retryText = message;
      record.authentication = terminalAuthentication(error);
    } finally {
      runtime.pending = runtime.pending.filter((pending) => pending.id !== messageId);
      updateQueue(runtime);
      if (runtime.status !== "error" && !runtime.interaction) {
        runtime.status = runtime.pending.length ? "running" : "idle";
      }
    }
    await this.persist();
    this.emit();
  }

  async retry(): Promise<void> {
    const record = this.selectedId ? this.findRecord(this.selectedId) : undefined;
    if (!record) return;
    if (record.retryText) {
      if (!record.sessionId) {
        const runtime = this.runtimes.get(record.id);
        if (runtime) runtime.items = [];
      }
      await this.prompt(record.retryText);
      return;
    }
    if (!record.sessionId) return;
    this.runtimes.get(record.id)?.connection.dispose();
    this.runtimes.delete(record.id);
    record.error = undefined;
    record.authentication = undefined;
    await this.load(record);
    this.emit();
  }

  async setConfig(configId: string, value: string | boolean): Promise<void> {
    const record = this.selectedId ? this.findRecord(this.selectedId) : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    if (!record?.sessionId || !runtime) return;
    const option = runtime.configOptions.find((candidate) => candidate.id === configId);
    if (!option) throw new Error(`Unknown Thread configuration: ${configId}`);
    if (option.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`Invalid value for ${configId}`);
    } else {
      const values = option.options.flatMap((candidate) =>
        "value" in candidate ? [candidate.value] : candidate.options.map((item) => item.value),
      );
      if (typeof value !== "string" || !values.includes(value))
        throw new Error(`Invalid value for ${configId}`);
    }
    await runtime.connection.setConfig(record.sessionId, configId, value);
    option.currentValue = value;
    this.emit();
  }

  async respond(id: string, response: ThreadInteractionResponse): Promise<void> {
    const runtime = [...this.runtimes.values()].find((item) => item.interaction?.id === id);
    if (!runtime?.interaction) return;

    if (runtime.interaction.kind === "permission" && runtime.resolvePermission) {
      const selected =
        response.action === "select" &&
        runtime.interaction.options.some((option) => option.id === response.optionId)
          ? { outcome: { outcome: "selected" as const, optionId: response.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      const resolve = runtime.resolvePermission;
      runtime.resolvePermission = undefined;
      runtime.interaction = undefined;
      runtime.status = "running";
      this.emit();
      resolve(selected);
      return;
    }

    if (
      runtime.interaction.kind === "elicitation" &&
      runtime.resolveElicitation &&
      runtime.elicitationRequest
    ) {
      const result: CreateElicitationResponse =
        response.action === "accept"
          ? {
              action: "accept",
              content: elicitationContent(runtime.elicitationRequest, response.values),
            }
          : { action: "cancel" };
      const resolve = runtime.resolveElicitation;
      runtime.resolveElicitation = undefined;
      runtime.elicitationRequest = undefined;
      runtime.interaction = undefined;
      runtime.status = "running";
      this.emit();
      resolve(result);
    }
  }

  async cancel(): Promise<void> {
    const record = this.selectedId ? this.findRecord(this.selectedId) : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    if (!record || !runtime) return;
    await this.cancelRuntime(record, runtime);
    await this.persist();
    this.emit();
  }

  async closeWorkspace(): Promise<void> {
    if (!this.workspace) return;
    const records = this.records();
    await Promise.all(
      records.map(async (record) => {
        const runtime = this.runtimes.get(record.id);
        if (!runtime) return;
        await this.cancelRuntime(record, runtime);
        runtime.connection.dispose();
        this.runtimes.delete(record.id);
      }),
    );
    this.workspace = undefined;
    this.selectedId = undefined;
    this.draft = false;
    this.emit();
  }

  consumeDrafts(): void {
    const runtime = this.selectedId ? this.runtimes.get(this.selectedId) : undefined;
    if (!runtime?.drafts.length) return;
    runtime.drafts = [];
    this.emit();
  }

  snapshot(): ThreadsSnapshot {
    const threads = this.records().map((record) => ({
      id: record.id,
      name: record.name,
      status: this.runtimes.get(record.id)?.status ?? (record.error ? "error" : "idle"),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }));
    const record = this.selectedId ? this.findRecord(this.selectedId) : undefined;
    const runtime = record ? this.runtimes.get(record.id) : undefined;
    return {
      ...(this.workspace ? { workspace: this.workspace } : {}),
      threads,
      selected:
        this.draft || !record
          ? this.workspace
            ? {
                id: null,
                name: "New Thread",
                status: "idle",
                items: [],
                configOptions: [],
                drafts: [],
              }
            : undefined
          : {
              id: record.id,
              name: record.name,
              status: runtime?.status ?? (record.error ? "error" : "idle"),
              items:
                runtime?.items ??
                (record.retryText
                  ? [{ id: `retry:${record.id}`, kind: "user", text: record.retryText }]
                  : []),
              configOptions: runtime?.configOptions ?? [],
              ...(runtime?.interaction ? { interaction: runtime.interaction } : {}),
              ...(record.authentication ? { authentication: record.authentication } : {}),
              ...(record.error ? { error: record.error } : {}),
              drafts: runtime?.drafts ?? [],
            },
    };
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) runtime.connection.dispose();
    this.runtimes.clear();
    this.listeners.clear();
  }

  private async cancelRuntime(record: StoredThread, runtime: Runtime): Promise<void> {
    runtime.resolvePermission?.({ outcome: { outcome: "cancelled" } });
    runtime.resolveElicitation?.({ action: "cancel" });
    runtime.resolvePermission = undefined;
    runtime.resolveElicitation = undefined;
    runtime.elicitationRequest = undefined;
    runtime.interaction = undefined;

    const [active, ...queued] = runtime.pending;
    runtime.drafts.push(...queued.map((prompt) => prompt.text));
    const queuedIds = new Set(queued.map((prompt) => prompt.id));
    runtime.items = runtime.items.filter((item) => !queuedIds.has(item.id));
    runtime.pending = active ? [active] : [];
    const activeItem = active && runtime.items.find((item) => item.id === active.id);
    if (activeItem) activeItem.cancelled = true;
    if (record.sessionId) await runtime.connection.cancel(record.sessionId);
    runtime.status = "idle";
  }

  private async load(record: StoredThread): Promise<void> {
    if (!record.sessionId || this.runtimes.has(record.id)) return;
    const runtime = this.runtime(record);
    try {
      const setup = await runtime.connection.load(record.sessionId, record.workspace);
      runtime.configOptions = setup.configOptions ?? [];
      runtime.status = "idle";
      record.error = undefined;
      record.authentication = undefined;
      this.emit();
    } catch (error) {
      runtime.status = "error";
      record.error = errorMessage(error);
      record.authentication = terminalAuthentication(error);
      await this.persist();
      this.emit();
    }
  }

  private runtime(record: StoredThread): Runtime {
    let runtime = this.runtimes.get(record.id);
    if (runtime) return runtime;
    runtime = {
      connection: this.createConnection({
        update: (update) => this.handleUpdate(record, update),
        permission: (request) => this.handlePermission(record, request),
        elicitation: (request) => this.handleElicitation(record, request),
        error: (error) => {
          record.error = errorMessage(error);
          const active = this.runtimes.get(record.id);
          if (active) active.status = "error";
          void this.persist();
          this.emit();
        },
      }),
      status: record.error ? "error" : "idle",
      items: [],
      configOptions: [],
      drafts: [],
      pending: [],
    };
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  private handlePermission(
    record: StoredThread,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    runtime.status = "waiting";
    runtime.interaction = {
      id: randomUUID(),
      kind: "permission",
      message: request.toolCall.title ?? "Permission required",
      options: request.options.map((option) => ({
        id: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    };
    this.emit();
    return new Promise((resolve) => {
      runtime.resolvePermission = resolve;
    });
  }

  private handleElicitation(
    record: StoredThread,
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    const runtime = this.runtimes.get(record.id);
    if (!runtime || request.mode !== "form") return Promise.resolve({ action: "decline" });
    runtime.status = "waiting";
    runtime.interaction = {
      id: randomUUID(),
      kind: "elicitation",
      message: request.message,
      fields: elicitationFields(request),
    };
    runtime.elicitationRequest = request;
    this.emit();
    return new Promise((resolve) => {
      runtime.resolveElicitation = resolve;
    });
  }

  private handleUpdate(record: StoredThread, update: SessionUpdate): void {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) return;
    if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") {
      appendText(runtime.items, "user", update.content.text, update.messageId ?? undefined);
    } else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
      appendText(runtime.items, "assistant", update.content.text, update.messageId ?? undefined);
    } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
      appendText(runtime.items, "thought", update.content.text, update.messageId ?? undefined);
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      upsertTool(runtime.items, update);
    } else if (update.sessionUpdate === "plan") {
      upsertPlan(
        runtime.items,
        update.entries
          .map((entry) => `${entry.status === "completed" ? "✓" : "•"} ${entry.content}`)
          .join("\n"),
      );
    } else if (update.sessionUpdate === "config_option_update") {
      runtime.configOptions = update.configOptions;
    } else if (update.sessionUpdate === "session_info_update") {
      if (!record.manualName && update.title?.trim()) record.name = update.title.trim();
      if (update.updatedAt) record.updatedAt = update.updatedAt;
      void this.persist();
    }
    this.emit();
  }

  private records(): StoredThread[] {
    return this.stored.threads
      .filter((record) => record.workspace === this.workspace)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private findRecord(id: string): StoredThread | undefined {
    return this.stored.threads.find((record) => record.id === id);
  }

  private requireRecord(id: string): StoredThread {
    const record = this.findRecord(id);
    if (!record) throw new Error(`Unknown Thread: ${id}`);
    return record;
  }

  private persist(): PromiseLike<void> {
    return this.storage.update(STORAGE_KEY, this.stored);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function updateQueue(runtime: Runtime): void {
  runtime.pending.forEach((pending, index) => {
    const item = runtime.items.find((candidate) => candidate.id === pending.id);
    if (!item) return;
    if (index) item.queued = index;
    else item.queued = undefined;
  });
}

function appendText(
  items: TranscriptItem[],
  kind: "user" | "assistant" | "thought",
  text: string,
  messageId?: string,
): void {
  if (!text) return;
  const id = messageId ? `${kind}:${messageId}` : undefined;
  const existing = id ? items.find((item) => item.id === id) : items.at(-1);
  if (existing?.kind === kind) existing.text = (existing.text ?? "") + text;
  else items.push({ id: id ?? randomUUID(), kind, text });
}

function upsertTool(
  items: TranscriptItem[],
  update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): void {
  const id = `tool:${update.toolCallId}`;
  let item = items.find((candidate) => candidate.id === id);
  if (!item) {
    item = { id, kind: "tool" };
    items.push(item);
  }
  if (update.title !== undefined && update.title !== null) item.title = update.title;
  if (update.status !== undefined && update.status !== null) item.status = update.status;
  if (update.rawInput !== undefined) item.input = stringify(update.rawInput);
  if (update.rawOutput !== undefined) item.output = stringify(update.rawOutput);
  if (update.locations) {
    item.locations = update.locations.map((location) => ({
      path: location.path,
      ...(location.line !== undefined && location.line !== null ? { line: location.line } : {}),
    }));
  }
  if (update.content) {
    const diffs = update.content
      .filter((content) => content.type === "diff")
      .map((content) => ({
        path: content.path,
        ...(content.oldText !== undefined && content.oldText !== null
          ? { oldText: content.oldText }
          : {}),
        newText: content.newText,
      }));
    if (diffs.length) item.diffs = diffs;
    const text = update.content
      .filter((content) => content.type === "content" && content.content.type === "text")
      .map((content) =>
        content.type === "content" && content.content.type === "text" ? content.content.text : "",
      )
      .join("");
    if (text) item.output = text;
  }
  const terminalOutput = (
    update._meta as { terminal_output?: { data?: unknown } } | null | undefined
  )?.terminal_output?.data;
  if (typeof terminalOutput === "string") item.output = (item.output ?? "") + terminalOutput;
}

function upsertPlan(items: TranscriptItem[], text: string): void {
  const existing = items.find((item) => item.id === "plan");
  if (existing) existing.text = text;
  else items.push({ id: "plan", kind: "plan", title: "Plan", text });
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readStored(storage: ThreadsStorage): StoredThreads {
  const value = storage.get<Partial<StoredThreads>>(STORAGE_KEY, {});
  return {
    threads: Array.isArray(value.threads) ? value.threads : [],
    selected: value.selected && typeof value.selected === "object" ? value.selected : {},
  };
}

function elicitationFields(
  request: Extract<CreateElicitationRequest, { mode: "form" }>,
): ElicitationField[] {
  const required = new Set(request.requestedSchema.required ?? []);
  return Object.entries(request.requestedSchema.properties ?? {}).map(([name, schema]) => {
    const options = elicitationOptions(schema);
    const type =
      schema.type === "boolean"
        ? "boolean"
        : schema.type === "number" || schema.type === "integer"
          ? "number"
          : schema.type === "array"
            ? "multiselect"
            : options
              ? "select"
              : "text";
    return {
      name,
      label: schema.title ?? name,
      ...(schema.description ? { description: schema.description } : {}),
      type,
      required: required.has(name),
      ...(schema.default !== undefined && schema.default !== null
        ? { defaultValue: schema.default }
        : {}),
      ...(options ? { options } : {}),
    };
  });
}

function elicitationOptions(
  schema: ElicitationPropertySchema,
): Array<{ value: string; name: string }> | undefined {
  if (schema.type === "string") {
    if (schema.oneOf)
      return schema.oneOf.map((option) => ({ value: option.const, name: option.title }));
    if (schema.enum) return schema.enum.map((value) => ({ value, name: value }));
  }
  if (schema.type === "array") {
    if ("anyOf" in schema.items)
      return schema.items.anyOf.map((option) => ({ value: option.const, name: option.title }));
    return schema.items.enum.map((value) => ({ value, name: value }));
  }
  return undefined;
}

function elicitationContent(
  request: Extract<CreateElicitationRequest, { mode: "form" }>,
  values: Record<string, unknown>,
): Record<string, ElicitationContentValue> {
  const content: Record<string, ElicitationContentValue> = {};
  const required = new Set(request.requestedSchema.required ?? []);
  for (const [name, schema] of Object.entries(request.requestedSchema.properties ?? {})) {
    if (!Object.hasOwn(values, name)) {
      if (required.has(name)) throw new Error(`Missing required field: ${name}`);
      continue;
    }
    content[name] = elicitationValue(name, schema, values[name]);
  }
  return content;
}

function elicitationValue(
  name: string,
  schema: ElicitationPropertySchema,
  value: unknown,
): ElicitationContentValue {
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`Invalid value for ${name}`);
    const allowed = schema.oneOf?.map((option) => option.const) ?? schema.enum;
    if (allowed && !allowed.includes(value)) throw new Error(`Invalid option for ${name}`);
    if (
      schema.minLength !== undefined &&
      schema.minLength !== null &&
      value.length < schema.minLength
    )
      throw new Error(`${name} is too short`);
    if (
      schema.maxLength !== undefined &&
      schema.maxLength !== null &&
      value.length > schema.maxLength
    )
      throw new Error(`${name} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      throw new Error(`${name} has an invalid format`);
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Invalid value for ${name}`);
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const number = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(number) || (schema.type === "integer" && !Number.isInteger(number)))
      throw new Error(`Invalid number for ${name}`);
    if (schema.minimum !== undefined && schema.minimum !== null && number < schema.minimum)
      throw new Error(`${name} is too small`);
    if (schema.maximum !== undefined && schema.maximum !== null && number > schema.maximum)
      throw new Error(`${name} is too large`);
    return number;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`Invalid choices for ${name}`);
  const allowed = elicitationOptions(schema)?.map((option) => option.value) ?? [];
  if (value.some((item) => !allowed.includes(item))) throw new Error(`Invalid choices for ${name}`);
  if (schema.minItems !== undefined && schema.minItems !== null && value.length < schema.minItems)
    throw new Error(`Select more choices for ${name}`);
  if (schema.maxItems !== undefined && schema.maxItems !== null && value.length > schema.maxItems)
    throw new Error(`Select fewer choices for ${name}`);
  return value;
}

function terminalAuthentication(error: unknown): TerminalAuthentication | undefined {
  const data = (error as { data?: unknown } | null)?.data as
    | { authMethods?: unknown }
    | null
    | undefined;
  if (!Array.isArray(data?.authMethods)) return undefined;
  for (const method of data.authMethods) {
    if (!method || typeof method !== "object") continue;
    const record = method as Record<string, unknown>;
    const meta = record._meta as Record<string, unknown> | null | undefined;
    const launch = meta?.["terminal-auth"] as Record<string, unknown> | null | undefined;
    if (typeof launch?.command !== "string" || !Array.isArray(launch.args)) continue;
    if (!launch.args.every((argument) => typeof argument === "string")) continue;
    const rawEnv = launch.env;
    const env =
      rawEnv && typeof rawEnv === "object"
        ? Object.fromEntries(
            Object.entries(rawEnv).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    return {
      command: launch.command,
      args: launch.args as string[],
      ...(env && Object.keys(env).length ? { env } : {}),
      label:
        typeof launch.label === "string"
          ? launch.label
          : typeof record.name === "string"
            ? record.name
            : "Authenticate",
    };
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
