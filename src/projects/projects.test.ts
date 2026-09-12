import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ProfileDatabase } from "../profile-database/profile-database";
import { locateWorkspace, Projects } from "./projects";

const exec = promisify(execFile);
const log = vi.fn<(message: string) => void>();
const profileDatabases: ProfileDatabase[] = [];
const temporaryFolders: string[] = [];

const temporaryFolder = async (): Promise<string> => {
  const folder = await mkdtemp("/tmp/mischief-");
  temporaryFolders.push(folder);
  return folder;
};

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await exec("git", ["-C", cwd, ...args]);
};

const openProfileDatabase = async (
  profileDirectory?: string,
  currentWorkspace?: string
): Promise<ProfileDatabase> => {
  const directory = profileDirectory ?? (await temporaryFolder());
  const database = await ProfileDatabase.open({
    currentWorkspace: currentWorkspace ?? path.join(directory, "workspace"),
    instanceId: randomUUID(),
    log,
    profileDirectory: directory,
  });
  profileDatabases.push(database);
  return database;
};

const createProjects = async (currentWorkspace?: string): Promise<Projects> =>
  new Projects(
    await openProfileDatabase(
      undefined,
      currentWorkspace ? await realpath(currentWorkspace) : undefined
    )
  );

describe("projects module", () => {
  afterEach(async () => {
    await Promise.all(
      profileDatabases.splice(0).map((database) => database.dispose())
    );
    await Promise.all(
      temporaryFolders
        .splice(0)
        .map((folder) => rm(folder, { force: true, recursive: true }))
    );
  });

  test("refresh hides a missing untracked Workspace without changing its status", async () => {
    const folder = await temporaryFolder();
    const projects = await createProjects();
    await projects.add(folder);

    await rm(folder, { recursive: true });
    let snapshot = await projects.refresh();
    expect(snapshot.ungrouped).toStrictEqual([]);
    await mkdir(folder);
    snapshot = await projects.refresh();
    expect(snapshot.ungrouped).toHaveLength(1);
  });

  test("the owning window can make its current Workspace inactive", async () => {
    const folder = await temporaryFolder();
    const projects = await createProjects(folder);

    await projects.open(folder);
    const inactive = await projects.remove(folder);
    expect(inactive.ungrouped).toStrictEqual([]);
    const reopened = await projects.open(folder);
    expect(reopened.ungrouped).toHaveLength(1);
  });

  test("another window can make an active Workspace inactive", async () => {
    const folder = await temporaryFolder();
    const owner = await createProjects(folder);
    const other = await createProjects();
    await owner.open(folder);

    const snapshot = await other.remove(folder);

    expect(snapshot.ungrouped).toStrictEqual([]);
  });

  test("locates a nested folder at its Git Workspace root", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    const nested = path.join(root, "src", "nested");
    await git(parent, "init", "--initial-branch=main", root);
    await mkdir(nested, { recursive: true });

    await expect(locateWorkspace(nested)).resolves.toMatchObject({
      path: await realpath(root),
      projectRoot: await realpath(root),
    });
  });

  test("opening a folder adds and marks its Workspace as current", async () => {
    const folder = await temporaryFolder();
    const projects = await createProjects();
    const canonicalFolder = await realpath(folder);

    const snapshot = await projects.open(folder);

    expect(snapshot.ungrouped).toMatchObject([
      { current: true, path: canonicalFolder },
    ]);
  });

  test("adding an untracked folder creates an ungrouped Workspace", async () => {
    const folder = await temporaryFolder();
    const projects = await createProjects();
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
    const projects = await createProjects();
    await projects.add(root);
    await projects.add(linked);

    await rm(linked, { recursive: true });

    const snapshot = await projects.refresh();
    expect(snapshot.projects[0]?.workspaces).toMatchObject([
      { path: await realpath(root) },
    ]);
  });

  test("refresh does not activate a newly created linked Workspace", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    const linked = path.join(parent, "later-worktree");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const projects = await createProjects();
    await projects.add(root);

    await git(root, "worktree", "add", "-b", "later", linked);

    const snapshot = await projects.refresh();
    expect(snapshot.projects[0]?.workspaces).toHaveLength(1);
  });

  test("creates a normalized branch in the sibling worktrees directory", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const projects = await createProjects();
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

  test("imports missing previous Workspaces without replacing database records", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    const linked = path.join(parent, "feature-worktree");
    const untracked = await temporaryFolder();
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    await git(root, "worktree", "add", "-b", "feature", linked);
    const canonicalRoot = await realpath(root);
    const database = await openProfileDatabase(undefined, canonicalRoot);
    const projects = new Projects(database);
    await database.apply({
      type: "activateWorkspace",
      workspace: { path: canonicalRoot, projectRoot: canonicalRoot },
    });
    await database.apply({
      path: canonicalRoot,
      type: "deactivateWorkspace",
    });

    await projects.importPreviousWorkspaces({
      roots: [root],
      ungrouped: [untracked],
    });

    const snapshot = await projects.refresh();
    expect(
      snapshot.projects[0]?.workspaces.map((workspace) => workspace.path)
    ).toStrictEqual([await realpath(linked)]);
    expect(snapshot.ungrouped).toHaveLength(1);
    expect(
      database
        .snapshot()
        .workspaces.find((workspace) => workspace.path === canonicalRoot)
        ?.status
    ).toBe("inactive");
  });

  test("Git Workspace activated in one Instance appears when another Instance refreshes", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const canonicalRoot = await realpath(root);
    const profileDirectory = await temporaryFolder();
    vi.useFakeTimers();
    const firstDatabase = await openProfileDatabase(
      profileDirectory,
      canonicalRoot
    );
    const secondDatabase = await openProfileDatabase(
      profileDirectory,
      path.join(profileDirectory, "second-workspace")
    );

    try {
      const first = new Projects(firstDatabase);
      const second = new Projects(secondDatabase);
      await first.add(root);
      await vi.advanceTimersByTimeAsync(1000);

      await vi.waitFor(async () => {
        const snapshot = await second.refresh();
        expect(snapshot.projects).toMatchObject([{ root: canonicalRoot }]);
      });
    } finally {
      await Promise.all([firstDatabase.dispose(), secondDatabase.dispose()]);
      vi.useRealTimers();
    }
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

    const projects = await createProjects();
    const snapshot = await projects.add(linked);
    const canonicalRoot = await realpath(root);
    const canonicalLinked = await realpath(linked);

    expect(snapshot.projects).toMatchObject([
      {
        name: "mischief",
        root: canonicalRoot,
        workspaces: [
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
