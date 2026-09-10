import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import type { ProjectsStorage } from "./projects";
import { Projects } from "./projects";

const exec = promisify(execFile);
const temporaryFolders: string[] = [];

const temporaryFolder = async (): Promise<string> => {
  const folder = await mkdtemp("/tmp/mischief-");
  temporaryFolders.push(folder);
  return folder;
};

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await exec("git", ["-C", cwd, ...args]);
};

class MemoryStorage implements ProjectsStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

describe("projects module", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryFolders
        .splice(0)
        .map((folder) => rm(folder, { force: true, recursive: true }))
    );
  });

  test("refresh removes membership for a missing untracked Workspace", async () => {
    const folder = await temporaryFolder();
    const projects = new Projects(new MemoryStorage());
    await projects.add(folder);

    await rm(folder, { recursive: true });
    let snapshot = await projects.refresh();
    expect(snapshot.ungrouped).toStrictEqual([]);
    await mkdir(folder);
    snapshot = await projects.refresh();
    expect(snapshot.ungrouped).toStrictEqual([]);
  });

  test("an explicitly removed Workspace stays unmanaged until it is added", async () => {
    const folder = await temporaryFolder();
    const projects = new Projects(new MemoryStorage());

    await projects.open(folder);
    const removed = await projects.remove(folder);
    expect(removed.ungrouped).toStrictEqual([]);
    const reopened = await projects.open(folder);
    expect(reopened.ungrouped).toStrictEqual([]);
    const added = await projects.add(folder);
    expect(added.ungrouped).toHaveLength(1);
  });

  test("opening a folder adds and marks its Workspace as current", async () => {
    const folder = await temporaryFolder();
    const projects = new Projects(new MemoryStorage());
    const canonicalFolder = await realpath(folder);

    const snapshot = await projects.open(folder);

    expect(snapshot.ungrouped).toMatchObject([
      { current: true, path: canonicalFolder },
    ]);
  });

  test("adding a non-Git folder creates an ungrouped Workspace", async () => {
    const folder = await temporaryFolder();
    const projects = new Projects(new MemoryStorage());
    const canonicalFolder = await realpath(folder);

    const snapshot = await projects.add(folder);

    expect(snapshot.projects).toStrictEqual([]);
    expect(snapshot.ungrouped).toMatchObject([
      {
        linked: false,
        name: path.basename(folder),
        path: canonicalFolder,
      },
    ]);
  });

  test("refresh drops a deleted linked Workspace without dropping its Project", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    const linked = path.join(parent, "deleted-worktree");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    await git(root, "worktree", "add", "-b", "deleted", linked);
    const projects = new Projects(new MemoryStorage());
    await projects.add(root);

    await rm(linked, { recursive: true });

    const snapshot = await projects.refresh();
    expect(snapshot.projects[0]?.workspaces).toMatchObject([
      { path: await realpath(root) },
    ]);
  });

  test("refresh discovers a newly created linked Workspace", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    const linked = path.join(parent, "later-worktree");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const projects = new Projects(new MemoryStorage());
    await projects.add(root);

    await git(root, "worktree", "add", "-b", "later", linked);

    const snapshot = await projects.refresh();
    expect(snapshot.projects[0]?.workspaces).toHaveLength(2);
  });

  test("creates a normalized branch in the sibling worktrees directory", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const projects = new Projects(new MemoryStorage());
    await projects.add(root);

    await expect(projects.createWorkspace(root, "../escape")).rejects.toThrow(
      "without slashes"
    );
    const workspace = await projects.createWorkspace(root, "My New Thing");
    const expected = await realpath(
      path.join(parent, "worktrees", "mischief-my-new-thing")
    );
    const { stdout: branch } = await exec("git", [
      "-C",
      workspace,
      "branch",
      "--show-current",
    ]);

    expect({ branch: branch.trim(), workspace }).toStrictEqual({
      branch: "my-new-thing",
      workspace: expected,
    });
    const snapshot = await projects.refresh();
    expect(snapshot.projects[0]?.workspaces).toContainEqual(
      expect.objectContaining({
        branch: "my-new-thing",
        path: expected,
      })
    );
  });

  test("adding a Git Workspace discovers its Project and linked Workspaces", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    const linked = path.join(parent, "feature-worktree");

    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    await git(root, "worktree", "add", "-b", "feature", linked);

    const projects = new Projects(new MemoryStorage());
    const snapshot = await projects.add(linked);
    const canonicalRoot = await realpath(root);
    const canonicalLinked = await realpath(linked);

    expect(snapshot.projects).toMatchObject([
      {
        name: "mischief",
        root: canonicalRoot,
        workspaces: [
          {
            branch: "main",
            linked: false,
            name: "mischief",
            path: canonicalRoot,
          },
          {
            branch: "feature",
            linked: true,
            name: "feature-worktree",
            path: canonicalLinked,
          },
        ],
      },
    ]);
    expect(snapshot.ungrouped).toStrictEqual([]);
  });
});
