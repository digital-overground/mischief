import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_PATH_LENGTH = 32_768;
const MAX_RECORD_BYTES = 1024 * 1024;
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

export interface ProfileDatabaseSnapshot {
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

export type ProfileDatabaseChange =
  | ActivateWorkspaceChange
  | DeactivateWorkspaceChange;

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

const EMPTY_SNAPSHOT: ProfileDatabaseSnapshot = Object.freeze({
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

const isWorkspaceLocation = (value: unknown): value is WorkspaceLocation =>
  isRecord(value) &&
  isAbsolutePath(value.path) &&
  (value.projectRoot === undefined || isAbsolutePath(value.projectRoot));

const parseWorkspaceRecord = (source: string): WorkspaceRecord | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
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

const readBounded = async (filename: string): Promise<string> => {
  const handle = await open(filename, "r");
  try {
    const stats = await handle.stat();
    if (stats.size > MAX_RECORD_BYTES) {
      throw new Error("record exceeds 1 MiB");
    }
    const source = await handle.readFile({ encoding: "utf-8" });
    return source;
  } finally {
    await handle.close();
  }
};

const copyWorkspace = (workspace: DatabaseWorkspace): DatabaseWorkspace => ({
  path: workspace.path,
  ...(workspace.projectRoot ? { projectRoot: workspace.projectRoot } : {}),
  status: workspace.status,
});

export class ProfileDatabase {
  private readonly currentWorkspace?: string;
  private readonly instanceId: string;
  private readonly listeners = new Set<() => void>();
  private readonly log: (message: string) => void;
  private pollTimer?: ReturnType<typeof setInterval>;
  private records = new Map<string, WorkspaceRecord>();
  private readonly workspacesDirectory: string;
  private currentSnapshot = EMPTY_SNAPSHOT;

  private constructor(
    currentWorkspace: string | undefined,
    instanceId: string,
    log: (message: string) => void,
    workspacesDirectory: string
  ) {
    this.currentWorkspace = currentWorkspace;
    this.instanceId = instanceId;
    this.log = log;
    this.workspacesDirectory = workspacesDirectory;
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

    const workspacesDirectory = path.join(
      options.profileDirectory,
      "profile-db-v1",
      "workspaces"
    );
    await mkdir(workspacesDirectory, { recursive: true });
    const database = new ProfileDatabase(
      options.currentWorkspace,
      options.instanceId,
      options.log,
      workspacesDirectory
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

  async apply(change: ProfileDatabaseChange): Promise<void> {
    let workspace: DatabaseWorkspace;
    if (change.type === "activateWorkspace") {
      if (!isWorkspaceLocation(change.workspace)) {
        throw new TypeError("Workspace is invalid");
      }
      workspace = {
        path: change.workspace.path,
        ...(change.workspace.projectRoot
          ? { projectRoot: change.workspace.projectRoot }
          : {}),
        status: "active",
      };
    } else {
      if (!isAbsolutePath(change.path)) {
        throw new TypeError("Workspace path is invalid");
      }
      if (change.path !== this.currentWorkspace) {
        throw new Error("Only the Workspace's own window can make it inactive");
      }
      const current = this.records.get(change.path);
      if (!current || current.status === "inactive") {
        return;
      }
      workspace = { ...copyWorkspace(current), status: "inactive" };
    }

    const record: WorkspaceRecord = {
      ...workspace,
      version: 1,
      writtenAt: Date.now(),
    };
    const destination = path.join(
      this.workspacesDirectory,
      `${createHash("sha256").update(workspace.path).digest("hex")}.json`
    );
    const temporary = `${destination}.${this.instanceId}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, "utf-8");
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => null);
      throw error;
    }

    this.records.set(record.path, record);
    this.updateSnapshot([...this.records.values()]);
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

  private async refresh(): Promise<void> {
    try {
      const directoryEntries = await readdir(this.workspacesDirectory, {
        withFileTypes: true,
      });
      const entries = directoryEntries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".json")
      );
      const loaded = await Promise.all(
        entries.map(async (entry) => {
          const filename = path.join(this.workspacesDirectory, entry.name);
          const source = await readBounded(filename);
          const record = parseWorkspaceRecord(source);
          if (!record) {
            this.log(`Ignoring invalid Workspace record: ${filename}`);
          }
          return record;
        })
      );
      const records = new Map<string, WorkspaceRecord>();
      for (const record of loaded) {
        if (!record) {
          continue;
        }
        const cached = this.records.get(record.path);
        const current = records.get(record.path);
        const newest =
          cached && cached.writtenAt > record.writtenAt ? cached : record;
        if (!current || current.writtenAt <= newest.writtenAt) {
          records.set(record.path, newest);
        }
      }
      this.records = records;
      this.updateSnapshot([...records.values()]);
    } catch (error) {
      this.log(`Profile Database poll failed: ${errorMessage(error)}`);
    }
  }

  private updateSnapshot(records: readonly WorkspaceRecord[]): void {
    const workspaces = records
      .map(copyWorkspace)
      .toSorted((left, right) =>
        left.path < right.path ? -1 : Number(left.path > right.path)
      );
    const previous = this.currentSnapshot.workspaces;
    if (
      workspaces.length === previous.length &&
      workspaces.every(
        (workspace, index) =>
          workspace.path === previous[index]?.path &&
          workspace.projectRoot === previous[index]?.projectRoot &&
          workspace.status === previous[index]?.status
      )
    ) {
      return;
    }

    this.currentSnapshot = Object.freeze({
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
