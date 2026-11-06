/* oxlint-disable no-await-in-loop, promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- queued prompts must run sequentially; synchronous ACP events dispatch durable async work; Thread writes are serialized */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  isAgentId,
  parseThreadRecord,
  THREAD_UUID_PATTERN,
} from "../shared/threads/record.js";
import type { AgentId, ThreadRecord } from "../shared/threads/record.js";
import type { HostAcpEvent } from "./host-acp-manager.js";

export type HostThreadRecord = ThreadRecord & { agentId: AgentId };
type HostThreadSession = HostThreadRecord & {
  configOptions?: unknown[] | null;
  operations?: HostOperations;
};

interface PromptImage {
  data: string;
  mimeType: string;
}

interface QueuedPrompt {
  id: string;
  images: PromptImage[];
  text: string;
}

interface HostOperations {
  branchSummary: boolean;
  forkMessage: boolean;
  treeNavigation: boolean;
}

interface HostAcpSession {
  configOptions?: unknown[] | null;
  operations: HostOperations;
  sessionId: string;
}

interface HostThreadAcp {
  cancel: (agentId: string, sessionId: string) => Promise<void>;
  create: (agentId: string, cwd: string) => Promise<HostAcpSession>;
  load: (
    agentId: string,
    sessionId: string,
    cwd: string
  ) => Promise<HostAcpSession>;
  prompt: (
    agentId: string,
    sessionId: string,
    text: string,
    images: PromptImage[]
  ) => Promise<"cancelled" | "completed">;
  setConfig: (
    agentId: string,
    sessionId: string,
    configId: string,
    value: string | boolean
  ) => Promise<void>;
}

const parse = (source: string): HostThreadRecord => {
  const record = parseThreadRecord(source);
  if (record.agentId === undefined) {
    throw new Error("Host Thread record has no Agent");
  }
  return { ...record, agentId: record.agentId };
};

/** Owns durable Thread identity and maps it to the Host's ACP sessions. */
export class HostThreads {
  private readonly acp: HostThreadAcp;
  private readonly directory: string;
  private readonly emit: (message: unknown) => void;
  private readonly active = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly configOptions = new Map<string, unknown[] | null>();
  private readonly loaded = new Set<string>();
  private readonly operations = new Map<string, HostOperations>();
  // shortcut: queued text is lost on Host crash, persist drafts if crash recovery must preserve queues.
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly records = new Map<string, HostThreadRecord>();
  private readonly writes = new Map<string, Promise<void>>();

  private constructor(
    directory: string,
    acp: HostThreadAcp,
    emit: (message: unknown) => void
  ) {
    this.directory = directory;
    this.acp = acp;
    this.emit = emit;
  }

  static async open(
    profilePath: string,
    acp: HostThreadAcp,
    emit: (message: unknown) => void
  ): Promise<HostThreads> {
    const directory = path.join(profilePath, "profile-db-v1", "threads");
    await mkdir(directory, { mode: 0o700, recursive: true });
    const threads = new HostThreads(directory, acp, emit);
    const names = await readdir(directory);
    const files = names.filter((name) => name.endsWith(".json"));
    const records = await Promise.all(
      files.map(async (name) => {
        const source = await readFile(path.join(directory, name), "utf-8");
        if (source.length > 8 * 1024 * 1024) {
          throw new Error("Host Thread record is too large");
        }
        return { name, record: parse(source) };
      })
    );
    for (const { name, record } of records) {
      if (name !== `${record.id}.json` || threads.records.has(record.id)) {
        throw new Error("Invalid Host Thread filename");
      }
      threads.records.set(record.id, record);
    }
    await Promise.all(
      records
        .map(({ record }) => record)
        .filter(
          (record) => record.status === "running" || record.status === "waiting"
        )
        .map(async (record) => {
          await threads.update(
            record,
            "error",
            "Host stopped during an active turn"
          );
        })
    );
    return threads;
  }

  snapshot(): HostThreadRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  queueSnapshots(): unknown[] {
    return [...this.queues]
      .filter(([, queue]) => queue.length > 0)
      .map(([threadId]) => this.queueSnapshot(threadId));
  }

  async adopt(
    agentId: string,
    workspace: string,
    threadId: string,
    sessionId: string
  ): Promise<HostThreadRecord> {
    if (
      !isAgentId(agentId) ||
      !path.isAbsolute(workspace) ||
      !THREAD_UUID_PATTERN.test(threadId) ||
      sessionId.length === 0 ||
      sessionId.length > 32_768
    ) {
      throw new TypeError("Invalid adopted Thread request");
    }
    const existing = this.records.get(threadId);
    if (existing) {
      if (
        existing.agentId !== agentId ||
        existing.workspace !== workspace ||
        existing.sessionId !== sessionId
      ) {
        throw new Error(`Thread already exists: ${threadId}`);
      }
      return { ...existing };
    }
    const now = new Date().toISOString();
    const record: HostThreadRecord = {
      agentId,
      createdAt: now,
      id: threadId,
      name: "Imported Thread",
      owner: "host",
      sessionId,
      status: "idle",
      updatedAt: now,
      version: 1,
      workspace,
      writtenAt: Date.now(),
    };
    this.records.set(threadId, record);
    await this.write(record);
    this.changed();
    return { ...record };
  }

  async create(
    agentId: string,
    workspace: string,
    requestedId?: string
  ): Promise<HostThreadSession> {
    if (
      !isAgentId(agentId) ||
      !path.isAbsolute(workspace) ||
      (requestedId !== undefined && !THREAD_UUID_PATTERN.test(requestedId))
    ) {
      throw new TypeError("Invalid new Thread request");
    }
    const now = new Date().toISOString();
    const record: HostThreadRecord = {
      agentId,
      createdAt: now,
      id: requestedId ?? randomUUID(),
      name: "New Thread",
      owner: "host",
      status: "running",
      updatedAt: now,
      version: 1,
      workspace,
      writtenAt: Date.now(),
    };
    if (this.records.has(record.id)) {
      throw new Error(`Thread already exists: ${record.id}`);
    }
    this.records.set(record.id, record);
    await this.write(record);
    this.changed();
    try {
      const session = await this.acp.create(agentId, workspace);
      record.sessionId = session.sessionId;
      this.rememberSession(record.id, session);
      this.loaded.add(record.id);
      await this.update(record, "idle");
    } catch (error) {
      await this.update(
        record,
        "error",
        error instanceof Error ? error.message : String(error)
      );
    }
    return this.sessionRecord(record);
  }

  async load(threadId: string): Promise<HostThreadSession> {
    const record = this.require(threadId);
    if (record.sessionId === undefined) {
      throw new Error("Thread has no Agent session; retry its prompt instead");
    }
    await this.ensureLoaded(record);
    return this.sessionRecord(record);
  }

  async prompt(
    threadId: string,
    text: string,
    images: PromptImage[] = []
  ): Promise<{ position: number; promptId: string }> {
    const record = this.require(threadId);
    if ((text.length === 0 && images.length === 0) || text.length > 1_000_000) {
      throw new TypeError("Invalid Thread prompt text");
    }
    const prompt = { id: randomUUID(), images, text };
    const queue = this.queues.get(threadId) ?? [];
    queue.push(prompt);
    this.queues.set(threadId, queue);
    this.queueChanged(threadId);
    if (!this.active.has(threadId)) {
      this.runQueue(record).catch((error: unknown) => {
        this.emit({
          message: error instanceof Error ? error.message : String(error),
          threadId,
          type: "error",
        });
      });
    }
    return await Promise.resolve({
      position: queue.length,
      promptId: prompt.id,
    });
  }

  async setConfig(
    threadId: string,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    const record = this.require(threadId);
    if (record.sessionId === undefined || configId.length === 0) {
      throw new Error("Thread has no Agent session or invalid configuration");
    }
    await this.ensureLoaded(record);
    await this.acp.setConfig(record.agentId, record.sessionId, configId, value);
  }

  async cancel(threadId: string): Promise<void> {
    const record = this.require(threadId);
    const queue = this.queues.get(threadId) ?? [];
    const queued = this.active.has(threadId)
      ? queue.splice(1)
      : queue.splice(0);
    if (queued.length > 0) {
      this.emit({
        drafts: queued.map(({ text }) => text),
        threadId,
        type: "threadQueueCleared",
      });
      this.queueChanged(threadId);
    }
    if (this.active.has(threadId)) {
      this.cancelled.add(threadId);
      if (record.sessionId !== undefined) {
        await this.acp.cancel(record.agentId, record.sessionId);
      }
    }
  }

  event(event: HostAcpEvent): void {
    if (event.type === "acpError") {
      this.emit(event);
      return;
    }
    let sessionId: string | undefined;
    if (event.type === "acpUpdate") {
      ({ sessionId } = event);
    } else if ("sessionId" in event.request) {
      ({ sessionId } = event.request);
    }
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.agentId === event.agentId &&
        candidate.sessionId !== undefined &&
        candidate.sessionId === sessionId
    );
    if (
      record &&
      (event.type === "acpPermission" || event.type === "acpElicitation") &&
      record.status === "running"
    ) {
      this.update(record, "waiting").catch((error: unknown) => {
        this.emit({
          message: String(error),
          threadId: record.id,
          type: "error",
        });
      });
    }
    this.emit(record ? { ...event, threadId: record.id } : event);
  }

  private require(threadId: string): HostThreadRecord {
    const record = this.records.get(threadId);
    if (!record) {
      throw new Error(`Unknown Thread: ${threadId}`);
    }
    return record;
  }

  private sessionRecord(record: HostThreadRecord): HostThreadSession {
    return {
      ...record,
      ...(this.configOptions.has(record.id)
        ? { configOptions: this.configOptions.get(record.id) }
        : {}),
      ...(this.operations.has(record.id)
        ? { operations: this.operations.get(record.id) }
        : {}),
    };
  }

  private rememberSession(threadId: string, session: HostAcpSession): void {
    if (session.configOptions !== undefined) {
      this.configOptions.set(threadId, session.configOptions);
    }
    this.operations.set(threadId, session.operations);
  }

  private async ensureLoaded(record: HostThreadRecord): Promise<void> {
    if (record.sessionId === undefined) {
      throw new Error("Thread has no Agent session");
    }
    if (this.loaded.has(record.id)) {
      return;
    }
    const session = await this.acp.load(
      record.agentId,
      record.sessionId,
      record.workspace
    );
    this.rememberSession(record.id, session);
    this.loaded.add(record.id);
  }

  private async runQueue(record: HostThreadRecord): Promise<void> {
    if (this.active.has(record.id)) {
      return;
    }
    this.active.add(record.id);
    const queue = this.queues.get(record.id) ?? [];
    try {
      let prompt: QueuedPrompt | undefined;
      [prompt] = queue;
      while (prompt !== undefined) {
        try {
          let { sessionId } = record;
          if (sessionId === undefined) {
            const session = await this.acp.create(
              record.agentId,
              record.workspace
            );
            ({ sessionId } = session);
            record.sessionId = sessionId;
            this.rememberSession(record.id, session);
            this.loaded.add(record.id);
          } else {
            await this.ensureLoaded(record);
          }
          await this.update(record, "running");
          let stopReason: "cancelled" | "completed";
          if (this.cancelled.delete(record.id)) {
            stopReason = "cancelled";
          } else {
            stopReason = await this.acp.prompt(
              record.agentId,
              sessionId,
              prompt.text,
              prompt.images
            );
            this.cancelled.delete(record.id);
          }
          this.emit({
            promptId: prompt.id,
            stopReason,
            threadId: record.id,
            type: "threadPromptComplete",
          });
          queue.shift();
          this.queueChanged(record.id);
        } catch (error) {
          queue.shift();
          const queued = queue.splice(0);
          if (queued.length > 0) {
            this.emit({
              drafts: queued.map(({ text }) => text),
              threadId: record.id,
              type: "threadQueueCleared",
            });
          }
          this.queueChanged(record.id);
          const message =
            error instanceof Error ? error.message : String(error);
          await this.update(record, "error", message);
          this.emit({
            message,
            promptId: prompt.id,
            threadId: record.id,
            type: "threadPromptError",
          });
          return;
        }
        [prompt] = queue;
      }
      await this.update(record, "idle");
    } finally {
      this.active.delete(record.id);
      if (queue.length > 0) {
        void this.runQueue(record);
      }
    }
  }

  private async update(
    record: HostThreadRecord,
    status: HostThreadRecord["status"],
    error?: string
  ): Promise<void> {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    record.writtenAt = Date.now();
    if (error === undefined) {
      delete record.error;
    } else {
      record.error = error;
    }
    await this.write(record);
    this.changed();
  }

  private async write(record: HostThreadRecord): Promise<void> {
    const target = path.join(this.directory, `${record.id}.json`);
    const source = JSON.stringify(record);
    const previous = this.writes.get(record.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, source, { mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes.set(record.id, next);
    try {
      await next;
    } finally {
      if (this.writes.get(record.id) === next) {
        this.writes.delete(record.id);
      }
    }
  }

  private queueSnapshot(threadId: string): unknown {
    return {
      prompts: (this.queues.get(threadId) ?? []).map((prompt, index) => ({
        ...prompt,
        position: index + 1,
      })),
      threadId,
      type: "threadQueue",
    };
  }

  private queueChanged(threadId: string): void {
    this.emit(this.queueSnapshot(threadId));
  }

  private changed(): void {
    this.emit({ threads: this.snapshot(), type: "threads" });
  }
}
