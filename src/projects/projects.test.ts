import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { exec } from "../exec";
import { isNonEmpty } from "../present";
import { ProfileDatabase } from "../profile-database/profile-database";
import { issueWorkspaceName, locateWorkspace, Projects } from "./projects";

const log = vi.fn<(message: string) => void>();
const profileDatabases: ProfileDatabase[] = [];
const temporaryFolders: string[] = [];
const originalPath = process.env.PATH;

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

const gitOutput = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await exec("git", ["-C", cwd, ...args]);
  return stdout.trim();
};

const unexpectedRepositoryChoice = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("repository should already be configured");
};

const fakeGitHubCli = async (
  cwd: string,
  output: string,
  repository = "example/project"
): Promise<void> => {
  const bin = await temporaryFolder();
  const executable = path.join(bin, "gh");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const expected = "issue list --repo " + process.env.MISCHIEF_EXPECTED_REPO + " --state open --limit 1000 --json number,title,url";
if (process.argv.slice(2).join(" ") !== expected || process.cwd() !== process.env.MISCHIEF_EXPECTED_CWD) {
  process.stderr.write("unexpected gh invocation");
  process.exit(1);
}
if (process.env.MISCHIEF_GH_ERROR) {
  process.stderr.write(process.env.MISCHIEF_GH_ERROR);
  process.exit(1);
}
process.stdout.write(process.env.MISCHIEF_GH_OUTPUT ?? "");
`
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  process.env.MISCHIEF_EXPECTED_CWD = cwd;
  process.env.MISCHIEF_EXPECTED_REPO = repository;
  process.env.MISCHIEF_GH_OUTPUT = output;
};

const createProjects = async (currentWorkspace?: string): Promise<Projects> =>
  new Projects(
    await openProfileDatabase(
      undefined,
      isNonEmpty(currentWorkspace)
        ? await realpath(currentWorkspace)
        : undefined
    )
  );

describe("projects module", () => {
  afterEach(async () => {
    process.env.PATH = originalPath;
    delete process.env.MISCHIEF_EXPECTED_CWD;
    delete process.env.MISCHIEF_EXPECTED_REPO;
    delete process.env.MISCHIEF_GH_ERROR;
    delete process.env.MISCHIEF_GH_OUTPUT;
    await Promise.all(
      profileDatabases.splice(0).map(async (database) => {
        await database.dispose();
      })
    );
    await Promise.all(
      temporaryFolders.splice(0).map(async (folder) => {
        await rm(folder, { force: true, recursive: true });
      })
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

  test("configures and lists validated open GitHub issues for a managed Project", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(
      root,
      "remote",
      "add",
      "origin",
      "git@github.com:owner/mischief.git"
    );
    const projects = await createProjects();
    await projects.add(root);
    await fakeGitHubCli(
      await realpath(root),
      JSON.stringify([
        { number: 6, title: "First issue", url: "https://example.test/6" },
        { number: 9, title: "Second issue", url: "https://example.test/9" },
      ]),
      "atomicobject/issues"
    );
    const chooseRepository = vi.fn<(repository: string) => Promise<string>>(
      async (repository) => {
        await Promise.resolve();
        expect(repository).toBe("owner/mischief");
        return "atomicobject/issues";
      }
    );

    await expect(
      projects.listOpenIssues(root, chooseRepository)
    ).resolves.toStrictEqual([
      { number: 6, title: "First issue", url: "https://example.test/6" },
      { number: 9, title: "Second issue", url: "https://example.test/9" },
    ]);
    await expect(
      gitOutput(root, "config", "--local", "--get", "mischief.githubIssueRepo")
    ).resolves.toBe("atomicobject/issues");

    process.env.MISCHIEF_GH_OUTPUT = "not JSON";
    await expect(
      projects.listOpenIssues(root, chooseRepository)
    ).rejects.toThrow("issue list could not be read");

    process.env.MISCHIEF_GH_OUTPUT = JSON.stringify([
      { number: 0, title: "Broken", url: "http://example.test/0" },
    ]);
    await expect(
      projects.listOpenIssues(root, chooseRepository)
    ).rejects.toThrow("invalid GitHub issue");
    expect(chooseRepository).toHaveBeenCalledOnce();
  });

  test("explains missing and unauthenticated GitHub CLI failures", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(
      root,
      "config",
      "--local",
      "mischief.githubIssueRepo",
      "example/project"
    );
    const projects = await createProjects();
    await projects.add(root);
    const { stdout: gitExecutable } = await exec("which", ["git"]);
    const gitOnlyPath = await temporaryFolder();
    await symlink(gitExecutable.trim(), path.join(gitOnlyPath, "git"));
    process.env.PATH = gitOnlyPath;

    await expect(
      projects.listOpenIssues(root, unexpectedRepositoryChoice)
    ).rejects.toThrow("GitHub CLI (gh) is required");

    await fakeGitHubCli(await realpath(root), "[]");
    process.env.MISCHIEF_GH_ERROR = "authentication required for github.test";
    await expect(
      projects.listOpenIssues(root, unexpectedRepositoryChoice)
    ).rejects.toThrow(
      /authentication required for github\.test[\s\S]*gh auth login[\s\S]*gh auth refresh/u
    );
  });

  test.each([
    [123, "Improve Workspace creation", "issue-123_improve-workspace-creation"],
    [2, "Fix API / branch... creation!", "issue-2_fix-api-branch-creation"],
    [3, "MIXED case", "issue-3_mixed-case"],
    [4, "!!!", "issue-4"],
    [
      123,
      "abcdefghijklmnopqrstuvwxyz 1234567890 extra",
      "issue-123_abcdefghijklmnopqrstuvwxyz-1234567890-ex",
    ],
    [
      7,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa more",
      "issue-7_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
  ])(
    "generates the issue Workspace name for #%i",
    (number, title, expected) => {
      expect(
        issueWorkspaceName({ number, title, url: "https://example.test/issue" })
      ).toBe(expected);
    }
  );

  test("lists current, local, and remote-only source branches", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const initial = await gitOutput(root, "rev-parse", "HEAD");
    await git(root, "branch", "zebra", initial);
    await git(root, "branch", "alpha", initial);
    await git(root, "commit", "--allow-empty", "--message=local-main");
    const tree = await gitOutput(root, "rev-parse", `${initial}^{tree}`);
    const remoteMain = await gitOutput(
      root,
      "commit-tree",
      tree,
      "-p",
      initial,
      "-m",
      "remote-main"
    );
    await git(root, "update-ref", "refs/remotes/origin/main", remoteMain);
    await git(root, "update-ref", "refs/remotes/origin/release", initial);
    await git(
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main"
    );
    const projects = await createProjects();
    await projects.add(root);

    await expect(projects.sourceBranches(root)).resolves.toStrictEqual([
      {
        ahead: 1,
        behind: 1,
        current: true,
        name: "main",
        remoteOnly: false,
      },
      { current: false, name: "alpha", remoteOnly: false },
      { current: false, name: "zebra", remoteOnly: false },
      { current: false, name: "origin/release", remoteOnly: true },
    ]);
  });

  test("lists a local-only source in a Project without origin refs", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=initial");
    const projects = await createProjects();
    await projects.add(root);

    await expect(projects.sourceBranches(root)).resolves.toStrictEqual([
      { current: true, name: "main", remoteOnly: false },
    ]);
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
    await expect(projects.createWorkspace(root, "..")).rejects.toThrow(
      "not a valid Git branch"
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
    await expect(
      projects.createWorkspace(root, "My New Thing")
    ).rejects.toThrow(/already exists|already checked out/u);
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

  test("creates a Workspace from the selected source branch", async () => {
    const parent = await temporaryFolder();
    const root = path.join(parent, "mischief");
    await git(parent, "init", "--initial-branch=main", root);
    await git(root, "config", "user.email", "mischief@example.test");
    await git(root, "config", "user.name", "Mischief Test");
    await git(root, "commit", "--allow-empty", "--message=selected-source");
    const selectedCommit = await gitOutput(root, "rev-parse", "HEAD");
    await git(root, "branch", "selected", selectedCommit);
    await git(root, "commit", "--allow-empty", "--message=current-head");
    const projects = await createProjects();
    await projects.add(root);

    const workspace = await projects.createWorkspace(
      root,
      "From Selected",
      "selected"
    );

    expect({
      branch: await gitOutput(workspace, "branch", "--show-current"),
      commit: await gitOutput(workspace, "rev-parse", "HEAD"),
      workspace,
    }).toStrictEqual({
      branch: "from-selected",
      commit: selectedCommit,
      workspace: await realpath(
        path.join(parent, "worktrees", "mischief-from-selected")
      ),
    });
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
