import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

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

const run = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
  });
  return stdout.trim();
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
    return workspacePath
      ? [{ path: workspacePath, ...(branch ? { branch } : {}) }]
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
