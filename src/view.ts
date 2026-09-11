import path from "node:path";

import MarkdownIt from "markdown-it";
import * as vscode from "vscode";

import { normalizeWorkspaceName } from "./projects/projects";
import type {
  Projects,
  ProjectsSnapshot,
  ProjectsStorage,
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
const DEFAULT_MONO_FONT_FAMILY =
  '"Lilex", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
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
  private setupStep?: SetupStep;
  private readonly extensionUri: vscode.Uri;
  private readonly setup?: ThreadSetup;
  private readonly projects: Projects;
  private readonly storage: ProjectsStorage;
  private readonly threads: Threads;

  constructor(
    projects: Projects,
    threads: Threads,
    extensionUri: vscode.Uri,
    storage: ProjectsStorage,
    setup?: ThreadSetup
  ) {
    this.projects = projects;
    this.threads = threads;
    this.extensionUri = extensionUri;
    this.storage = storage;
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
    const workspace = await this.projects.createWorkspace(project.root, name);
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
    const pending = this.storage.get<string[]>(START_WORKSPACES_KEY, []);
    await this.storage.update(START_WORKSPACES_KEY, [
      ...new Set([...pending, workspace]),
    ]);
    this.render();
    await this.openWorkspace(workspace);
  }

  async refresh(): Promise<void> {
    await this.setProjects(this.projects.refresh());
    await this.syncThreads();
    this.render();
  }

  async newThread(preserveFocus = true): Promise<void> {
    const setupStep = this.setup?.prompt();
    if (setupStep) {
      this.setupStep = setupStep;
      this.view?.show(preserveFocus);
      this.render();
      return;
    }
    await this.startThread(preserveFocus);
  }

  configurationChanged(): void {
    this.render();
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
    if (data.type === "add") {
      await this.addWorkspace();
      return true;
    }
    if (data.type === "refresh") {
      await this.refresh();
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
    if (data.type === "newWorkspace" && typeof data.path === "string") {
      await this.newWorkspace(data.path);
      return true;
    }
    if (data.type === "openWorkspace" && typeof data.path === "string") {
      await this.openWorkspace(data.path);
      return true;
    }
    if (data.type === "removeMembership" && typeof data.path === "string") {
      await this.removeMembership(data.path);
      return true;
    }
    return false;
  }

  // oxlint-disable-next-line complexity -- message routing is intentionally flat
  private async handleThreadMessage(
    data: Record<string, unknown>
  ): Promise<boolean> {
    if (data.type === "selectThread" && typeof data.id === "string") {
      await this.threads.select(data.id);
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
        "Rollback this Thread? The selected message and everything after it will leave the active branch.",
        { modal: true },
        "Rollback"
      );
      if (confirmed === "Rollback") {
        await this.threads.rollback(data.id);
      }
      return true;
    }
    if (data.type === "renameThread") {
      await this.renameThread();
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
      await this.startThread();
    }
  }

  private async startThread(preserveFocus = true): Promise<void> {
    this.setupStep = undefined;
    const creating = this.threads.newThread();
    this.view?.show(preserveFocus);
    await creating;
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
    const pending = this.storage.get<string[]>(START_WORKSPACES_KEY, []);
    if (!workspace || !pending.includes(workspace.path)) {
      return;
    }
    await this.storage.update(
      START_WORKSPACES_KEY,
      pending.filter((candidate) => candidate !== workspace.path)
    );
    await vscode.commands.executeCommand("workbench.view.extension.mischief");
    await this.newThread(false);
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

  private async removeMembership(candidate: string): Promise<void> {
    const project = this.projectsSnapshot.projects.find(
      (item) => item.root === candidate
    );
    const standalone = this.projectsSnapshot.ungrouped.find(
      (item) => item.path === candidate
    );
    if (!project && !standalone) {
      return;
    }
    const removesCurrent =
      project?.workspaces.some((workspace) => workspace.current) ||
      standalone?.current;
    await this.setProjects(this.projects.remove(candidate));
    if (removesCurrent) {
      await this.threads.closeWorkspace();
    }
    this.render();
  }

  private async renameThread(): Promise<void> {
    const { selected } = this.threads.snapshot();
    if (!selected?.id) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: "Rename Thread",
      validateInput: (value) =>
        value.trim() ? undefined : "Enter a Thread name",
      value: selected.name,
    });
    if (name !== undefined) {
      await this.threads.rename(selected.id, name);
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
    this.view.badge = threads.attentionCount
      ? {
          tooltip: `${threads.attentionCount} Thread${threads.attentionCount === 1 ? "" : "s"} need attention`,
          value: threads.attentionCount,
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
