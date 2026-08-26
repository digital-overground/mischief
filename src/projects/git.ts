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

export async function discoverGitProject(folder: string): Promise<GitProject | undefined> {
  try {
    const workspace = await run(folder, "rev-parse", "--show-toplevel");
    const records = parseWorktrees(await run(workspace, "worktree", "list", "--porcelain"));
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
            path: workspacePath,
            branch: record.branch,
            linked: workspacePath !== root,
            changes,
            ...divergence,
          };
        } catch {
          return undefined;
        }
      }),
    );
    const workspaces = inspected.filter((workspace) => workspace !== undefined);
    workspaces.sort(
      (a, b) =>
        Number(a.linked) - Number(b.linked) ||
        path.basename(a.path).localeCompare(path.basename(b.path)),
    );
    return { root, workspaces };
  } catch {
    return undefined;
  }
}

async function run(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function parseWorktrees(output: string): Array<{ path: string; branch?: string }> {
  return output.split(/\n\n+/).flatMap((block) => {
    const lines = block.split("\n");
    const workspacePath = lines.find((line) => line.startsWith("worktree "))?.slice(9);
    const branch = lines
      .find((line) => line.startsWith("branch "))
      ?.slice(7)
      .replace(/^refs\/heads\//, "");
    return workspacePath ? [{ path: workspacePath, ...(branch ? { branch } : {}) }] : [];
  });
}

function countLines(output: string): number {
  return output ? output.split("\n").length : 0;
}

async function divergenceFromUpstream(cwd: string): Promise<{ ahead: number; behind: number }> {
  try {
    const [behind, ahead] = (
      await run(cwd, "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
    )
      .split(/\s+/)
      .map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}
