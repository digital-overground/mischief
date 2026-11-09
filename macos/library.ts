import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  readdir,
  readFile,
  realpath,
  stat,
  mkdir,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

interface WorkspaceRecord {
  path: string;
  projectRoot?: string;
  status: "active" | "inactive";
}
interface ThreadRecord {
  id: string;
  owner?: "host";
  workspace: string;
  name: string;
  status: "idle" | "running" | "waiting" | "error";
  unread?: boolean;
  updatedAt: string;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isErrorCode = (error: unknown, code: string | number): boolean =>
  isRecord(error) && error.code === code;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const absolute = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 32_768 &&
  path.isAbsolute(value) &&
  !/\p{Cc}/u.test(value);
const validWorkspace = (w: unknown, name: string): w is WorkspaceRecord =>
  isRecord(w) &&
  absolute(w.path) &&
  name === `${createHash("sha256").update(w.path).digest("hex")}.json` &&
  (w.projectRoot === undefined || absolute(w.projectRoot)) &&
  (w.status === "active" || w.status === "inactive");
const validThread = (t: unknown, name: string): t is ThreadRecord =>
  isRecord(t) &&
  typeof t.id === "string" &&
  uuid.test(t.id) &&
  name === `${t.id}.json` &&
  absolute(t.workspace) &&
  typeof t.name === "string" &&
  t.name.length > 0 &&
  t.name.length <= 200 &&
  (t.owner === undefined || t.owner === "host") &&
  typeof t.updatedAt === "string" &&
  Number.isFinite(Date.parse(t.updatedAt)) &&
  ["idle", "running", "waiting", "error"].includes(String(t.status)) &&
  (t.unread === undefined || typeof t.unread === "boolean");

// oxlint-disable-next-line typescript/strict-void-return -- Node's execFile returns a process in addition to invoking its callback
const run = promisify(execFile);
export const directory = path.join(
  homedir(),
  "Library/Application Support/Code/User/globalStorage/digital-overground.mischief/profile-db-v1"
);
// oxlint-disable eslint/no-await-in-loop -- bounded profile records are read sequentially like the extension database
const records = async <T>(
  root: string,
  folder: string,
  valid: (value: unknown, name: string) => value is T
): Promise<T[]> => {
  let files;
  try {
    files = await readdir(path.join(root, folder));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const result = [];
  for (const name of files.filter((file) => file.endsWith(".json"))) {
    try {
      const file = path.join(root, folder, name);
      const stats = await stat(file);
      if (stats.size > 8 * 1024 * 1024) {
        continue;
      }
      const record: unknown = JSON.parse(await readFile(file, "utf-8"));
      if (
        isRecord(record) &&
        record.version === 1 &&
        Number.isSafeInteger(record.writtenAt) &&
        valid(record, name)
      ) {
        result.push(record);
      }
    } catch (error) {
      if (!isErrorCode(error, "ENOENT") && !(error instanceof SyntaxError)) {
        console.error(`Ignoring ${folder} record ${name}: ${String(error)}`);
      }
    }
  }
  return result;
};

const writeWorkspace = async (
  root: string,
  record: WorkspaceRecord
): Promise<void> => {
  const folder = path.join(root, "workspaces");
  await mkdir(folder, { recursive: true });
  const filename = path.join(
    folder,
    `${createHash("sha256").update(record.path).digest("hex")}.json`
  );
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...record, version: 1, writtenAt: Date.now() })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

export const activateWorkspace = async (
  folder: string,
  root = directory
): Promise<void> => {
  let selected = await realpath(folder);
  const selectedStats = await stat(selected);
  if (!selectedStats.isDirectory()) {
    throw new Error("Workspace must be a folder");
  }
  let projectRoot;
  try {
    const [{ stdout: commonPath }, { stdout: checkout }] = await Promise.all([
      run(
        "git",
        [
          "-C",
          selected,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        {
          timeout: 5000,
        }
      ),
      run("git", ["-C", selected, "rev-parse", "--show-toplevel"], {
        timeout: 5000,
      }),
    ]);
    selected = await realpath(checkout.trim());
    const common = await realpath(commonPath.trim());
    // shortcut: uncommon separate Git directories use the selected checkout as Project; revisit with full Git discovery in Phase 2.
    projectRoot =
      path.basename(common) === ".git" ? path.dirname(common) : selected;
  } catch (error) {
    if (!isErrorCode(error, 128) && !isErrorCode(error, 1)) {
      console.error(`Git discovery unavailable: ${String(error)}`);
    }
  }
  await writeWorkspace(root, {
    path: selected,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    status: "active",
  });
};

// shortcut: deactivation hides the Workspace but cannot close its VS Code window; upgrade when cross-client window control exists.
export const deactivateWorkspace = async (
  workspace: string,
  root = directory
): Promise<void> => {
  if (!absolute(workspace)) {
    throw new Error("Invalid Workspace path");
  }
  const workspaces = await records(root, "workspaces", validWorkspace);
  const current = workspaces.find((w) => w.path === workspace);
  if (!current || current.status !== "active") {
    throw new Error("Workspace is not active");
  }
  await writeWorkspace(root, {
    path: workspace,
    ...(current.projectRoot === undefined
      ? {}
      : { projectRoot: current.projectRoot }),
    status: "inactive",
  });
};

export const selectThread = async (
  workspace: string,
  threadId: string,
  root = directory
): Promise<void> => {
  // oxlint-disable-next-line no-use-before-define -- selection is called only after module initialization
  const current = await snapshot(root);
  if (
    !absolute(workspace) ||
    !uuid.test(threadId) ||
    !current.workspaces.some(
      (w) => w.path === workspace && w.threads.some((t) => t.id === threadId)
    )
  ) {
    throw new Error("Thread is not in an active Workspace");
  }
  const folder = path.join(root, "selections");
  await mkdir(folder, { recursive: true });
  const filename = path.join(
    folder,
    `${createHash("sha256").update(workspace).digest("hex")}.json`
  );
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({
        focusRequest: randomUUID(),
        threadId,
        version: 1,
        workspace,
        writtenAt: Date.now(),
      })}\n`,
      { mode: 0o600 }
    );
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

export const snapshot = async (root = directory) => {
  const [workspaces, threads] = await Promise.all([
    records(root, "workspaces", validWorkspace),
    records(root, "threads", validThread),
  ]);
  const active = [];
  for (const workspace of workspaces) {
    if (workspace.status !== "active") {
      continue;
    }
    try {
      const stats = await stat(workspace.path);
      if (!stats.isDirectory()) {
        continue;
      }
      // Canonical paths are the identity in the extension database.
      const canonical = await realpath(workspace.path);
      if (canonical !== workspace.path) {
        continue;
      }
      active.push(workspace);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        console.error(
          `Workspace unavailable: ${workspace.path}: ${String(error)}`
        );
      }
    }
  }
  const listed = new Set(active.map((w) => w.path));
  const entries = active
    .map((w) => ({
      name: path.basename(w.path),
      path: w.path,
      projectRoot: w.projectRoot ?? null,
      threads: threads
        .filter((t) => t.workspace === w.path)
        .map((t) => ({
          id: t.id,
          name: t.name,
          owner: t.owner,

          status: t.status,
          unread: t.unread === true,
          updatedAt: t.updatedAt,
        }))
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const attention = threads.filter(
    (t) =>
      listed.has(t.workspace) &&
      (t.status === "waiting" ||
        t.status === "error" ||
        (t.status !== "running" && t.unread === true))
  );
  return {
    attention: attention.length,
    attentionIds: attention.map((t) => t.id),
    type: "library",
    workspaces: entries,
  };
};
