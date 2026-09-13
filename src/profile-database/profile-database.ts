import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
  readonly workspace: string;
  readonly sessionId?: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: "idle" | "running" | "waiting" | "error";
  readonly error?: string;
  readonly retryText?: string;
  readonly authentication?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    label: string;
  };
  readonly manualName?: boolean;
  readonly unread?: boolean;
  readonly usage?: { used: number; size: number };
}

export interface DatabaseSelection {
  readonly workspace: string;
  readonly threadId?: string;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

const isAuthentication = (
  value: unknown
): value is NonNullable<DatabaseThread["authentication"]> =>
  isRecord(value) &&
  isBoundedString(value.command, MAX_PATH_LENGTH) &&
  value.command.length > 0 &&
  Array.isArray(value.args) &&
  value.args.length <= 100 &&
  value.args.every((argument) => isBoundedString(argument, MAX_PATH_LENGTH)) &&
  isBoundedString(value.label, 200) &&
  value.label.length > 0 &&
  (value.env === undefined ||
    (isRecord(value.env) &&
      Object.entries(value.env).every(
        ([key, candidate]) =>
          key.length <= 1000 && isBoundedString(candidate, MAX_PATH_LENGTH)
      )));

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
  (value.authentication === undefined ||
    isAuthentication(value.authentication)) &&
  (value.manualName === undefined || typeof value.manualName === "boolean") &&
  (value.unread === undefined || typeof value.unread === "boolean") &&
  (value.usage === undefined || isUsage(value.usage));

const copyWorkspace = (workspace: DatabaseWorkspace): DatabaseWorkspace => ({
  path: workspace.path,
  ...(workspace.projectRoot ? { projectRoot: workspace.projectRoot } : {}),
  status: workspace.status,
});

const copyThread = (thread: DatabaseThread): DatabaseThread => ({
  ...(thread.authentication
    ? {
        authentication: {
          args: [...thread.authentication.args],
          command: thread.authentication.command,
          ...(thread.authentication.env
            ? { env: { ...thread.authentication.env } }
            : {}),
          label: thread.authentication.label,
        },
      }
    : {}),
  createdAt: thread.createdAt,
  ...(thread.error === undefined ? {} : { error: thread.error }),
  id: thread.id,
  ...(thread.manualName === undefined ? {} : { manualName: thread.manualName }),
  name: thread.name,
  ...(thread.retryText === undefined ? {} : { retryText: thread.retryText }),
  ...(thread.sessionId === undefined ? {} : { sessionId: thread.sessionId }),
  status: thread.status,
  ...(thread.unread === undefined ? {} : { unread: thread.unread }),
  updatedAt: thread.updatedAt,
  ...(thread.usage ? { usage: { ...thread.usage } } : {}),
  workspace: thread.workspace,
});

const copySelection = (selection: DatabaseSelection): DatabaseSelection => ({
  ...(selection.threadId ? { threadId: selection.threadId } : {}),
  workspace: selection.workspace,
});

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
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
    ...(value.projectRoot ? { projectRoot: value.projectRoot } : {}),
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
    status: value.error ? "error" : "idle",
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
    !Number.isSafeInteger(value.writtenAt) ||
    Number(value.writtenAt) < 0
  ) {
    return undefined;
  }
  return {
    ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
    version: 1,
    workspace: value.workspace,
    writtenAt: Number(value.writtenAt),
  };
};

const readBounded = async (filename: string): Promise<string> => {
  const handle = await open(filename, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > MAX_RECORD_BYTES) {
      throw new Error("record exceeds 8 MiB");
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
  if (copy.authentication) {
    Object.freeze(copy.authentication.args);
    if (copy.authentication.env) {
      Object.freeze(copy.authentication.env);
    }
    Object.freeze(copy.authentication);
  }
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
  private selectionRecords = new Map<string, SelectionRecord>();
  private readonly selectionsDirectory: string;
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
    selectionsDirectory: string
  ) {
    this.currentWorkspace = currentWorkspace;
    this.instanceId = instanceId;
    this.log = log;
    this.workspacesDirectory = workspacesDirectory;
    this.threadsDirectory = threadsDirectory;
    this.selectionsDirectory = selectionsDirectory;
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
    await Promise.all(
      [workspacesDirectory, threadsDirectory, selectionsDirectory].map(
        (directory) => mkdir(directory, { recursive: true })
      )
    );
    const database = new ProfileDatabase(
      options.currentWorkspace,
      options.instanceId,
      options.log,
      workspacesDirectory,
      threadsDirectory,
      selectionsDirectory
    );
    await database.refresh();
    // ponytail: profile-local polling is enough; add IPC or indexing only when scan cost or latency is measurable
    database.pollTimer = setInterval(() => {
      void database.refresh();
    }, POLL_INTERVAL_MS);
    return database;
  }

  snapshot(): ProfileDatabaseSnapshot {
    return this.currentSnapshot;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // oxlint-disable-next-line complexity -- validates and routes each database change
  async apply(change: ProfileDatabaseChange): Promise<void> {
    if (change.type === "activateWorkspace") {
      if (!isWorkspaceLocation(change.workspace)) {
        throw new TypeError("Workspace is invalid");
      }
      await this.putWorkspace({
        path: change.workspace.path,
        ...(change.workspace.projectRoot
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
      return;
    }

    if (!isAbsolutePath(change.workspace)) {
      throw new TypeError("Selection Workspace is invalid");
    }
    if (change.threadId !== undefined && !UUID_PATTERN.test(change.threadId)) {
      throw new TypeError("Selected Thread ID is invalid");
    }
    if (!change.threadId) {
      this.requireThreadOwner(change.workspace);
    }
    const thread = change.threadId
      ? this.threadRecords.get(change.threadId)
      : undefined;
    if (change.threadId && thread?.workspace !== change.workspace) {
      throw new Error("Selected Thread does not belong to the Workspace");
    }
    await this.putSelection(change);
  }

  async importPreviousThreads(value: unknown): Promise<void> {
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
    await Promise.all(threads.map((thread) => this.putThread(thread)));

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
      selections.map((selection) => this.putSelection(selection))
    );
  }

  async dispose(): Promise<void> {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.listeners.clear();
    if (this.currentWorkspace) {
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

  private requireThreadOwner(workspace: string): void {
    if (workspace !== this.currentWorkspace) {
      throw new Error("Only the owning Workspace Instance can write Threads");
    }
  }

  private async replace(filename: string, value: unknown): Promise<void> {
    const temporary = `${filename}.${this.instanceId}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf-8");
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
      if (record) {
        records.push(record);
      } else {
        this.log(`Ignoring invalid ${name} record: ${filename}`);
      }
    }
    return records;
  }

  private async refresh(): Promise<void> {
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
