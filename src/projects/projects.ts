import { realpath } from "node:fs/promises";
import path from "node:path";
import { discoverGitProject } from "./git";

const STORAGE_KEY = "mischief.projects";

export interface ProjectsStorage {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface Workspace {
  name: string;
  path: string;
  branch?: string;
  linked: boolean;
  changes: number;
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
  private currentWorkspace?: string;

  constructor(private readonly storage: ProjectsStorage) {}

  async open(folder: string): Promise<ProjectsSnapshot> {
    const selected = await realpath(folder);
    const discovered = await discoverGitProject(selected);
    this.currentWorkspace = discovered
      ? discovered.workspaces
          .filter(
            (workspace) =>
              selected === workspace.path || selected.startsWith(`${workspace.path}${path.sep}`),
          )
          .sort((a, b) => b.path.length - a.path.length)[0]?.path
      : selected;
    const identity = discovered?.root ?? selected;
    return this.readStored().suppressed.includes(identity) ? this.snapshot() : this.add(selected);
  }

  async add(folder: string): Promise<ProjectsSnapshot> {
    const stored = this.readStored();
    const discovered = await discoverGitProject(folder);
    const identity = discovered?.root ?? (await realpath(folder));
    stored.suppressed = stored.suppressed.filter((item) => item !== identity);
    if (discovered) {
      if (!stored.roots.includes(identity)) stored.roots.push(identity);
    } else if (!stored.ungrouped.includes(identity)) {
      stored.ungrouped.push(identity);
    }
    await this.storage.update(STORAGE_KEY, stored);
    return this.snapshot();
  }

  async refresh(): Promise<ProjectsSnapshot> {
    return this.snapshot();
  }

  async remove(folder: string): Promise<ProjectsSnapshot> {
    const selected = await realpath(folder);
    const identity = (await discoverGitProject(selected))?.root ?? selected;
    const stored = this.readStored();
    stored.roots = stored.roots.filter((item) => item !== identity);
    stored.ungrouped = stored.ungrouped.filter((item) => item !== identity);
    if (!stored.suppressed.includes(identity)) stored.suppressed.push(identity);
    await this.storage.update(STORAGE_KEY, stored);
    return this.snapshot();
  }

  private async snapshot(): Promise<ProjectsSnapshot> {
    const stored = this.readStored();
    const discovered = (await Promise.all(stored.roots.map(discoverGitProject))).filter(
      (project) => project !== undefined,
    );
    const existingUngrouped = (
      await Promise.all(
        stored.ungrouped.map(async (workspacePath) => {
          try {
            return await realpath(workspacePath);
          } catch {
            return undefined;
          }
        }),
      )
    ).filter((workspacePath) => workspacePath !== undefined);
    await this.storage.update(STORAGE_KEY, {
      roots: discovered.map((project) => project.root),
      ungrouped: existingUngrouped,
      suppressed: stored.suppressed,
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
      .sort((a, b) => a.name.localeCompare(b.name));
    const ungrouped = existingUngrouped
      .map((workspacePath) => ({
        name: path.basename(workspacePath),
        path: workspacePath,
        linked: false,
        changes: 0,
        ahead: 0,
        behind: 0,
        current: workspacePath === this.currentWorkspace,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { projects, ungrouped };
  }

  private readStored(): StoredProjects {
    const stored = this.storage.get<Partial<StoredProjects>>(STORAGE_KEY, {});
    return {
      roots: [...(stored.roots ?? [])],
      ungrouped: [...(stored.ungrouped ?? [])],
      suppressed: [...(stored.suppressed ?? [])],
    };
  }
}
