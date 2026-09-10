import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_PATH_LENGTH = 32_768;
const MAX_RECORD_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface Membership {
  readonly kind: "git" | "untracked";
  readonly path: string;
  readonly state: "active" | "removed";
}

export interface ProfileSyncSnapshot {
  readonly memberships: readonly Membership[];
}

export interface ProfileSyncChange {
  readonly membership: Membership;
  readonly type: "putMembership";
}

export interface ProfileSyncOptions {
  readonly instanceId: string;
  readonly log: (message: string) => void;
  readonly profileDirectory: string;
  readonly workspace?: string;
}

interface MembershipRecord extends Membership {
  readonly version: 1;
  readonly writtenAt: string;
}

const EMPTY_SNAPSHOT: ProfileSyncSnapshot = Object.freeze({
  memberships: Object.freeze([]),
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

const isMembership = (value: unknown): value is Membership =>
  isRecord(value) &&
  (value.kind === "git" || value.kind === "untracked") &&
  isAbsolutePath(value.path) &&
  (value.state === "active" || value.state === "removed");

const isTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 64) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
};

const parseMembershipRecord = (
  source: string
): MembershipRecord | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.kind !== "git" && value.kind !== "untracked") ||
    !isAbsolutePath(value.path) ||
    (value.state !== "active" && value.state !== "removed") ||
    !isTimestamp(value.writtenAt)
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    path: value.path,
    state: value.state,
    version: 1,
    writtenAt: value.writtenAt,
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

const copyMembership = (membership: Membership): Membership => ({
  kind: membership.kind,
  path: membership.path,
  state: membership.state,
});

export class ProfileSync {
  private currentSnapshot = EMPTY_SNAPSHOT;
  private readonly instanceId: string;
  private readonly listeners = new Set<() => void>();
  private readonly log: (message: string) => void;
  private readonly membershipsDirectory: string;
  private pollTimer?: ReturnType<typeof setInterval>;
  private records = new Map<string, MembershipRecord>();

  private constructor(
    instanceId: string,
    log: (message: string) => void,
    membershipsDirectory: string
  ) {
    this.instanceId = instanceId;
    this.log = log;
    this.membershipsDirectory = membershipsDirectory;
  }

  static async open(options: ProfileSyncOptions): Promise<ProfileSync> {
    if (!UUID_PATTERN.test(options.instanceId)) {
      throw new TypeError("Profile Sync Instance ID must be a UUID");
    }
    if (!isAbsolutePath(options.profileDirectory)) {
      throw new TypeError("Profile Sync directory must be an absolute path");
    }
    if (options.workspace !== undefined && !isAbsolutePath(options.workspace)) {
      throw new TypeError("Profile Sync Workspace must be an absolute path");
    }

    const membershipsDirectory = path.join(
      options.profileDirectory,
      "profile-sync-v1",
      "memberships"
    );
    await mkdir(membershipsDirectory, { recursive: true });
    const sync = new ProfileSync(
      options.instanceId,
      options.log,
      membershipsDirectory
    );
    await sync.refresh();
    // ponytail: profile-local polling is enough; add IPC or indexing only when scan cost or latency is measurable
    sync.pollTimer = setInterval(() => {
      void sync.refresh();
    }, POLL_INTERVAL_MS);
    return sync;
  }

  snapshot(): ProfileSyncSnapshot {
    return this.currentSnapshot;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async apply(change: ProfileSyncChange): Promise<void> {
    if (!isMembership(change.membership)) {
      throw new TypeError("Profile Sync membership is invalid");
    }
    const membership = copyMembership(change.membership);
    const record: MembershipRecord = {
      ...membership,
      version: 1,
      writtenAt: new Date().toISOString(),
    };
    const destination = path.join(
      this.membershipsDirectory,
      `${createHash("sha256").update(membership.path).digest("hex")}.json`
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

  dispose(): Promise<void> {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.listeners.clear();
    return Promise.resolve();
  }

  private async refresh(): Promise<void> {
    try {
      const directoryEntries = await readdir(this.membershipsDirectory, {
        withFileTypes: true,
      });
      const entries = directoryEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const loaded = await Promise.all(
        entries.map(async (entry) => {
          const filename = path.join(this.membershipsDirectory, entry.name);
          const source = await readBounded(filename);
          const record = parseMembershipRecord(source);
          if (!record) {
            this.log(`Ignoring invalid Profile Sync membership: ${filename}`);
          }
          return record;
        })
      );
      const records = new Map<string, MembershipRecord>();
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
      this.log(`Profile Sync poll failed: ${errorMessage(error)}`);
    }
  }

  private updateSnapshot(records: readonly MembershipRecord[]): void {
    const memberships = records
      .map(copyMembership)
      .toSorted((left, right) =>
        left.path < right.path ? -1 : Number(left.path > right.path)
      );
    const previous = this.currentSnapshot.memberships;
    if (
      memberships.length === previous.length &&
      memberships.every(
        (membership, index) =>
          membership.kind === previous[index]?.kind &&
          membership.path === previous[index]?.path &&
          membership.state === previous[index]?.state
      )
    ) {
      return;
    }

    this.currentSnapshot = Object.freeze({
      memberships: Object.freeze(
        memberships.map((membership) => Object.freeze(membership))
      ),
    });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.log(`Profile Sync listener failed: ${errorMessage(error)}`);
      }
    }
  }
}
