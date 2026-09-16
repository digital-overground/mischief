import { realpath } from "node:fs/promises";
import path from "node:path";

import MarkdownIt from "markdown-it";
import * as vscode from "vscode";

import type { ProfileDatabase } from "./profile-database/profile-database";
import {
  issueWorkspaceName,
  normalizeGitHubRepository,
  normalizeWorkspaceName,
} from "./projects/projects";
import type {
  GitHubIssue,
  GitSourceBranch,
  Project,
  Projects,
  ProjectsSnapshot,
  Workspace,
} from "./projects/projects";
import type {
  PromptImage,
  ThreadInteractionResponse,
  Threads,
  ThreadsChange,
  TranscriptItem,
} from "./threads/threads";
import { webviewHtml } from "./webview";
import type { HostToWebviewMessage, SetupStep } from "./webview/protocol";
import {
  assignWorkspaceColors,
  ensureWorkspaceColors,
  workspaceWindowColor,
} from "./workspace-colors";

const VIEW_ID = "mischief.view";
const START_WORKSPACES_KEY = "mischief.startWorkspaces";

interface PendingWorkspaceStart {
  path: string;
  prompt?: string;
}
const DEFAULT_MONO_FONT_FAMILY =
  '"Lilex", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
const issuePrompt = (issue: GitHubIssue): string =>
  `start planning work on GitHub issue #${issue.number}. Read it with gh issue view ${issue.url} --comments.  return to the user once you've read the issue and give them a summary of the item`;

const workspaceColorsEnabled = (): boolean =>
  vscode.workspace
    .getConfiguration("mischief")
    .get<boolean>("assignWorkspaceColors", true);
const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true });

const renderTranscriptItem = (
  item: TranscriptItem
): TranscriptItem & {
  html?: string;
} =>
  item.text && item.kind !== "plan" && item.kind !== "tool"
    ? { ...item, html: markdown.render(item.text) }
    : item;

const promptImages = (value: unknown): PromptImage[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 10) {
    throw new Error("Invalid pasted images");
  }
  let size = 0;
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Invalid pasted image");
    }
    const image = candidate as Record<string, unknown>;
    if (
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string" ||
      !["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
        image.mimeType
      ) ||
      !/^[A-Za-z\d+/]*={0,2}$/u.test(image.data)
    ) {
      throw new Error("Invalid pasted image");
    }
    size += image.data.length;
    if (size > 20_000_000) {
      throw new Error("Pasted images are too large");
    }
    return { data: image.data, mimeType: image.mimeType };
  });
};

interface GitHubIssueQuickPickItem extends vscode.QuickPickItem {
  issue: GitHubIssue;
}

interface SourceBranchQuickPickItem extends vscode.QuickPickItem {
  branch?: GitSourceBranch;
}

const interactionResponse = (
  value: unknown
): ThreadInteractionResponse | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const response = value as Record<string, unknown>;
  if (response.action === "cancel") {
    return { action: "cancel" };
  }
  if (response.action === "select" && typeof response.optionId === "string") {
    return { action: "select", optionId: response.optionId };
  }
  if (
    response.action === "accept" &&
    response.values &&
    typeof response.values === "object" &&
    !Array.isArray(response.values)
  ) {
    return {
      action: "accept",
      values: response.values as Record<string, unknown>,
    };
  }
  return undefined;
};

export interface ThreadSetup {
  advance: (selected: string[]) => Promise<SetupStep | undefined>;
  prompt: () => SetupStep | undefined;
}

export class MischiefView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectsSnapshot: ProjectsSnapshot = { projects: [], ungrouped: [] };
  private readonly database: ProfileDatabase;
  private databaseWorkspaces: string;
  private profileRefresh = Promise.resolve();
  private setupPrompt?: string;
  private setupStep?: SetupStep;
  private readonly extensionUri: vscode.Uri;
  private readonly setup?: ThreadSetup;
  private readonly projects: Projects;
  private readonly storage: Pick<vscode.Memento, "get" | "update">;
  private readonly threads: Threads;

  constructor(
    projects: Projects,
    threads: Threads,
    extensionUri: vscode.Uri,
    storage: Pick<vscode.Memento, "get" | "update">,
    database: ProfileDatabase,
    setup?: ThreadSetup
  ) {
    this.projects = projects;
    this.threads = threads;
    this.extensionUri = extensionUri;
    this.storage = storage;
    this.database = database;
    this.databaseWorkspaces = JSON.stringify(database.snapshot().workspaces);
    database.onChange(() => this.databaseChanged());
    this.setup = setup;
    threads.onChange((change) => {
      if (change?.type === "transcript") {
        this.renderTranscript(change);
      } else {
        this.render();
      }
    });
  }

  async initialize(folder?: string): Promise<void> {
    await this.setProjects(
      folder ? this.projects.open(folder) : this.projects.refresh()
    );
    await this.syncThreads();
    this.render();
    await this.startPendingWorkspace();
  }

  async addWorkspace(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Add Workspace",
    });
    if (!selected?.[0]) {
      return;
    }
    await this.setProjects(this.projects.add(selected[0].fsPath));
    await this.syncThreads();
    this.render();
  }

  async newWorkspace(projectRoot: string): Promise<void> {
    const project = this.projectsSnapshot.projects.find(
      (candidate) => candidate.root === projectRoot
    );
    if (!project) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Create a linked worktree and branch",
      title: `New Workspace for ${project.name}`,
      validateInput: (value) => {
        const normalized = normalizeWorkspaceName(value);
        if (!normalized) {
          return "Enter a Workspace name";
        }
        return /[/\\]/u.test(normalized)
          ? "Workspace names cannot contain slashes"
          : undefined;
      },
    });
    if (name === undefined) {
      return;
    }
    await this.createWorkspace(project, name);
  }

  async refresh(): Promise<void> {
    await this.setProjects(this.projects.refresh());
    await this.syncThreads();
    this.render();
  }

  private async openIssues(projectRoot: string): Promise<void> {
    const project = this.projectsSnapshot.projects.find(
      (candidate) => candidate.root === projectRoot
    );
    if (!project) {
      return;
    }
    const issues = await this.projects.listOpenIssues(
      project.root,
      async (defaultRepository) => {
        const repository = await vscode.window.showInputBox({
          prompt: "Enter the GitHub issue repository as owner/repo",
          title: `Issue Repository for ${project.name}`,
          validateInput: (value) =>
            normalizeGitHubRepository(value)
              ? undefined
              : "Enter a GitHub repository as owner/repo",
          value: defaultRepository,
        });
        return repository === undefined
          ? undefined
          : normalizeGitHubRepository(repository);
      }
    );
    if (!issues) {
      return;
    }
    if (!issues.length) {
      await vscode.window.showInformationMessage(
        `No open GitHub issues for ${project.name}.`
      );
      return;
    }
    const picker = vscode.window.createQuickPick<GitHubIssueQuickPickItem>();
    picker.title = `Open Issues · ${project.name}`;
    picker.items = issues.map((issue) => ({
      buttons: [
        {
          iconPath: new vscode.ThemeIcon("link-external"),
          tooltip: `Open #${issue.number} on GitHub`,
        },
      ],
      issue,
      label: `#${issue.number} ${issue.title}`,
    }));
    const disposables = [
      picker.onDidAccept(() => {
        const [selected] = picker.selectedItems;
        if (selected) {
          picker.hide();
          void MischiefView.run(
            this.newIssueWorkspace(project, selected.issue)
          );
        }
      }),
      picker.onDidTriggerItemButton(async ({ item }) => {
        try {
          const opened = await vscode.env.openExternal(
            vscode.Uri.parse(item.issue.url)
          );
          if (!opened) {
            throw new Error("VS Code declined the URL");
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Mischief: Could not open #${item.issue.number}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }),
      picker.onDidHide(() => {
        for (const disposable of disposables) {
          disposable.dispose();
        }
        picker.dispose();
      }),
    ];
    picker.show();
  }

  private async newIssueWorkspace(
    project: Project,
    issue: GitHubIssue
  ): Promise<void> {
    const branches = await this.projects.sourceBranches(project.root);
    if (!branches.length) {
      await vscode.window.showInformationMessage(
        `No source branches for ${project.name}.`
      );
      return;
    }
    const local = branches.filter((branch) => !branch.remoteOnly);
    const remote = branches.filter((branch) => branch.remoteOnly);
    const items: SourceBranchQuickPickItem[] = [
      { kind: vscode.QuickPickItemKind.Separator, label: "Local" },
      ...local.map((branch) => ({
        branch,
        description:
          branch.ahead === undefined
            ? "local only"
            : `↑${branch.ahead} ↓${branch.behind ?? 0}`,
        label: branch.name,
      })),
      ...(remote.length
        ? [
            {
              kind: vscode.QuickPickItemKind.Separator,
              label: "Remote only",
            },
            ...remote.map((branch) => ({ branch, label: branch.name })),
          ]
        : []),
    ];
    const picker = vscode.window.createQuickPick<SourceBranchQuickPickItem>();
    picker.items = items;
    picker.title = `Source Branch for #${issue.number}`;
    const current = items.find((item) => item.branch?.current);
    if (current) {
      picker.activeItems = [current];
    }
    const disposables = [
      picker.onDidAccept(() => {
        const [selected] = picker.selectedItems;
        if (selected?.branch) {
          picker.hide();
          void MischiefView.run(
            this.nameIssueWorkspace(project, issue, selected.branch)
          );
        }
      }),
      picker.onDidHide(() => {
        for (const disposable of disposables) {
          disposable.dispose();
        }
        picker.dispose();
      }),
    ];
    picker.show();
  }

  private async nameIssueWorkspace(
    project: Project,
    issue: GitHubIssue,
    branch: GitSourceBranch
  ): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: `Create a linked worktree and branch from ${branch.name}`,
      title: `New Workspace for #${issue.number}`,
      validateInput: (value) => {
        const normalized = normalizeWorkspaceName(value);
        if (!normalized) {
          return "Enter a Workspace name";
        }
        return /[/\\]/u.test(normalized)
          ? "Workspace names cannot contain slashes"
          : undefined;
      },
      value: issueWorkspaceName(issue),
    });
    if (name !== undefined) {
      await this.createWorkspace(
        project,
        name,
        branch.name,
        issuePrompt(issue)
      );
    }
  }

  private async createWorkspace(
    project: Project,
    name: string,
    sourceRef?: string,
    prompt?: string
  ): Promise<void> {
    const workspace = await this.projects.createWorkspace(
      project.root,
      name,
      sourceRef
    );
    if (workspaceColorsEnabled()) {
      try {
        await assignWorkspaceColors(workspace, project.root);
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Mischief created the Workspace but could not assign its color: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    await this.setProjects(this.projects.refresh());
    const pending = this.storage.get<PendingWorkspaceStart[]>(
      START_WORKSPACES_KEY,
      []
    );
    await this.storage.update(START_WORKSPACES_KEY, [
      ...pending.filter((candidate) => candidate.path !== workspace),
      { path: workspace, ...(prompt ? { prompt } : {}) },
    ]);
    this.render();
    await this.openWorkspace(workspace);
  }

  async newThread(preserveFocus = true, initialPrompt?: string): Promise<void> {
    const setupStep = this.setup?.prompt();
    if (setupStep) {
      this.setupPrompt = initialPrompt;
      this.setupStep = setupStep;
      this.view?.show(preserveFocus);
      this.render();
      return;
    }
    await this.startThread(preserveFocus, initialPrompt);
  }

  configurationChanged(): void {
    this.render();
  }

  setAllExpanded(expanded: boolean): void {
    const postMessage = this.view?.webview.postMessage.bind(this.view.webview);
    void postMessage?.({
      expanded,
      type: "setAllExpanded",
    } satisfies HostToWebviewMessage);
  }

  showSettings(): void {
    const postMessage = this.view?.webview.postMessage.bind(this.view.webview);
    void postMessage?.({
      assignWorkspaceColors: workspaceColorsEnabled(),
      type: "showSettings",
    } satisfies HostToWebviewMessage);
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [media, dist],
    };
    view.webview.html = await webviewHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    view.onDidChangeVisibility?.(() => {
      if (view.visible) {
        this.threads.markViewed();
      } else {
        this.threads.markHidden();
      }
    });
    view.onDidDispose(() => {
      this.threads.markHidden();
      if (this.view === view) {
        this.view = undefined;
      }
    });
    if (view.visible) {
      this.threads.markViewed();
    }
    this.render();
  }

  private async setProjects(
    snapshot: Promise<ProjectsSnapshot>
  ): Promise<void> {
    this.projectsSnapshot = await snapshot;
    const current = this.workspaces().find((workspace) => workspace.current);
    if (current && workspaceColorsEnabled()) {
      const projectRoot =
        this.projectsSnapshot.projects.find((project) =>
          project.workspaces.some(
            (workspace) => workspace.path === current.path
          )
        )?.root ?? current.path;
      try {
        await ensureWorkspaceColors(current.path, projectRoot);
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Mischief could not assign this Workspace's color: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    await Promise.all(
      this.workspaces().map(async (workspace) => {
        workspace.color = await workspaceWindowColor(workspace.path);
      })
    );
  }

  private async syncThreads(): Promise<void> {
    const current = this.workspaces().find((workspace) => workspace.current);
    const active = this.threads.snapshot().workspace;
    if (current && active !== current.path) {
      await this.threads.openWorkspace(current.path);
    } else if (!current && active) {
      await this.threads.closeWorkspace();
    }
  }

  private databaseChanged(): void {
    const workspaces = JSON.stringify(this.database.snapshot().workspaces);
    if (this.databaseWorkspaces === workspaces) {
      this.render();
      return;
    }
    this.databaseWorkspaces = workspaces;
    const previous = this.profileRefresh;
    this.profileRefresh = MischiefView.run(
      (async () => {
        await previous;
        await this.setProjects(this.projects.refresh());
        await this.syncThreads();
        this.render();
      })()
    );
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    const data = message as Record<string, unknown>;
    try {
      if (await this.handleWorkspaceMessage(data)) {
        return;
      }
      if (await this.handleThreadMessage(data)) {
        return;
      }
      await this.handleInteractionMessage(data);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Mischief: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async handleWorkspaceMessage(
    data: Record<string, unknown>
  ): Promise<boolean> {
    if (data.type === "ready") {
      this.threads.markViewed();
      this.render();
      return true;
    }
    if (
      data.type === "setAssignWorkspaceColors" &&
      typeof data.value === "boolean"
    ) {
      await vscode.workspace
        .getConfiguration("mischief")
        .update(
          "assignWorkspaceColors",
          data.value,
          vscode.ConfigurationTarget.Global
        );
      return true;
    }
    if (data.type === "contextItems") {
      await this.sendContextItems();
      return true;
    }
    if (
      data.type === "navigatorExpanded" &&
      typeof data.expanded === "boolean"
    ) {
      await vscode.commands.executeCommand(
        "setContext",
        "mischief.navigatorAllExpanded",
        data.expanded
      );
      return true;
    }
    if (data.type === "newThread") {
      await this.newThread();
      return true;
    }
    if (data.type === "setupContinue") {
      const selected = Array.isArray(data.selected)
        ? data.selected
            .filter((item): item is string => typeof item === "string")
            .slice(0, 10)
        : [];
      await this.continueSetup(selected);
      return true;
    }
    if (data.type === "openIssues" && typeof data.path === "string") {
      await this.openIssues(data.path);
      return true;
    }
    if (data.type === "newWorkspace" && typeof data.path === "string") {
      await this.newWorkspace(data.path);
      return true;
    }
    if (data.type === "openWorkspace" && typeof data.path === "string") {
      await this.openWorkspace(data.path);
      return true;
    }
    if (data.type === "deactivateWorkspace" && typeof data.path === "string") {
      await this.deactivateWorkspace(data.path);
      return true;
    }
    return false;
  }

  // oxlint-disable-next-line complexity -- message routing is intentionally flat
  private async handleThreadMessage(
    data: Record<string, unknown>
  ): Promise<boolean> {
    if (data.type === "selectThread" && typeof data.id === "string") {
      const workspace = await this.threads.select(data.id);
      const current = this.workspaces().find((candidate) => candidate.current);
      if (workspace && workspace !== current?.path) {
        await this.openWorkspace(workspace);
      }
      return true;
    }
    if (data.type === "removeThread" && typeof data.id === "string") {
      await this.threads.remove(data.id);
      return true;
    }
    if (data.type === "forkThread" && typeof data.id === "string") {
      await this.threads.fork(data.id);
      return true;
    }
    if (data.type === "rollbackThread" && typeof data.id === "string") {
      const confirmed = await vscode.window.showWarningMessage(
        "Rollback this Thread? The Thread will return to the selected point and later messages will leave the active branch.",
        { modal: true },
        "Rollback"
      );
      if (confirmed === "Rollback") {
        await this.threads.rollback(data.id);
      }
      return true;
    }
    if (data.type === "renameThread" && typeof data.id === "string") {
      await this.renameThread(data.id);
      return true;
    }
    if (data.type === "prompt" && typeof data.text === "string") {
      if (data.text.length > 1_000_000) {
        throw new Error("Prompt is too large");
      }
      const images = promptImages(data.images);
      void MischiefView.run(this.threads.prompt(data.text, images));
      return true;
    }
    if (data.type === "cancel") {
      await this.threads.cancel();
      return true;
    }
    if (data.type === "clearPlan") {
      this.threads.clearPlan();
      return true;
    }
    if (data.type === "clearSteering") {
      this.threads.clearSteering();
      return true;
    }
    if (data.type === "removeSteering" && typeof data.id === "string") {
      this.threads.removeSteering(data.id);
      return true;
    }
    if (data.type === "sendSteering" && typeof data.id === "string") {
      await this.threads.sendSteering(data.id);
      return true;
    }
    if (data.type === "retry") {
      void MischiefView.run(this.threads.retry());
      return true;
    }
    if (
      data.type === "setConfig" &&
      typeof data.id === "string" &&
      (typeof data.value === "string" || typeof data.value === "boolean")
    ) {
      await this.threads.setConfig(data.id, data.value);
      return true;
    }
    return false;
  }

  private async handleInteractionMessage(
    data: Record<string, unknown>
  ): Promise<void> {
    if (data.type === "respond" && typeof data.id === "string") {
      const response = interactionResponse(data.response);
      if (response) {
        await this.threads.respond(data.id, response);
      }
      return;
    }
    if (data.type === "draftsConsumed") {
      this.threads.consumeDrafts();
      return;
    }
    if (data.type === "authenticate") {
      this.authenticate();
      return;
    }
    if (data.type === "openLocation" && typeof data.path === "string") {
      await this.openLocation(
        data.path,
        typeof data.line === "number" ? data.line : undefined
      );
      return;
    }
    if (data.type === "openDiff" && typeof data.path === "string") {
      await this.openDiff(data.path);
    }
  }

  private async continueSetup(selected: string[]): Promise<void> {
    if (!this.setup || !this.setupStep) {
      return;
    }
    this.setupStep = await this.setup.advance(selected);
    if (this.setupStep) {
      this.render();
    } else {
      const prompt = this.setupPrompt;
      this.setupPrompt = undefined;
      await this.startThread(true, prompt);
    }
  }

  private async startThread(
    preserveFocus = true,
    initialPrompt?: string
  ): Promise<void> {
    this.setupStep = undefined;
    const creating = this.threads.newThread();
    this.view?.show(preserveFocus);
    await creating;
    if (initialPrompt) {
      void MischiefView.run(this.threads.prompt(initialPrompt));
    }
  }

  private static async run(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Mischief: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async startPendingWorkspace(): Promise<void> {
    const workspace = this.workspaces().find((candidate) => candidate.current);
    const pending = this.storage.get<PendingWorkspaceStart[]>(
      START_WORKSPACES_KEY,
      []
    );
    if (!workspace) {
      return;
    }
    const canonical = await Promise.all(
      pending.map(async (candidate) => {
        try {
          return (await realpath(candidate.path)) === workspace.path;
        } catch {
          return false;
        }
      })
    );
    const index = canonical.indexOf(true);
    const start = pending[index];
    if (!start) {
      return;
    }
    await this.storage.update(
      START_WORKSPACES_KEY,
      pending.toSpliced(index, 1)
    );
    await vscode.commands.executeCommand("workbench.view.extension.mischief");
    await this.newThread(false, start.prompt);
  }

  private async openWorkspace(candidate: string): Promise<void> {
    const workspace = this.workspaces().find((item) => item.path === candidate);
    if (!workspace || workspace.current) {
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(candidate),
      {
        forceNewWindow: true,
      }
    );
  }

  private async deactivateWorkspace(candidate: string): Promise<void> {
    const workspace = this.workspaces().find((item) => item.path === candidate);
    if (!workspace) {
      return;
    }
    await this.setProjects(this.projects.remove(candidate));
    if (workspace.current) {
      await this.threads.closeWorkspace();
    }
    this.render();
  }

  private async renameThread(id: string): Promise<void> {
    const thread = this.threads
      .snapshot()
      .threads.find((candidate) => candidate.id === id);
    if (!thread) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "Rename Thread",
      validateInput: (value) =>
        value.trim() ? undefined : "Enter a Thread name",
      value: thread.name,
    });
    if (name !== undefined) {
      await this.threads.rename(thread.id, name);
    }
  }

  private authenticate(): void {
    const authentication = this.threads.snapshot().selected?.authentication;
    if (!authentication) {
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `Mischief: ${authentication.label}`,
      shellArgs: authentication.args,
      shellPath: authentication.command,
      ...(authentication.env ? { env: authentication.env } : {}),
    });
    terminal.show();
  }

  private async openLocation(candidate: string, line?: number): Promise<void> {
    const item = this.threads
      .snapshot()
      .selected?.items.find(
        (entry) =>
          entry.locations?.some((location) => location.path === candidate) ||
          entry.diffs?.some((diff) => diff.path === candidate)
      );
    if (!item) {
      return;
    }
    const selection =
      line && line > 0 ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
    await vscode.window.showTextDocument(vscode.Uri.file(candidate), {
      preview: true,
      ...(selection ? { selection } : {}),
    });
  }

  private async openDiff(candidate: string): Promise<void> {
    const diff = this.threads
      .snapshot()
      .selected?.items.flatMap((item) => item.diffs ?? [])
      .find((item) => item.path === candidate);
    if (!diff) {
      return;
    }
    const [before, after] = await Promise.all([
      vscode.workspace.openTextDocument({ content: diff.oldText ?? "" }),
      vscode.workspace.openTextDocument({ content: diff.newText }),
    ]);
    await vscode.commands.executeCommand(
      "vscode.diff",
      before.uri,
      after.uri,
      `${path.basename(candidate)} (Agent Diff)`
    );
  }

  private workspaces(): Workspace[] {
    return [
      ...this.projectsSnapshot.projects.flatMap(
        (project) => project.workspaces
      ),
      ...this.projectsSnapshot.ungrouped,
    ];
  }

  private async sendContextItems(): Promise<void> {
    const workspace = this.workspaces().find((item) => item.current);
    if (!workspace || !this.view) {
      return;
    }
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspace.path, "**/*"),
      "**/{.git,node_modules,dist,build}/**",
      5000
    );
    const items = new Set<string>();
    for (const file of files) {
      const relative = path.relative(workspace.path, file.fsPath);
      const parts = relative.split(path.sep);
      for (let index = 1; index < parts.length; index += 1) {
        items.add(`${parts.slice(0, index).join("/")}/`);
      }
      items.add(parts.join("/"));
    }
    const postMessage = this.view.webview.postMessage.bind(this.view.webview);
    void postMessage({
      items: [...items].toSorted((a, b) => a.localeCompare(b)),
      type: "contextItems",
    } satisfies HostToWebviewMessage);
  }

  private renderTranscript(change: ThreadsChange): void {
    if (!this.view) {
      return;
    }
    const postMessage = this.view.webview.postMessage.bind(this.view.webview);
    void postMessage({
      ...change,
      item: renderTranscriptItem(change.item),
    } satisfies HostToWebviewMessage);
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    const font = vscode.workspace
      .getConfiguration("mischief")
      .get<string>("fontFamily")
      ?.trim();
    const threads = this.threads.snapshot();
    const visible = new Set(
      this.workspaces().map((workspace) => workspace.path)
    );
    const attentionCount = threads.threads.filter(
      (thread) => visible.has(thread.workspace) && thread.needsAttention
    ).length;
    this.view.badge = attentionCount
      ? {
          tooltip: `${attentionCount} Thread${attentionCount === 1 ? "" : "s"} need attention`,
          value: attentionCount,
        }
      : { tooltip: "", value: 0 };
    if (threads.selected) {
      threads.selected = {
        ...threads.selected,
        items: threads.selected.items.map(renderTranscriptItem),
      };
    }
    const postMessage = this.view.webview.postMessage.bind(this.view.webview);
    void postMessage({
      font: font || DEFAULT_MONO_FONT_FAMILY,
      projects: this.projectsSnapshot,
      ...(this.setupStep
        ? {
            setup: {
              id: this.setupStep.id,
              item: renderTranscriptItem({
                id: `setup:${this.setupStep.id}`,
                kind: "system",
                text: this.setupStep.message,
              }),
              ...(this.setupStep.options
                ? { options: this.setupStep.options }
                : {}),
            },
          }
        : {}),
      threads,
      type: "state",
    } satisfies HostToWebviewMessage);
  }
}

export const registerMischiefView = (
  context: vscode.ExtensionContext,
  provider: MischiefView
): void => {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
};
