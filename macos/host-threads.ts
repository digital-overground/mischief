/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- synchronous ACP events dispatch durable async work, and Thread writes are serialized */
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

import agentConfig from "../shared/agents/config.json";
import type { HostAcpEvent } from "./host-acp-manager.js";

export interface HostThreadRecord {
  agentId: keyof typeof agentConfig;
  createdAt: string;
  error?: string;
  id: string;
  name: string;
  sessionId?: string;
  status: "idle" | "running" | "waiting" | "error";
  updatedAt: string;
  version: 1;
  workspace: string;
  writtenAt: number;
}

interface HostThreadAcp {
  cancel: (agentId: string, sessionId: string) => Promise<void>;
  create: (agentId: string, cwd: string) => Promise<string>;
  load: (agentId: string, sessionId: string, cwd: string) => Promise<void>;
  prompt: (
    agentId: string,
    sessionId: string,
    text: string
  ) => Promise<"cancelled" | "completed">;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const isAgentId = (value: unknown): value is keyof typeof agentConfig =>
  typeof value === "string" && Object.hasOwn(agentConfig, value);
const isStatus = (value: unknown): value is HostThreadRecord["status"] =>
  value === "idle" ||
  value === "running" ||
  value === "waiting" ||
  value === "error";
// oxlint-disable-next-line complexity -- validates every durable Thread field.
const parse = (source: string): HostThreadRecord => {
  const value: unknown = JSON.parse(source);
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !("agentId" in value) ||
    !isAgentId(value.agentId) ||
    !("workspace" in value) ||
    typeof value.workspace !== "string" ||
    !path.isAbsolute(value.workspace) ||
    ("sessionId" in value &&
      (typeof value.sessionId !== "string" || value.sessionId.length === 0)) ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 200 ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !("status" in value) ||
    !isStatus(value.status) ||
    !("writtenAt" in value) ||
    !Number.isSafeInteger(value.writtenAt) ||
    ("error" in value && typeof value.error !== "string")
  ) {
    throw new Error("Invalid Host Thread record");
  }
  const record: HostThreadRecord = {
    agentId: value.agentId,
    createdAt: value.createdAt,
    id: value.id,
    name: value.name,
    status: value.status,
    updatedAt: value.updatedAt,
    version: 1,
    workspace: value.workspace,
    writtenAt: Number(value.writtenAt),
  };
  if ("error" in value && typeof value.error === "string") {
    record.error = value.error;
  }
  if ("sessionId" in value && typeof value.sessionId === "string") {
    record.sessionId = value.sessionId;
  }
  return record;
};

/** Owns durable Thread identity and maps it to the Host's ACP sessions. */
export class HostThreads {
  private readonly acp: HostThreadAcp;
  private readonly directory: string;
  private readonly emit: (message: unknown) => void;
  private readonly loaded = new Set<string>();
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

  async create(agentId: string, workspace: string): Promise<HostThreadRecord> {
    if (!isAgentId(agentId) || !path.isAbsolute(workspace)) {
      throw new TypeError("Invalid new Thread request");
    }
    const now = new Date().toISOString();
    const record: HostThreadRecord = {
      agentId,
      createdAt: now,
      id: randomUUID(),
      name: "New Thread",
      status: "running",
      updatedAt: now,
      version: 1,
      workspace,
      writtenAt: Date.now(),
    };
    this.records.set(record.id, record);
    await this.write(record);
    this.changed();
    try {
      record.sessionId = await this.acp.create(agentId, workspace);
      this.loaded.add(record.id);
      await this.update(record, "idle");
    } catch (error) {
      await this.update(
        record,
        "error",
        error instanceof Error ? error.message : String(error)
      );
    }
    return { ...record };
  }

  async load(threadId: string): Promise<HostThreadRecord> {
    const record = this.require(threadId);
    if (record.sessionId === undefined) {
      throw new Error("Thread has no Agent session; retry its prompt instead");
    }
    await this.ensureLoaded(record);
    if (record.status === "error") {
      await this.update(record, "idle");
    }
    return { ...record };
  }

  async prompt(
    threadId: string,
    text: string
  ): Promise<"cancelled" | "completed"> {
    const record = this.require(threadId);
    if (record.status === "running" || record.status === "waiting") {
      throw new Error("Thread already has an active turn");
    }
    let { sessionId } = record;
    if (sessionId === undefined) {
      try {
        sessionId = await this.acp.create(record.agentId, record.workspace);
        record.sessionId = sessionId;
        this.loaded.add(record.id);
      } catch (error) {
        await this.update(
          record,
          "error",
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    } else {
      await this.ensureLoaded(record);
    }
    await this.update(record, "running");
    try {
      const result = await this.acp.prompt(record.agentId, sessionId, text);
      await this.update(record, "idle");
      return result;
    } catch (error) {
      await this.update(
        record,
        "error",
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async cancel(threadId: string): Promise<void> {
    const record = this.require(threadId);
    if (record.sessionId === undefined) {
      throw new Error("Thread has no Agent session");
    }
    await this.acp.cancel(record.agentId, record.sessionId);
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

  private async ensureLoaded(record: HostThreadRecord): Promise<void> {
    if (record.sessionId === undefined) {
      throw new Error("Thread has no Agent session");
    }
    if (this.loaded.has(record.id)) {
      return;
    }
    await this.acp.load(record.agentId, record.sessionId, record.workspace);
    this.loaded.add(record.id);
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

  private changed(): void {
    this.emit({ threads: this.snapshot(), type: "threads" });
  }
}
