import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { exec } from "../exec";
import { isNonEmpty } from "../present";

const ISSUE_REPOSITORY_KEY = "mischief.githubIssueRepo";

export interface GitProject {
  root: string;
  workspaces: GitWorkspace[];
}

export interface GitWorkspace {
  path: string;
  branch?: string;
  linked: boolean;
  changes: number;
  ahead: number;
  behind: number;
}

export interface GitSourceBranch {
  name: string;
  current: boolean;
  remoteOnly: boolean;
  ahead?: number;
  behind?: number;
}

const run = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
};

export const normalizeGitHubRepository = (
  value: string
): string | undefined => {
  const repository = value.trim();
  return /^[\w.-]+\/[\w.-]+$/u.test(repository) ? repository : undefined;
};

export const getGitHubIssueRepository = async (
  root: string
): Promise<{ configured: boolean; repository: string }> => {
  const configured = await run(
    root,
    "config",
    "--local",
    "--get",
    ISSUE_REPOSITORY_KEY
  ).catch(() => "");
  if (configured) {
    const repository = normalizeGitHubRepository(configured);
    if (!isNonEmpty(repository)) {
      throw new Error(
        `Git config ${ISSUE_REPOSITORY_KEY} must be an owner/repo`
      );
    }
    return { configured: true, repository };
  }

  let remote: string;
  try {
    remote = await run(root, "remote", "get-url", "origin");
  } catch (error) {
    throw new Error(
      "Could not determine the Project's main GitHub repository from origin",
      { cause: error }
    );
  }
  const repository = normalizeGitHubRepository(
    /[/:](?<repository>[^/:\s]+\/[^/\s]+?)(?:\.git)?\/?$/u.exec(remote)?.groups
      ?.repository ?? ""
  );
  if (!isNonEmpty(repository)) {
    throw new Error(
      "Could not determine the Project's main GitHub repository from origin"
    );
  }
  return { configured: false, repository };
};

export const setGitHubIssueRepository = async (
  root: string,
  repository: string
): Promise<void> => {
  await run(root, "config", "--local", ISSUE_REPOSITORY_KEY, repository);
};

export const sourceBranches = async (
  root: string
): Promise<GitSourceBranch[]> => {
  const output = await run(
    root,
    "for-each-ref",
    "--format=%(refname)%00%(HEAD)%00%(symref)",
    "refs/heads",
    "refs/remotes/origin"
  );
  const refs = output
    .split("\n")
    .map((line) => line.split("\0"))
    .filter((fields) => !fields[2]);
  const locals = refs
    .filter(([ref]) => ref?.startsWith("refs/heads/"))
    .map(([ref, current]) => ({
      current: current === "*",
      name: ref?.slice("refs/heads/".length) ?? "",
      remoteOnly: false as const,
    }))
    .toSorted(
      (a, b) =>
        Number(b.current) - Number(a.current) || a.name.localeCompare(b.name)
    );
  const remotes = refs
    .filter(([ref]) => ref?.startsWith("refs/remotes/origin/"))
    .map(([ref]) => `origin/${ref?.slice("refs/remotes/origin/".length)}`);
  const remoteNames = new Set(remotes);
  const localNames = new Set(locals.map(({ name }) => name));
  const localBranches = await Promise.all(
    locals.map(async (branch): Promise<GitSourceBranch> => {
      if (!remoteNames.has(`origin/${branch.name}`)) {
        return branch;
      }
      const divergence = await run(
        root,
        "rev-list",
        "--left-right",
        "--count",
        `origin/${branch.name}...${branch.name}`
      );
      const [behind, ahead] = divergence.split(/\s+/u).map(Number);
      return { ...branch, ahead: ahead ?? 0, behind: behind ?? 0 };
    })
  );
  return [
    ...localBranches,
    ...remotes
      .filter((name) => !localNames.has(name.slice("origin/".length)))
      .toSorted((a, b) => a.localeCompare(b))
      .map((name) => ({ current: false, name, remoteOnly: true as const })),
  ];
};

const systemFile = (name: string): boolean =>
  [".DS_Store", "Thumbs.db", "desktop.ini", ".vscode"].includes(name) ||
  name.startsWith("._");

export const ignoredWorkspaceFiles = async (
  root: string
): Promise<string[]> => {
  const { stdout } = await exec("git", [
    "-C",
    root,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  const entries = await Promise.all(
    stdout
      .split("\0")
      .filter(Boolean)
      .map(async (name) => {
        if (name.split("/").some(systemFile)) {
          return null;
        }
        try {
          const entry = await lstat(path.join(root, name));
          if (name.endsWith("/")) {
            if (!entry.isDirectory()) {
              return null;
            }
            await exec("git", ["-C", root, "check-ignore", "-q", "--", name]);
            return name;
          }
          return entry.isFile() ? name : null;
        } catch {
          return null;
        }
      })
  );
  return entries
    .filter((name) => name !== null)
    .toSorted(
      (a, b) =>
        Number(a.endsWith("/")) - Number(b.endsWith("/")) || a.localeCompare(b)
    );
};

export const copyIgnoredWorkspaceFiles = async (
  root: string,
  workspace: string,
  files: string[]
): Promise<void> => {
  const targetRoot = await realpath(workspace);
  const copy = async (name: string): Promise<void> => {
    const source = path.resolve(root, name);
    const destination = path.resolve(targetRoot, name);
    if (
      !source.startsWith(`${root}${path.sep}`) ||
      !destination.startsWith(`${targetRoot}${path.sep}`) ||
      name.split(/[\\/]/u).some(systemFile)
    ) {
      throw new Error(`Invalid ignored file: ${name}`);
    }
    const entry = await lstat(source);
    // Never follow source symlinks.
    if (!entry.isFile() && !entry.isDirectory()) {
      return;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const parent = await realpath(path.dirname(destination));
    if (
      parent !== targetRoot &&
      !parent.startsWith(`${targetRoot}${path.sep}`)
    ) {
      throw new Error(`Invalid destination: ${name}`);
    }
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      const children = await readdir(source);
      await Promise.all(
        children
          .filter((child) => !systemFile(child))
          .map(async (child) => {
            await copy(path.join(name, child));
          })
      );
    } else {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    }
  };
  await Promise.all(files.map(copy));
};

export const createGitWorkspace = async (
  root: string,
  branch: string,
  sourceRef?: string
): Promise<string> => {
  try {
    await run(root, "check-ref-format", "--branch", branch);
  } catch {
    throw new Error(`"${branch}" is not a valid Git branch name`);
  }
  const workspace = path.join(
    path.dirname(root),
    "worktrees",
    `${path.basename(root)}-${branch}`
  );
  await mkdir(path.dirname(workspace), { recursive: true });
  await run(
    root,
    "worktree",
    "add",
    "-b",
    branch,
    workspace,
    ...(isNonEmpty(sourceRef) ? [sourceRef] : [])
  );
  return await realpath(workspace);
};

const parseWorktrees = (output: string): { path: string; branch?: string }[] =>
  output.split(/\n\n+/u).flatMap((block) => {
    const lines = block.split("\n");
    const workspacePath = lines
      .find((line) => line.startsWith("worktree "))
      ?.slice(9);
    const branch = lines
      .find((line) => line.startsWith("branch "))
      ?.slice(7)
      .replace(/^refs\/heads\//u, "");
    return isNonEmpty(workspacePath)
      ? [{ path: workspacePath, ...(isNonEmpty(branch) ? { branch } : {}) }]
      : [];
  });

const countLines = (output: string): number =>
  output ? output.split("\n").length : 0;

const divergenceFromUpstream = async (
  cwd: string
): Promise<{ ahead: number; behind: number }> => {
  try {
    const result = await run(
      cwd,
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD"
    );
    const [behind, ahead] = result.split(/\s+/u).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
};

export const discoverGitProject = async (
  folder: string
): Promise<GitProject | undefined> => {
  try {
    const workspace = await run(folder, "rev-parse", "--show-toplevel");
    const records = parseWorktrees(
      await run(workspace, "worktree", "list", "--porcelain")
    );
    const root = await realpath(records[0]?.path ?? workspace);
    const inspected = await Promise.all(
      records.map(async (record): Promise<GitWorkspace | undefined> => {
        try {
          const workspacePath = await realpath(record.path);
          const [changes, divergence] = await Promise.all([
            run(workspacePath, "status", "--porcelain").then(countLines),
            divergenceFromUpstream(workspacePath),
          ]);
          return {
            branch: record.branch,
            changes,
            linked: workspacePath !== root,
            path: workspacePath,
            ...divergence,
          };
        } catch {
          return undefined;
        }
      })
    );
    const workspaces = inspected
      .filter((candidate) => candidate !== undefined)
      .toSorted(
        (a, b) =>
          Number(a.linked) - Number(b.linked) ||
          path.basename(a.path).localeCompare(path.basename(b.path))
      );
    return { root, workspaces };
  } catch {
    return undefined;
  }
};
