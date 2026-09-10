import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ProfileSync } from "../profile-sync/profile-sync";
import { Projects } from "./projects";

const exec = promisify(execFile);
const log = vi.fn<(message: string) => void>();
const profileSyncs: ProfileSync[] = [];
const temporaryFolders: string[] = [];

const temporaryFolder = async (): Promise<string> => {
  const folder = await mkdtemp("/tmp/mischief-");
  temporaryFolders.push(folder);
  return folder;
};

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await exec("git", ["-C", cwd, ...args]);
};

const openProfileSync = async (
  profileDirectory?: string,
  workspace?: string
): Promise<ProfileSync> => {
  const directory = profileDirectory ?? (await temporaryFolder());
  const sync = await ProfileSync.open({
    instanceId: randomUUID(),
    log,
    profileDirectory: directory,
    workspace: workspace ?? path.join(directory, "workspace"),
  });
  profileSyncs.push(sync);
  return sync;
};

const createProjects = async (): Promise<Projects> =>
  new Projects(await openProfileSync());

describe("projects module", () => {
  afterEach(async () => {
    await Promise.all(profileSyncs.splice(0).map((sync) => sync.dispose()));
    await Promise.all(
      temporaryFolders
        .splice(0)
        .map((folder) => rm(folder, { force: true, recursive: true }))
    );
  });

  test("refresh removes membership for a missing untracked Workspace", async () => {
    const folder = await temporaryFolder();
    const projects = await createProjects();
    await projects.add(folder);

    await rm(folder, { recursive: true });
    let snapshot = await projects.refresh();
    expect(snapshot.ungrouped).toStrictEqual([]);
    await mkdir(folder);
    snapshot = await projects.refresh();
    expect(snapshot.ungrouped).toStrictEqual([]);
  });

  test("an explicitly removed Workspace stays removed until it is added", async () => {
    const folder = await temporaryFolder();
    const projects = await createProjects();

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
    const projects = await createProjects();
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

  test("Project membership added in one Instance appears when another Instance refreshes", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const canonicalRoot = await realpath(root);
    const profileDirectory = await temporaryFolder();
    vi.useFakeTimers();
    const firstSync = await openProfileSync(profileDirectory, canonicalRoot);
    const secondSync = await openProfileSync(
      profileDirectory,
      path.join(profileDirectory, "second-workspace")
    );

    try {
      const first = new Projects(firstSync);
      const second = new Projects(secondSync);
      await first.add(root);
      await vi.advanceTimersByTimeAsync(1000);

      await vi.waitFor(async () => {
        const snapshot = await second.refresh();
        expect(snapshot.projects).toMatchObject([{ root: canonicalRoot }]);
      });
    } finally {
      await Promise.all([firstSync.dispose(), secondSync.dispose()]);
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
