import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { LEGACY_THREAD_AGENT, isAgentId } from "../agents/update";
import type { AgentId } from "../agents/update";
import { isNonEmpty, isRecord } from "../present";
import type { PromptImage } from "../threads/model";

const MAX_RETRY_IMAGE_BYTES = 20_000_000;
const MAX_RETRY_RECORD_BYTES = 21_000_000;
const MAX_PATH_LENGTH = 32_768;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LENGTH = 1_000_000;
const POLL_INTERVAL_MS = 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface WorkspaceLocation {
  readonly path: string;
  readonly projectRoot?: string;
}

export interface DatabaseWorkspace extends WorkspaceLocation {
  readonly status: "active" | "inactive";
}

export interface DatabaseThread {
  readonly id: string;
  // Old records without an Agent belong to MagPi.
  readonly agentId?: AgentId;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "idle" | "running" | "waiting" | "error";
  readonly error?: string;
  readonly retryText?: string;
  readonly retryHasImages?: boolean;
  readonly manualName?: boolean;
  readonly unread?: boolean;
  readonly usage?: { used: number; size: number };
}

export interface DatabaseSelection {
  readonly workspace: string;
  readonly threadId?: string;
  readonly focusRequest?: string;
}

export interface ProfileDatabaseSnapshot {
  readonly selections: readonly DatabaseSelection[];
  readonly threads: readonly DatabaseThread[];
  readonly workspaces: readonly DatabaseWorkspace[];
}

interface ActivateWorkspaceChange {
  readonly type: "activateWorkspace";
  readonly workspace: WorkspaceLocation;
}

interface DeactivateWorkspaceChange {
  readonly path: string;
  readonly type: "deactivateWorkspace";
}

interface PutThreadChange {
  readonly thread: DatabaseThread;
  readonly type: "putThread";
}

interface RemoveThreadChange {
  readonly id: string;
  readonly type: "removeThread";
}

interface SelectThreadChange extends DatabaseSelection {
  readonly type: "selectThread";
}

export type ProfileDatabaseChange =
  | ActivateWorkspaceChange
  | DeactivateWorkspaceChange
  | PutThreadChange
  | RemoveThreadChange
  | SelectThreadChange;

export interface ProfileDatabaseOptions {
  readonly currentWorkspace?: string;
  readonly instanceId: string;
  readonly log: (message: string) => void;
  readonly profileDirectory: string;
}

interface WorkspaceRecord extends DatabaseWorkspace {
  readonly version: 1;
  readonly writtenAt: number;
}

interface ThreadRecord extends DatabaseThread {
  readonly version: 1;
  readonly writtenAt: number;
}

interface SelectionRecord extends DatabaseSelection {
  readonly version: 1;
  readonly writtenAt: number;
}

const EMPTY_SNAPSHOT: ProfileDatabaseSnapshot = Object.freeze({
  selections: Object.freeze([]),
  threads: Object.freeze([]),
  workspaces: Object.freeze([]),
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_PATH_LENGTH &&
  !/\p{Cc}/u.test(value) &&
  path.isAbsolute(value);

const isBoundedString = (
  value: unknown,
  maximum = MAX_TEXT_LENGTH
): value is string => typeof value === "string" && value.length <= maximum;

const isTimestamp = (value: unknown): value is string =>
  isBoundedString(value, 100) &&
  value.length > 0 &&
  Number.isFinite(Date.parse(value));

const isWorkspaceLocation = (value: unknown): value is WorkspaceLocation =>
  isRecord(value) &&
  isAbsolutePath(value.path) &&
  (value.projectRoot === undefined || isAbsolutePath(value.projectRoot));

const isRetryImages = (value: unknown): value is PromptImage[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    return false;
  }
  let size = 0;
  return value.every((image: unknown) => {
    if (
      !isRecord(image) ||
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string" ||
      !/^[A-Za-z\d+/]*={0,2}$/u.test(image.data) ||
      !["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
        image.mimeType
      )
    ) {
      return false;
    }
    size += image.data.length;
    return size <= MAX_RETRY_IMAGE_BYTES;
  });
};

const isUsage = (
  value: unknown
): value is NonNullable<DatabaseThread["usage"]> =>
  isRecord(value) &&
  typeof value.used === "number" &&
  Number.isFinite(value.used) &&
  value.used >= 0 &&
  typeof value.size === "number" &&
  Number.isFinite(value.size) &&
  value.size >= 0;

// oxlint-disable-next-line complexity -- validates every durable Thread field
const isDatabaseThread = (value: unknown): value is DatabaseThread =>
  isRecord(value) &&
  typeof value.id === "string" &&
  UUID_PATTERN.test(value.id) &&
  (value.agentId === undefined || isAgentId(value.agentId)) &&
  isAbsolutePath(value.workspace) &&
  (value.sessionId === undefined ||
    (isBoundedString(value.sessionId, MAX_PATH_LENGTH) &&
      value.sessionId.length > 0)) &&
  isBoundedString(value.name, 200) &&
  value.name.length > 0 &&
  !/[\r\n]/u.test(value.name) &&
  isTimestamp(value.createdAt) &&
  isTimestamp(value.updatedAt) &&
  ["idle", "running", "waiting", "error"].includes(String(value.status)) &&
  (value.error === undefined || isBoundedString(value.error)) &&
  (value.retryText === undefined || isBoundedString(value.retryText)) &&
  (value.retryHasImages === undefined ||
    typeof value.retryHasImages === "boolean") &&
  (value.manualName === undefined || typeof value.manualName === "boolean") &&
  (value.unread === undefined || typeof value.unread === "boolean") &&
  (value.usage === undefined || isUsage(value.usage));

const copyWorkspace = (workspace: DatabaseWorkspace): DatabaseWorkspace => ({
  path: workspace.path,
  ...(isNonEmpty(workspace.projectRoot)
    ? { projectRoot: workspace.projectRoot }
    : {}),
  status: workspace.status,
});

const copyThread = (thread: DatabaseThread): DatabaseThread => ({
  agentId: thread.agentId ?? LEGACY_THREAD_AGENT,
  createdAt: thread.createdAt,
  ...(thread.error === undefined ? {} : { error: thread.error }),
  id: thread.id,
  ...(thread.manualName === undefined ? {} : { manualName: thread.manualName }),
  name: thread.name,
  ...(thread.retryText === undefined ? {} : { retryText: thread.retryText }),
  ...(thread.retryHasImages === true ? { retryHasImages: true } : {}),
  ...(thread.sessionId === undefined ? {} : { sessionId: thread.sessionId }),
  status: thread.status,
  ...(thread.unread === undefined ? {} : { unread: thread.unread }),
  updatedAt: thread.updatedAt,
  ...(thread.usage ? { usage: { ...thread.usage } } : {}),
  workspace: thread.workspace,
});

const copySelection = (selection: DatabaseSelection): DatabaseSelection => ({
  ...(isNonEmpty(selection.threadId) ? { threadId: selection.threadId } : {}),
  ...(isNonEmpty(selection.focusRequest)
    ? { focusRequest: selection.focusRequest }
    : {}),
  workspace: selection.workspace,
});

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
};

export const stripLegacyThreadAuthentication = (value: unknown): unknown => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.threads) ||
    !value.threads.some(
      (thread: unknown) =>
        isRecord(thread) && Object.hasOwn(thread, "authentication")
    )
  ) {
    return value;
  }
  return {
    ...value,
    threads: value.threads.map((entry: unknown) => {
      if (!isRecord(entry) || !Object.hasOwn(entry, "authentication")) {
        return entry;
      }
      const thread = { ...entry };
      delete thread.authentication;
      return thread;
    }),
  };
};

const parseWorkspaceRecord = (source: string): WorkspaceRecord | undefined => {
  const value = parseJson(source);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isAbsolutePath(value.path) ||
    (value.projectRoot !== undefined && !isAbsolutePath(value.projectRoot)) ||
    (value.status !== "active" && value.status !== "inactive") ||
    !Number.isSafeInteger(value.writtenAt) ||
    Number(value.writtenAt) < 0
  ) {
    return undefined;
  }
  return {
    path: value.path,
    ...(isNonEmpty(value.projectRoot)
      ? { projectRoot: value.projectRoot }
      : {}),
    status: value.status,
    version: 1,
    writtenAt: Number(value.writtenAt),
  };
};

const parseThreadRecord = (source: string): ThreadRecord | undefined => {
  const value = parseJson(source);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isDatabaseThread(value) ||
    !Number.isSafeInteger(value.writtenAt) ||
    Number(value.writtenAt) < 0
  ) {
    return undefined;
  }
  return {
    ...copyThread(value),
    version: 1,
    writtenAt: Number(value.writtenAt),
  };
};

const parsePreviousThread = (value: unknown): DatabaseThread | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = {
    ...value,
    status: isNonEmpty(
      typeof value.error === "string" ? value.error : undefined
    )
      ? "error"
      : "idle",
  };
  return isDatabaseThread(candidate) ? copyThread(candidate) : undefined;
};

const parseSelectionRecord = (source: string): SelectionRecord | undefined => {
  const value = parseJson(source);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isAbsolutePath(value.workspace) ||
    (value.threadId !== undefined &&
      (typeof value.threadId !== "string" ||
        !UUID_PATTERN.test(value.threadId))) ||
    (value.focusRequest !== undefined &&
      (typeof value.focusRequest !== "string" ||
        !UUID_PATTERN.test(value.focusRequest) ||
        value.threadId === undefined)) ||
    !Number.isSafeInteger(value.writtenAt) ||
    Number(value.writtenAt) < 0
  ) {
    return undefined;
  }
  return {
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
    ...(typeof value.focusRequest === "string"
      ? { focusRequest: value.focusRequest }
      : {}),
    version: 1,
    workspace: value.workspace,
    writtenAt: Number(value.writtenAt),
  };
};

const readBounded = async (
  filename: string,
  maximum = MAX_RECORD_BYTES
): Promise<string> => {
  const handle = await open(filename, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > maximum) {
      throw new Error("record exceeds size limit");
    }
    return await handle.readFile({ encoding: "utf-8" });
  } finally {
    await handle.close();
  }
};

const mergeRecords = <T extends { readonly writtenAt: number }>(
  loaded: readonly T[],
  cached: ReadonlyMap<string, T>,
  key: (record: T) => string
): Map<string, T> => {
  const records = new Map<string, T>();
  for (const record of loaded) {
    const id = key(record);
    const previous = cached.get(id);
    const newest =
      previous && previous.writtenAt > record.writtenAt ? previous : record;
    const current = records.get(id);
    if (!current || current.writtenAt <= newest.writtenAt) {
      records.set(id, newest);
    }
  }
  return records;
};

const pathKey = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const freezeThread = (thread: DatabaseThread): DatabaseThread => {
  const copy = copyThread(thread);
  if (copy.usage) {
    Object.freeze(copy.usage);
  }
  return Object.freeze(copy);
};

export class ProfileDatabase {
  private readonly currentWorkspace?: string;
  private readonly instanceId: string;
  private readonly listeners = new Set<() => void>();
  private readonly log: (message: string) => void;
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly watchers: FSWatcher[] = [];
  private watchTimer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private refreshPending = false;
  // File scans and writes share one queue so stale scans cannot erase newer records.
  private operationTail: Promise<void> = Promise.resolve();
  private selectionRecords = new Map<string, SelectionRecord>();
  private readonly selectionsDirectory: string;
  private readonly retryImagesDirectory: string;
  private threadRecords = new Map<string, ThreadRecord>();
  private readonly threadsDirectory: string;
  private workspaceRecords = new Map<string, WorkspaceRecord>();
  private readonly workspacesDirectory: string;
  private currentSnapshot = EMPTY_SNAPSHOT;

  private constructor(
    currentWorkspace: string | undefined,
    instanceId: string,
    log: (message: string) => void,
    workspacesDirectory: string,
    threadsDirectory: string,
    selectionsDirectory: string,
    retryImagesDirectory: string
  ) {
    this.currentWorkspace = currentWorkspace;
    this.instanceId = instanceId;
    this.log = log;
    this.workspacesDirectory = workspacesDirectory;
    this.threadsDirectory = threadsDirectory;
    this.selectionsDirectory = selectionsDirectory;
    this.retryImagesDirectory = retryImagesDirectory;
  }

  static async open(options: ProfileDatabaseOptions): Promise<ProfileDatabase> {
    if (!UUID_PATTERN.test(options.instanceId)) {
      throw new TypeError("Profile Database Instance ID must be a UUID");
    }
    if (!isAbsolutePath(options.profileDirectory)) {
      throw new TypeError(
        "Profile Database directory must be an absolute path"
      );
    }
    if (
      options.currentWorkspace !== undefined &&
      !isAbsolutePath(options.currentWorkspace)
    ) {
      throw new TypeError("Current Workspace must be an absolute path");
    }

    const databaseDirectory = path.join(
      options.profileDirectory,
      "profile-db-v1"
    );
    const workspacesDirectory = path.join(databaseDirectory, "workspaces");
    const threadsDirectory = path.join(databaseDirectory, "threads");
    const selectionsDirectory = path.join(databaseDirectory, "selections");
    const retryImagesDirectory = path.join(databaseDirectory, "retry-images");
    await Promise.all(
      [
        workspacesDirectory,
        threadsDirectory,
        selectionsDirectory,
        retryImagesDirectory,
      ].map(async (directory) => await mkdir(directory, { recursive: true }))
    );
    const database = new ProfileDatabase(
      options.currentWorkspace,
      options.instanceId,
      options.log,
      workspacesDirectory,
      threadsDirectory,
      selectionsDirectory,
      retryImagesDirectory
    );
    await database.scrubStoredAuthentication();
    await database.refresh();
    for (const directory of [
      workspacesDirectory,
      threadsDirectory,
      selectionsDirectory,
    ]) {
      try {
        const watcher = watch(directory, () => {
          if (database.watchTimer !== undefined) {
            clearTimeout(database.watchTimer);
          }
          database.watchTimer = setTimeout(() => {
            database.watchTimer = undefined;
            void database.refresh();
          }, 20);
        });
        watcher.on("error", (error) => {
          options.log(
            `Profile Database watcher failed: ${errorMessage(error)}`
          );
          watcher.close();
        });
        database.watchers.push(watcher);
      } catch (error) {
        options.log(
          `Profile Database watcher unavailable: ${errorMessage(error)}`
        );
      }
    }
    // Polling remains a fallback when file notifications are missed or unavailable.
    database.pollTimer = setInterval(() => {
      void database.refresh();
    }, POLL_INTERVAL_MS);
    return database;
  }

  snapshot(): ProfileDatabaseSnapshot {
    return this.currentSnapshot;
  }

  async readRetryImages(workspace: string, id: string): Promise<PromptImage[]> {
    this.requireRetryOwner(workspace, id);
    let source: string;
    try {
      source = await readBounded(
        this.retryFilename(id),
        MAX_RETRY_RECORD_BYTES
      );
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        throw new Error(
          "Saved retry images are missing; reattach them before retrying",
          {
            cause: error,
          }
        );
      }
      throw error;
    }
    const images = parseJson(source);
    if (!isRetryImages(images)) {
      throw new Error(
        "Saved retry images are invalid; reattach them before retrying"
      );
    }
    return images;
  }

  async saveRetryImages(
    workspace: string,
    id: string,
    images: PromptImage[]
  ): Promise<void> {
    await this.serialize(async () => {
      this.requireRetryOwner(workspace, id);
      const filename = this.retryFilename(id);
      if (images.length === 0) {
        await rm(filename, { force: true });
      } else {
        if (!isRetryImages(images)) {
          throw new TypeError("Invalid retry images");
        }
        await this.replace(filename, images);
      }
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async apply(change: ProfileDatabaseChange): Promise<void> {
    await this.serialize(async () => {
      await this.applyChange(change);
    });
  }

  // oxlint-disable-next-line complexity -- validates and routes each database change
  private async applyChange(change: ProfileDatabaseChange): Promise<void> {
    if (change.type === "activateWorkspace") {
      if (!isWorkspaceLocation(change.workspace)) {
        throw new TypeError("Workspace is invalid");
      }
      await this.putWorkspace({
        path: change.workspace.path,
        ...(isNonEmpty(change.workspace.projectRoot)
          ? { projectRoot: change.workspace.projectRoot }
          : {}),
        status: "active",
      });
      return;
    }

    if (change.type === "deactivateWorkspace") {
      if (!isAbsolutePath(change.path)) {
        throw new TypeError("Workspace path is invalid");
      }
      const current = this.workspaceRecords.get(change.path);
      if (!current || current.status === "inactive") {
        return;
      }
      await this.putWorkspace({
        ...copyWorkspace(current),
        status: "inactive",
      });
      return;
    }

    if (change.type === "putThread") {
      if (!isDatabaseThread(change.thread)) {
        throw new TypeError("Thread is invalid");
      }
      this.requireThreadOwner(change.thread.workspace);
      const current = this.threadRecords.get(change.thread.id);
      if (current && current.workspace !== change.thread.workspace) {
        throw new Error("A Thread cannot move to another Workspace");
      }
      await this.putThread(change.thread);
      return;
    }

    if (change.type === "removeThread") {
      if (!UUID_PATTERN.test(change.id)) {
        throw new TypeError("Thread ID is invalid");
      }
      const current = this.threadRecords.get(change.id);
      if (!current) {
        return;
      }
      this.requireThreadOwner(current.workspace);
      await rm(path.join(this.threadsDirectory, `${change.id}.json`), {
        force: true,
      });
      this.threadRecords.delete(change.id);
      this.updateSnapshot();
      await rm(this.retryFilename(change.id), { force: true });
      return;
    }

    if (!isAbsolutePath(change.workspace)) {
      throw new TypeError("Selection Workspace is invalid");
    }
    if (change.threadId !== undefined && !UUID_PATTERN.test(change.threadId)) {
      throw new TypeError("Selected Thread ID is invalid");
    }
    if (
      change.focusRequest !== undefined &&
      (!UUID_PATTERN.test(change.focusRequest) || !isNonEmpty(change.threadId))
    ) {
      throw new TypeError("Focus request ID is invalid");
    }
    if (!isNonEmpty(change.threadId)) {
      this.requireThreadOwner(change.workspace);
    }
    const thread = isNonEmpty(change.threadId)
      ? this.threadRecords.get(change.threadId)
      : undefined;
    if (isNonEmpty(change.threadId) && thread?.workspace !== change.workspace) {
      throw new Error("Selected Thread does not belong to the Workspace");
    }
    await this.putSelection(change);
  }

  async importPreviousThreads(value: unknown): Promise<void> {
    await this.serialize(async () => {
      await this.importPreviousThreadsChange(value);
    });
  }

  private async importPreviousThreadsChange(value: unknown): Promise<void> {
    if (!isRecord(value) || !Array.isArray(value.threads)) {
      return;
    }
    const threads = [
      ...new Map(
        value.threads
          .map(parsePreviousThread)
          .filter((thread): thread is DatabaseThread => Boolean(thread))
          .map((thread) => [thread.id, thread])
      ).values(),
    ].filter((thread) => !this.threadRecords.has(thread.id));
    await Promise.all(
      threads.map(async (thread) => {
        await this.putThread(thread);
      })
    );

    if (!isRecord(value.selected)) {
      return;
    }
    const selections = Object.entries(value.selected).flatMap(
      ([workspace, threadId]) =>
        !this.selectionRecords.has(workspace) &&
        isAbsolutePath(workspace) &&
        typeof threadId === "string" &&
        this.threadRecords.get(threadId)?.workspace === workspace
          ? [{ threadId, workspace }]
          : []
    );
    await Promise.all(
      selections.map(async (selection) => {
        await this.putSelection(selection);
      })
    );
  }

  async dispose(): Promise<void> {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    if (this.watchTimer !== undefined) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.listeners.clear();
    if (isNonEmpty(this.currentWorkspace)) {
      try {
        await this.apply({
          path: this.currentWorkspace,
          type: "deactivateWorkspace",
        });
      } catch (error) {
        this.log(`Could not make Workspace inactive: ${errorMessage(error)}`);
      }
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let resolver: (() => void) | undefined;
    // oxlint-disable-next-line promise/avoid-new
    const next = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    this.operationTail = next;
    await previous;
    try {
      return await operation();
    } finally {
      resolver?.();
    }
  }

  private requireThreadOwner(workspace: string): void {
    if (workspace !== this.currentWorkspace) {
      throw new Error("Only the owning Workspace Instance can write Threads");
    }
  }

  private requireRetryOwner(workspace: string, id: string): void {
    this.requireThreadOwner(workspace);
    if (
      !UUID_PATTERN.test(id) ||
      this.threadRecords.get(id)?.workspace !== workspace
    ) {
      throw new Error("Unknown Thread for retry images");
    }
  }

  private retryFilename(id: string): string {
    return path.join(this.retryImagesDirectory, `${id}.json`);
  }

  private async replace(filename: string, value: unknown): Promise<void> {
    const temporary = `${filename}.${this.instanceId}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await rename(temporary, filename);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => null);
      throw error;
    }
  }

  private async putWorkspace(workspace: DatabaseWorkspace): Promise<void> {
    const record: WorkspaceRecord = {
      ...workspace,
      version: 1,
      writtenAt: Date.now(),
    };
    await this.replace(
      path.join(this.workspacesDirectory, `${pathKey(workspace.path)}.json`),
      record
    );
    this.workspaceRecords.set(record.path, record);
    this.updateSnapshot();
  }

  private async scrubStoredAuthentication(): Promise<void> {
    const entries = await readdir(this.threadsDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filename = path.join(this.threadsDirectory, entry.name);
      let record: unknown;
      try {
        // oxlint-disable-next-line no-await-in-loop -- clean each old record before loading it
        record = parseJson(await readBounded(filename));
      } catch (error) {
        this.log(
          `Could not inspect Thread record ${filename}: ${errorMessage(error)}`
        );
        continue;
      }
      if (isRecord(record) && Object.hasOwn(record, "authentication")) {
        delete record.authentication;
        // oxlint-disable-next-line no-await-in-loop -- preserve each record if a later cleanup fails
        await this.replace(filename, record);
      }
    }
  }

  private async putThread(thread: DatabaseThread): Promise<void> {
    const record: ThreadRecord = {
      ...copyThread(thread),
      version: 1,
      writtenAt: Date.now(),
    };
    await this.replace(
      path.join(this.threadsDirectory, `${record.id}.json`),
      record
    );
    this.threadRecords.set(record.id, record);
    this.updateSnapshot();
  }

  private async putSelection(selection: DatabaseSelection): Promise<void> {
    const record: SelectionRecord = {
      ...copySelection(selection),
      version: 1,
      writtenAt: Date.now(),
    };
    await this.replace(
      path.join(
        this.selectionsDirectory,
        `${pathKey(selection.workspace)}.json`
      ),
      record
    );
    this.selectionRecords.set(record.workspace, record);
    this.updateSnapshot();
  }

  private async readRecords<T>(
    directory: string,
    name: string,
    parse: (source: string) => T | undefined
  ): Promise<T[]> {
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    const entries = directoryEntries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json")
    );
    const records: T[] = [];
    // ponytail: sequential reads suit a tiny profile database; parallelize only if polling cost becomes measurable
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      // oxlint-disable-next-line no-await-in-loop -- see polling ceiling above
      const record = parse(await readBounded(filename));
      if (record === undefined) {
        this.log(`Ignoring invalid ${name} record: ${filename}`);
      } else {
        records.push(record);
      }
    }
    return records;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshPending = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.refreshPending = false;
        // oxlint-disable-next-line no-await-in-loop -- coalesce notifications received during a scan
        await this.serialize(async () => {
          await this.readAndUpdate();
        });
      } while (this.refreshPending);
    } finally {
      this.refreshing = false;
      if (this.refreshPending) {
        void this.refresh();
      }
    }
  }

  private async readAndUpdate(): Promise<void> {
    try {
      const [workspaces, threads, selections] = await Promise.all([
        this.readRecords(
          this.workspacesDirectory,
          "Workspace",
          parseWorkspaceRecord
        ),
        this.readRecords(this.threadsDirectory, "Thread", parseThreadRecord),
        this.readRecords(
          this.selectionsDirectory,
          "selection",
          parseSelectionRecord
        ),
      ]);
      this.workspaceRecords = mergeRecords(
        workspaces,
        this.workspaceRecords,
        (record) => record.path
      );
      this.threadRecords = mergeRecords(
        threads,
        this.threadRecords,
        (record) => record.id
      );
      this.selectionRecords = mergeRecords(
        selections,
        this.selectionRecords,
        (record) => record.workspace
      );
      this.updateSnapshot();
    } catch (error) {
      this.log(`Profile Database poll failed: ${errorMessage(error)}`);
    }
  }

  private updateSnapshot(): void {
    const workspaces = [...this.workspaceRecords.values()]
      .map(copyWorkspace)
      .toSorted((left, right) => left.path.localeCompare(right.path));
    const threads = [...this.threadRecords.values()]
      .map(copyThread)
      .toSorted(
        (left, right) =>
          left.workspace.localeCompare(right.workspace) ||
          right.createdAt.localeCompare(left.createdAt) ||
          left.id.localeCompare(right.id)
      );
    const selections = [...this.selectionRecords.values()]
      .map(copySelection)
      .toSorted((left, right) => left.workspace.localeCompare(right.workspace));
    const next = { selections, threads, workspaces };
    if (JSON.stringify(next) === JSON.stringify(this.currentSnapshot)) {
      return;
    }

    this.currentSnapshot = Object.freeze({
      selections: Object.freeze(
        selections.map((selection) => Object.freeze(selection))
      ),
      threads: Object.freeze(threads.map(freezeThread)),
      workspaces: Object.freeze(
        workspaces.map((workspace) => Object.freeze(workspace))
      ),
    });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.log(`Profile Database listener failed: ${errorMessage(error)}`);
      }
    }
  }
}
