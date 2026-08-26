import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { Projects, type ProjectsStorage } from "./projects";

const exec = promisify(execFile);
const temporaryFolders: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

test("refresh removes membership for a missing standalone Workspace", async () => {
  const folder = await temporaryFolder();
  const projects = new Projects(new MemoryStorage());
  await projects.add(folder);

  await rm(folder, { recursive: true });
  expect((await projects.refresh()).ungrouped).toEqual([]);
  await mkdir(folder);
  expect((await projects.refresh()).ungrouped).toEqual([]);
});

test("an explicitly removed Workspace stays unmanaged until it is added", async () => {
  const folder = await temporaryFolder();
  const projects = new Projects(new MemoryStorage());

  await projects.open(folder);
  expect((await projects.remove(folder)).ungrouped).toEqual([]);
  expect((await projects.open(folder)).ungrouped).toEqual([]);
  expect((await projects.add(folder)).ungrouped).toHaveLength(1);
});

test("opening a folder adds and marks its Workspace as current", async () => {
  const folder = await temporaryFolder();
  const projects = new Projects(new MemoryStorage());

  const snapshot = await projects.open(folder);

  expect(snapshot.ungrouped).toMatchObject([{ path: await realpath(folder), current: true }]);
});

test("adding a non-Git folder creates an ungrouped Workspace", async () => {
  const folder = await temporaryFolder();
  const projects = new Projects(new MemoryStorage());

  const snapshot = await projects.add(folder);

  expect(snapshot.projects).toEqual([]);
  expect(snapshot.ungrouped).toMatchObject([
    { name: path.basename(folder), path: await realpath(folder), linked: false },
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

  expect((await projects.refresh()).projects[0]?.workspaces).toMatchObject([
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

  expect((await projects.refresh()).projects[0]?.workspaces).toHaveLength(2);
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
        { name: "mischief", path: canonicalRoot, branch: "main", linked: false },
        { name: "feature-worktree", path: canonicalLinked, branch: "feature", linked: true },
      ],
    },
  ]);
  expect(snapshot.ungrouped).toEqual([]);
});

async function temporaryFolder(): Promise<string> {
  const folder = await mkdtemp("/tmp/mischief-");
  temporaryFolders.push(folder);
  return folder;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", cwd, ...args]);
}

class MemoryStorage implements ProjectsStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}
