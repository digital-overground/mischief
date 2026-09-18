import { realpath } from "node:fs/promises";
import path from "node:path";

import { isNonEmpty, isRecord } from "../present";
import type {
  ProfileDatabase,
  WorkspaceLocation,
} from "../profile-database/profile-database";
import {
  createGitWorkspace,
  discoverGitProject,
  getGitHubIssueRepository,
  normalizeGitHubRepository,
  setGitHubIssueRepository,
  sourceBranches as listGitSourceBranches,
} from "./git";
import type { GitSourceBranch, GitWorkspace } from "./git";
import { listOpenGitHubIssues } from "./github";

export { normalizeGitHubRepository } from "./git";
export type { GitSourceBranch } from "./git";

export const normalizeWorkspaceName = (name: string): string =>
  name.trim().toLowerCase().replaceAll(/\s+/gu, "-");

export interface Workspace {
  name: string;
  path: string;
  branch?: string;
  linked: boolean;
  changes: number;
  color?: string;
  ahead: number;
  behind: number;
  current: boolean;
}

export interface Project {
  name: string;
  root: string;
  workspaces: Workspace[];
}

export interface ProjectsSnapshot {
  projects: Project[];
  ungrouped: Workspace[];
}

export const locateWorkspace = async (
  folder: string
): Promise<WorkspaceLocation> => {
  const selected = await realpath(folder);
  const project = await discoverGitProject(selected);
  if (!project) {
    return { path: selected };
  }
  const [workspace] = project.workspaces
    .filter(
      (candidate) =>
        selected === candidate.path ||
        selected.startsWith(`${candidate.path}${path.sep}`)
    )
    .toSorted((left, right) => right.path.length - left.path.length);
  return { path: workspace?.path ?? selected, projectRoot: project.root };
};

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
}

export const issueWorkspaceName = (issue: GitHubIssue): string => {
  const title = issue.title
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
  const name = title
    ? `issue-${issue.number}_${title}`
    : `issue-${issue.number}`;
  return name.slice(0, 50).replace(/-$/u, "");
};

export class Projects {
  private currentWorkspace?: string;
  private readonly database: ProfileDatabase;

  constructor(database: ProfileDatabase) {
    this.database = database;
  }

  async open(folder: string): Promise<ProjectsSnapshot> {
    const workspace = await locateWorkspace(folder);
    this.currentWorkspace = workspace.path;
    await this.activate(workspace);
    return await this.snapshot();
  }

  async add(folder: string): Promise<ProjectsSnapshot> {
    await this.activate(await locateWorkspace(folder));
    return await this.snapshot();
  }

  async refresh(): Promise<ProjectsSnapshot> {
    return await this.snapshot();
  }

  async importPreviousWorkspaces(value: unknown): Promise<void> {
    if (!isRecord(value)) {
      return;
    }
    const previous = value;
    const roots = Array.isArray(previous.roots)
      ? previous.roots.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    const ungrouped = Array.isArray(previous.ungrouped)
      ? previous.ungrouped.filter(
          (item): item is string => typeof item === "string"
        )
      : [];
    const imported = await Promise.all([
      ...roots.map(async (root) => {
        const project = await discoverGitProject(root);
        return (
          project?.workspaces.map((workspace) => ({
            path: workspace.path,
            projectRoot: project.root,
          })) ?? []
        );
      }),
      ...ungrouped.map(async (folder) => {
        try {
          return [await locateWorkspace(folder)];
        } catch {
          return [];
        }
      }),
    ]);
    const existing = new Set(
      this.database.snapshot().workspaces.map((workspace) => workspace.path)
    );
    const locations = imported.flat();
    await Promise.all(
      [
        ...new Map(
          locations.map((location) => [location.path, location])
        ).values(),
      ]
        .filter((workspace) => !existing.has(workspace.path))
        .map(async (workspace) => {
          await this.activate(workspace);
        })
    );
  }

  async listOpenIssues(
    projectRoot: string,
    chooseRepository: (defaultRepository: string) => Promise<string | undefined>
  ): Promise<GitHubIssue[] | undefined> {
    const root = await realpath(projectRoot);
    if (
      !this.database
        .snapshot()
        .workspaces.some(
          (workspace) =>
            workspace.projectRoot === root && workspace.status === "active"
        )
    ) {
      throw new Error("Project is not in Mischief");
    }
    const issueRepository = await getGitHubIssueRepository(root);
    const selected = issueRepository.configured
      ? issueRepository.repository
      : await chooseRepository(issueRepository.repository);
    if (selected === undefined) {
      return undefined;
    }
    const repository = normalizeGitHubRepository(selected);
    if (!isNonEmpty(repository)) {
      throw new Error("Enter a GitHub repository as owner/repo");
    }
    const issues = await listOpenGitHubIssues(root, repository);
    if (!issueRepository.configured) {
      await setGitHubIssueRepository(root, repository);
    }
    return issues;
  }

  async sourceBranches(projectRoot: string): Promise<GitSourceBranch[]> {
    const root = await realpath(projectRoot);
    if (
      !this.database
        .snapshot()
        .workspaces.some(
          (workspace) =>
            workspace.projectRoot === root && workspace.status === "active"
        )
    ) {
      throw new Error("Project is not in Mischief");
    }
    return await listGitSourceBranches(root);
  }

  async createWorkspace(
    projectRoot: string,
    name: string,
    sourceRef?: string
  ): Promise<string> {
    const root = await realpath(projectRoot);
    const listed = this.database
      .snapshot()
      .workspaces.some(
        (workspace) =>
          workspace.projectRoot === root && workspace.status === "active"
      );
    if (!listed) {
      throw new Error("Project is not in Mischief");
    }
    const branch = normalizeWorkspaceName(name);
    if (!branch || /[/\\]/u.test(branch)) {
      throw new Error("Enter a Workspace name without slashes");
    }
    const workspace = await createGitWorkspace(root, branch, sourceRef);
    await this.activate({ path: workspace, projectRoot: root });
    return workspace;
  }

  async remove(folder: string): Promise<ProjectsSnapshot> {
    const workspace = await locateWorkspace(folder);
    await this.database.apply({
      path: workspace.path,
      type: "deactivateWorkspace",
    });
    return await this.snapshot();
  }

  private async activate(workspace: WorkspaceLocation): Promise<void> {
    await this.database.apply({ type: "activateWorkspace", workspace });
  }

  private async snapshot(): Promise<ProjectsSnapshot> {
    const active = this.database
      .snapshot()
      .workspaces.filter((workspace) => workspace.status === "active");
    const inspected = await Promise.all(
      active.map(async (record) => {
        const { projectRoot } = record;
        if (!isNonEmpty(projectRoot)) {
          try {
            return { path: await realpath(record.path) };
          } catch {
            return null;
          }
        }
        const project = await discoverGitProject(record.path);
        const workspace = project?.workspaces.find(
          (candidate) => candidate.path === record.path
        );
        return project?.root === projectRoot && workspace
          ? { projectRoot, workspace }
          : null;
      })
    );
    const grouped = new Map<string, GitWorkspace[]>();
    const untracked: string[] = [];
    for (const result of inspected) {
      if (!result) {
        continue;
      }
      if (result.workspace && result.projectRoot) {
        const workspaces = grouped.get(result.projectRoot) ?? [];
        workspaces.push(result.workspace);
        grouped.set(result.projectRoot, workspaces);
      } else if (isNonEmpty(result.path)) {
        untracked.push(result.path);
      }
    }

    const projects = [...grouped]
      .map(([root, workspaces]) => ({
        name: path.basename(root),
        root,
        workspaces: workspaces
          .map((workspace) => ({
            name: path.basename(workspace.path),
            ...workspace,
            current: workspace.path === this.currentWorkspace,
          }))
          .toSorted(
            (left, right) =>
              Number(left.linked) - Number(right.linked) ||
              left.name.localeCompare(right.name)
          ),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const ungrouped = untracked
      .map((workspacePath) => ({
        ahead: 0,
        behind: 0,
        changes: 0,
        current: workspacePath === this.currentWorkspace,
        linked: false,
        name: path.basename(workspacePath),
        path: workspacePath,
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
    return { projects, ungrouped };
  }
}
