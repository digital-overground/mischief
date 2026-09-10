import { realpath } from "node:fs/promises";
import path from "node:path";

import type { ProfileSync } from "../profile-sync/profile-sync";
import { createGitWorkspace, discoverGitProject } from "./git";

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

export class Projects {
  private currentWorkspace?: string;
  private readonly sync: ProfileSync;

  constructor(sync: ProfileSync) {
    this.sync = sync;
  }

  async open(folder: string): Promise<ProjectsSnapshot> {
    const selected = await realpath(folder);
    const discovered = await discoverGitProject(selected);
    this.currentWorkspace = discovered
      ? discovered.workspaces
          .filter(
            (workspace) =>
              selected === workspace.path ||
              selected.startsWith(`${workspace.path}${path.sep}`)
          )
          .toSorted((a, b) => b.path.length - a.path.length)[0]?.path
      : selected;
    const membershipPath = discovered?.root ?? selected;
    const membership = this.sync
      .snapshot()
      .memberships.find((candidate) => candidate.path === membershipPath);
    return membership ? this.snapshot() : this.add(selected);
  }

  async add(folder: string): Promise<ProjectsSnapshot> {
    const selected = await realpath(folder);
    const discovered = await discoverGitProject(selected);
    await this.sync.apply({
      membership: {
        kind: discovered ? "git" : "untracked",
        path: discovered?.root ?? selected,
        state: "active",
      },
      type: "putMembership",
    });
    return this.snapshot();
  }

  refresh(): Promise<ProjectsSnapshot> {
    return this.snapshot();
  }

  async createWorkspace(projectRoot: string, name: string): Promise<string> {
    const root = await realpath(projectRoot);
    const listed = this.sync
      .snapshot()
      .memberships.some(
        (membership) =>
          membership.kind === "git" &&
          membership.path === root &&
          membership.state === "active"
      );
    if (!listed) {
      throw new Error("Project is not in Mischief");
    }
    const branch = normalizeWorkspaceName(name);
    if (!branch || /[/\\]/u.test(branch)) {
      throw new Error("Enter a Workspace name without slashes");
    }
    return createGitWorkspace(root, branch);
  }

  async remove(folder: string): Promise<ProjectsSnapshot> {
    const selected = await realpath(folder);
    const discovered = await discoverGitProject(selected);
    await this.sync.apply({
      path: discovered?.root ?? selected,
      type: "removeMembership",
    });
    return this.snapshot();
  }

  private async snapshot(): Promise<ProjectsSnapshot> {
    const memberships = this.sync
      .snapshot()
      .memberships.filter((membership) => membership.state === "active");
    const gitMemberships = memberships.filter(
      (membership) => membership.kind === "git"
    );
    const untrackedMemberships = memberships.filter(
      (membership) => membership.kind === "untracked"
    );
    const [discoveredProjects, untrackedPaths] = await Promise.all([
      Promise.all(
        gitMemberships.map(async (membership) => {
          const project = await discoverGitProject(membership.path);
          if (!project) {
            await this.sync.apply({
              path: membership.path,
              type: "removeMembership",
            });
          }
          return project;
        })
      ),
      Promise.all(
        untrackedMemberships.map(async (membership) => {
          try {
            return await realpath(membership.path);
          } catch {
            await this.sync.apply({
              path: membership.path,
              type: "removeMembership",
            });
            return null;
          }
        })
      ),
    ]);

    const projects = discoveredProjects
      .filter((project) => project !== undefined)
      .map((project) => ({
        name: path.basename(project.root),
        root: project.root,
        workspaces: project.workspaces.map((workspace) => ({
          name: path.basename(workspace.path),
          ...workspace,
          current: workspace.path === this.currentWorkspace,
        })),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const ungrouped = untrackedPaths
      .filter((workspacePath) => workspacePath !== null)
      .map((workspacePath) => ({
        ahead: 0,
        behind: 0,
        changes: 0,
        current: workspacePath === this.currentWorkspace,
        linked: false,
        name: path.basename(workspacePath),
        path: workspacePath,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
    return { projects, ungrouped };
  }
}
