import { realpath } from "node:fs/promises";
import path from "node:path";

import { createGitWorkspace, discoverGitProject } from "./git";

const STORAGE_KEY = "mischief.projects";

export const normalizeWorkspaceName = (name: string): string =>
  name.trim().toLowerCase().replaceAll(/\s+/gu, "-");

export interface ProjectsStorage {
  get: <T>(key: string, fallback: T) => T;
  update: (key: string, value: unknown) => Thenable<void>;
}

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

interface StoredProjects {
  roots: string[];
  ungrouped: string[];
  suppressed: string[];
}

export class Projects {
  private readonly storage: ProjectsStorage;
  private currentWorkspace?: string;

  constructor(storage: ProjectsStorage) {
    this.storage = storage;
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
    const identity = discovered?.root ?? selected;
    return this.readStored().suppressed.includes(identity)
      ? this.snapshot()
      : this.add(selected);
  }

  async add(folder: string): Promise<ProjectsSnapshot> {
    const stored = this.readStored();
    const discovered = await discoverGitProject(folder);
    const canonicalFolder = await realpath(folder);
    const identity = discovered?.root ?? canonicalFolder;
    stored.suppressed = stored.suppressed.filter((item) => item !== identity);
    if (discovered) {
      if (!stored.roots.includes(identity)) {
        stored.roots.push(identity);
      }
    } else if (!stored.ungrouped.includes(identity)) {
      stored.ungrouped.push(identity);
    }
    await this.storage.update(STORAGE_KEY, stored);
    return this.snapshot();
  }

  refresh(): Promise<ProjectsSnapshot> {
    return this.snapshot();
  }

  async createWorkspace(projectRoot: string, name: string): Promise<string> {
    const root = await realpath(projectRoot);
    if (!this.readStored().roots.includes(root)) {
      throw new Error("Project is not managed by Mischief");
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
    const identity = discovered?.root ?? selected;
    const stored = this.readStored();
    stored.roots = stored.roots.filter((item) => item !== identity);
    stored.ungrouped = stored.ungrouped.filter((item) => item !== identity);
    if (!stored.suppressed.includes(identity)) {
      stored.suppressed.push(identity);
    }
    await this.storage.update(STORAGE_KEY, stored);
    return this.snapshot();
  }

  private async snapshot(): Promise<ProjectsSnapshot> {
    const stored = this.readStored();
    const discoveredProjects = await Promise.all(
      stored.roots.map(discoverGitProject)
    );
    const discovered = discoveredProjects.filter(
      (project) => project !== undefined
    );
    const ungroupedPaths = await Promise.all(
      stored.ungrouped.map(async (workspacePath) => {
        try {
          return await realpath(workspacePath);
        } catch {
          return null;
        }
      })
    );
    const existingUngrouped = ungroupedPaths.filter(
      (workspacePath): workspacePath is string => workspacePath !== null
    );
    await this.storage.update(STORAGE_KEY, {
      roots: discovered.map((project) => project.root),
      suppressed: stored.suppressed,
      ungrouped: existingUngrouped,
    } satisfies StoredProjects);

    const projects = discovered
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
    const ungrouped = existingUngrouped
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

  private readStored(): StoredProjects {
    const stored = this.storage.get<Partial<StoredProjects>>(STORAGE_KEY, {});
    return {
      roots: [...(stored.roots ?? [])],
      suppressed: [...(stored.suppressed ?? [])],
      ungrouped: [...(stored.ungrouped ?? [])],
    };
  }
}
