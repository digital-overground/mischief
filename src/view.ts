import { randomBytes } from "node:crypto";
import path from "node:path";

import MarkdownIt from "markdown-it";
import * as vscode from "vscode";

import type {
  Projects,
  ProjectsSnapshot,
  Workspace,
} from "./projects/projects";
import type { ThreadInteractionResponse, Threads } from "./threads/threads";

const VIEW_ID = "mischief.view";
const DEFAULT_MONO_FONT_FAMILY =
  '"Lilex", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true });
// These helpers are assigned after the class declaration.
// oxlint-disable prefer-const
let html: () => string;
let interactionResponse: (
  value: unknown
) => ThreadInteractionResponse | undefined;
// oxlint-enable prefer-const

export class MischiefView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectsSnapshot: ProjectsSnapshot = { projects: [], ungrouped: [] };
  private readonly projects: Projects;
  private readonly threads: Threads;

  constructor(projects: Projects, threads: Threads) {
    this.projects = projects;
    this.threads = threads;
    threads.onChange(() => this.render());
  }

  async initialize(folder?: string): Promise<void> {
    this.projectsSnapshot = folder
      ? await this.projects.open(folder)
      : await this.projects.refresh();
    await this.syncThreads();
    this.render();
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
    this.projectsSnapshot = await this.projects.add(selected[0].fsPath);
    await this.syncThreads();
    this.render();
  }

  async refresh(): Promise<void> {
    this.projectsSnapshot = await this.projects.refresh();
    await this.syncThreads();
    this.render();
  }

  async newThread(): Promise<void> {
    const creating = this.threads.newThread();
    this.view?.show(true);
    await creating;
  }

  configurationChanged(): void {
    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    this.render();
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
    if (data.type === "newThread") {
      await this.threads.newThread();
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
    if (data.type === "renameThread") {
      await this.renameThread();
      return true;
    }
    if (data.type === "prompt" && typeof data.text === "string") {
      if (data.text.length > 1_000_000) {
        throw new Error("Prompt is too large");
      }
      void MischiefView.run(this.threads.prompt(data.text));
      return true;
    }
    if (data.type === "cancel") {
      await this.threads.cancel();
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

  private static async run(operation: Promise<void>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Mischief: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    this.projectsSnapshot = await this.projects.remove(candidate);
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

  private render(): void {
    if (!this.view) {
      return;
    }
    const font = vscode.workspace
      .getConfiguration("mischief")
      .get<string>("fontFamily")
      ?.trim();
    const threads = this.threads.snapshot();
    if (threads.selected) {
      threads.selected = {
        ...threads.selected,
        items: threads.selected.items.map((item) =>
          item.text && item.kind !== "plan" && item.kind !== "tool"
            ? { ...item, html: markdown.render(item.text) }
            : item
        ),
      };
    }
    const postMessage = this.view.webview.postMessage.bind(this.view.webview);
    void postMessage({
      font: font || DEFAULT_MONO_FONT_FAMILY,
      projects: this.projectsSnapshot,
      threads,
      type: "state",
    });
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

interactionResponse = (
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

html = (): string => {
  const nonce = randomBytes(16).toString("hex");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root {
  --mischief-ui-font: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mischief-mono-font: "Lilex", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
}
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--mischief-ui-font); font-size: 13px; }
main { height: 100%; display: flex; flex-direction: column; }
main > section { min-height: 72px; display: flex; flex-direction: column; flex-shrink: 1; overflow: hidden; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
#projects { flex: 0 1 30%; }
#threads { flex: 0 1 20%; }
#thread { flex: 1 1 50%; border-bottom: 0; }
main > section.collapsed { min-height: 26px; flex-basis: 26px !important; flex-grow: 0 !important; flex-shrink: 0; }
main > section.collapsed > :not(header) { display: none !important; }
.resizer { position: relative; z-index: 1; flex: 0 0 5px; cursor: row-resize; touch-action: none; }
.resizer::after { position: absolute; top: 2px; right: 0; left: 0; height: 1px; content: ""; background: var(--vscode-panel-border); }
.resizer:hover::after, .resizer:focus-visible::after, .resizer.active::after { background: var(--vscode-focusBorder); }
.resizer:focus-visible { outline: none; }
header { min-height: 26px; padding: 4px 8px; display: flex; align-items: center; gap: 4px; background: var(--vscode-sideBarSectionHeader-background); font-size: 11px; font-weight: 600; text-transform: uppercase; }
main > section > header { cursor: pointer; user-select: none; }
main > section > header::before { width: 10px; flex: none; content: "▾"; color: var(--vscode-descriptionForeground); }
main > section.collapsed > header::before { content: "▸"; }
header > .heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
header > .heading:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button, textarea, input, select { color: inherit; font: inherit; }
button:disabled, textarea:disabled, select:disabled { opacity: .5; cursor: default; }
.icon { border: 0; padding: 1px 5px; background: transparent; cursor: pointer; border-radius: 3px; }
.icon:not(:disabled):hover, .row:hover { background: var(--vscode-list-hoverBackground); }
.content { min-height: 0; overflow: auto; padding: 4px 0; }
.group-row, .row { width: 100%; min-height: 25px; display: flex; align-items: center; }
.group-row { padding: 2px 6px 2px 8px; font-weight: 600; }
.group-row .name, .row-open .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { padding-left: 20px; }
.row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row-open { min-width: 0; flex: 1; display: flex; align-items: center; gap: 6px; border: 0; padding: 3px 5px 3px 0; text-align: left; background: transparent; cursor: pointer; }
.meta { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
.selected .meta { color: inherit; opacity: .8; }
.empty { margin: 0; padding: 14px; color: var(--vscode-descriptionForeground); text-align: left; line-height: 1.5; }
#thread-header { text-transform: none; }
#thread-title { font-size: 12px; }
#configs { min-width: 0; flex: 1; display: flex; align-items: center; gap: 3px; overflow-x: auto; }
#configs:empty { display: none; }
#configs label { display: flex; align-items: center; gap: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap; }
.config-control { min-width: 0; display: flex; align-items: center; gap: 3px; }
.config-icon { display: inline-flex; flex: none; width: 14px; height: 14px; color: var(--vscode-descriptionForeground); }
#configs select { min-width: 0; max-width: 180px; height: 22px; border: 0; border-radius: 3px; padding: 1px 5px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); font-size: 11px; }
.lucide { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
#chat { flex: 1; min-height: 0; overflow: auto; padding: 8px; font-family: var(--mischief-mono-font); font-size: 13px; }
#transcript { min-height: 0; }
.entry { --entry-accent: var(--vscode-descriptionForeground); margin: 0 0 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-left: 2px solid var(--entry-accent); border-radius: 4px; padding: 8px 9px; overflow-wrap: anywhere; background: var(--vscode-editorWidget-background); background: color-mix(in srgb, var(--entry-accent) 7%, var(--vscode-editor-background, var(--vscode-sideBar-background))); }
article.entry { display: flex; align-items: flex-start; gap: 8px; }
.entry.user { --entry-accent: var(--vscode-charts-purple); }
.entry.assistant { --entry-accent: var(--vscode-textLink-foreground); }
.entry.thought { --entry-accent: var(--vscode-charts-yellow); color: var(--vscode-descriptionForeground); }
.entry.tool { --entry-accent: var(--vscode-charts-orange, var(--vscode-charts-yellow)); }
.entry.system { --entry-accent: var(--vscode-descriptionForeground); }
.entry-icon { flex: none; display: inline-flex; width: 14px; height: 14px; margin-top: 1px; color: var(--entry-accent); }
.entry-content { flex: 1; min-width: 0; }
.body, pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mischief-mono-font); line-height: 1.35; }
.thinking-group { display: block; }
.thinking-heading { display: flex; align-items: center; gap: 8px; font-family: var(--mischief-ui-font); font-weight: 500; }
.thinking-content { margin: 8px 0 0 6px; border-left: 1px solid color-mix(in srgb, var(--entry-accent) 45%, transparent); padding-left: 15px; }
.thinking-item { font-weight: 600; }
.thinking-item + .thinking-item { margin-top: 9px; }
.markdown { white-space: normal; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown p, .markdown ul, .markdown ol, .markdown blockquote, .markdown pre, .markdown table { margin: 0 0 8px; }
.markdown ul, .markdown ol { padding-left: 20px; }
.markdown li + li { margin-top: 3px; }
.markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 12px 0 6px; font-family: var(--mischief-ui-font); line-height: 1.2; }
.markdown h1 { font-size: 1.3em; }
.markdown h2 { font-size: 1.2em; }
.markdown h3, .markdown h4 { font-size: 1.1em; }
.markdown code { border-radius: 3px; padding: 1px 3px; background: var(--vscode-textCodeBlock-background); font-family: var(--mischief-mono-font); }
.markdown pre { overflow-x: auto; padding: 8px; background: var(--vscode-textCodeBlock-background); white-space: pre; }
.markdown pre code { padding: 0; background: transparent; }
.markdown blockquote { border-left: 2px solid var(--vscode-textBlockQuote-border); padding-left: 9px; color: var(--vscode-descriptionForeground); }
.markdown a { color: var(--vscode-textLink-foreground); }
.markdown table { width: 100%; border-collapse: collapse; }
.markdown th, .markdown td { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); padding: 4px 6px; text-align: left; }
.markdown hr { border: 0; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
details.entry > summary { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--vscode-descriptionForeground); font-family: var(--mischief-ui-font); list-style: none; }
details.entry > summary::-webkit-details-marker { display: none; }
.tool-body { margin: 7px 0 0 22px; }
.tool-body pre { margin: 4px 0; padding: 6px; background: var(--vscode-textCodeBlock-background); max-height: 180px; overflow: auto; }
.link { border: 0; padding: 2px 0; display: block; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; font-family: var(--mischief-ui-font); text-align: left; }
#notice { padding: 0 8px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
#actions { padding: 4px 8px; display: flex; gap: 5px; }
#actions:empty, #interaction:empty { display: none; }
#interaction { margin: 5px 8px; padding: 8px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); }
#interaction .message { margin-bottom: 7px; }
#interaction label { display: block; margin: 6px 0; }
#interaction input:not([type=checkbox]), #interaction select, #interaction textarea { display: block; width: 100%; margin-top: 3px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 4px; }
#plan { flex: none; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background, var(--vscode-sideBar-background)); }
#plan[hidden] { display: none; }
#plan-title { display: flex; align-items: center; gap: 6px; padding: 6px 10px 3px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; }
.plan-icon { display: inline-flex; width: 13px; height: 13px; color: var(--vscode-charts-green); }
#plan-body { max-height: 110px; overflow-y: auto; padding: 0 10px 7px 29px; font-size: 12px; }
.interaction-buttons { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.action { border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 3px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
.action.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
footer { border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background, var(--vscode-sideBar-background)); }
#processing { padding: 2px 10px 10px 12px; color: var(--vscode-textLink-foreground); font-family: var(--mischief-mono-font); font-size: 18px; line-height: 1; }
#processing[hidden] { display: none; }
#composer { display: block; width: 100%; min-height: 86px; max-height: 220px; resize: vertical; border: 0; background: transparent; color: var(--vscode-input-foreground); padding: 12px 14px 6px; outline: none; font-family: var(--mischief-mono-font); font-size: 13px; line-height: 1.35; }
#composer:focus { outline: none; }
.footer-row { min-height: 28px; display: flex; align-items: center; gap: 4px; padding: 2px 6px 4px; }
#send { width: 22px; min-width: 22px; height: 22px; margin-left: auto; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
#send .lucide { width: 14px; height: 14px; }
#send .stop-icon { display: none; fill: currentColor; }
#send.stop { color: var(--vscode-errorForeground); }
#send.stop .send-icon { display: none; }
#send.stop .stop-icon { display: block; }
.cancelled { color: var(--vscode-descriptionForeground); font-size: 10px; }
</style>
</head>
<body>
<main>
  <section id="projects"><header><span class="heading">Projects / Workspaces</span><button class="icon" id="add" title="Add Workspace" aria-label="Add Workspace">＋</button><button class="icon" id="refresh" title="Refresh" aria-label="Refresh">↻</button></header><div class="content" id="project-list"></div></section>
  <div class="resizer" data-before="projects" data-after="threads" role="separator" aria-label="Resize Projects and Threads" aria-orientation="horizontal" tabindex="0"></div>
  <section id="threads"><header><span class="heading" id="threads-title">Threads</span><button class="icon" id="new-thread" title="New Thread" aria-label="New Thread">＋</button></header><div class="content" id="thread-list"></div></section>
  <div class="resizer" data-before="threads" data-after="thread" role="separator" aria-label="Resize Threads and Thread" aria-orientation="horizontal" tabindex="0"></div>
  <section id="thread"><header id="thread-header"><span class="heading" id="thread-title">Thread</span><button class="icon" id="rename-thread" title="Rename Thread" aria-label="Rename Thread">✎</button></header><div id="chat"><div id="transcript"></div><div id="processing" role="status" aria-label="Agent is working" hidden><span id="braille" aria-hidden="true">⠋</span></div><div id="notice"></div><div id="actions"></div><div id="interaction"></div></div><div id="plan" hidden><div id="plan-title"></div><pre id="plan-body"></pre></div><footer><textarea id="composer" placeholder="Message magpi-acp — @ to include context, / for commands"></textarea><div class="footer-row"><div id="configs"></div><button class="action" id="send" title="Send" aria-label="Send"><svg class="lucide send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg><svg class="lucide stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"></rect></svg></button></div></footer></section>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let state = { projects: { projects: [], ungrouped: [] }, threads: { threads: [] } };
let renderedThread;
let consumedDrafts = '';
let brailleFrame = 0;
const brailleFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const openTools = new Set();
const panes = [...document.querySelectorAll('main > section')];
const MIN_PANE_HEIGHT = 72;
const COLLAPSED_PANE_HEIGHT = 26;

$('add').addEventListener('click', () => vscode.postMessage({ type: 'add' }));
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('new-thread').addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
$('rename-thread').addEventListener('click', () => vscode.postMessage({ type: 'renameThread' }));
$('send').addEventListener('click', () => {
  if (state.threads.selected && ['running', 'waiting'].includes(state.threads.selected.status)) {
    vscode.postMessage({ type: 'cancel' });
  } else {
    send();
  }
});
$('composer').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
});
setupPanes();

function setupPanes() {
  for (const pane of panes) {
    const header = pane.querySelector(':scope > header');
    const toggle = header.querySelector(':scope > .heading');
    toggle.tabIndex = 0;
    toggle.setAttribute('role', 'button');
    toggle.setAttribute('aria-expanded', 'true');
    header.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      togglePane(pane);
    });
    toggle.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      togglePane(pane);
    });
  }
  for (const resizer of document.querySelectorAll('.resizer')) setupResizer(resizer);
  rebalancePanes();
}

function togglePane(pane) {
  const collapsed = !pane.classList.contains('collapsed');
  const toggle = pane.querySelector(':scope > header > .heading');
  if (collapsed) pane.dataset.expandedHeight = pane.getBoundingClientRect().height;
  pane.classList.toggle('collapsed', collapsed);
  pane.style.flexBasis = (collapsed ? COLLAPSED_PANE_HEIGHT : Number(pane.dataset.expandedHeight) || MIN_PANE_HEIGHT) + 'px';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  rebalancePanes();
}

function rebalancePanes() {
  const expanded = panes.filter((pane) => !pane.classList.contains('collapsed'));
  for (const pane of panes) pane.style.flexGrow = '0';
  if (expanded.length) expanded.at(-1).style.flexGrow = '1';
}

function setupResizer(resizer) {
  let previousY;
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !resizePanes(resizer, 0)) return;
    event.preventDefault();
    previousY = event.clientY;
    resizer.classList.add('active');
    resizer.setPointerCapture(event.pointerId);
  });
  resizer.addEventListener('pointermove', (event) => {
    if (previousY === undefined) return;
    resizePanes(resizer, event.clientY - previousY);
    previousY = event.clientY;
  });
  const stop = () => {
    previousY = undefined;
    resizer.classList.remove('active');
  };
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);
  resizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    resizePanes(resizer, event.key === 'ArrowUp' ? -12 : 12);
  });
}

function resizePanes(resizer, delta) {
  const before = $(resizer.dataset.before);
  const after = $(resizer.dataset.after);
  if (before.classList.contains('collapsed') || after.classList.contains('collapsed')) return false;
  const beforeHeight = before.getBoundingClientRect().height;
  const afterHeight = after.getBoundingClientRect().height;
  const total = beforeHeight + afterHeight;
  if (total < MIN_PANE_HEIGHT * 2) return false;
  const nextBefore = Math.max(MIN_PANE_HEIGHT, Math.min(total - MIN_PANE_HEIGHT, beforeHeight + delta));
  before.style.flexBasis = nextBefore + 'px';
  after.style.flexBasis = total - nextBefore + 'px';
  before.dataset.expandedHeight = nextBefore;
  after.dataset.expandedHeight = total - nextBefore;
  rebalancePanes();
  return true;
}

function send() {
  const box = $('composer');
  const text = box.value;
  if (!text.trim() || !state.threads.selected) return;
  vscode.postMessage({ type: 'prompt', text });
  box.value = '';
}

function iconButton(text, title, click) {
  const button = document.createElement('button');
  button.className = 'icon';
  button.textContent = text;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', click);
  return button;
}

function workspaceRow(workspace, removable = false) {
  const row = document.createElement('div');
  row.className = 'row' + (workspace.current ? ' selected' : '');
  const open = document.createElement('button');
  open.className = 'row-open';
  open.title = workspace.path;
  open.addEventListener('click', () => vscode.postMessage({ type: 'openWorkspace', path: workspace.path }));
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = (workspace.current ? '● ' : '') + workspace.name;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = [workspace.branch, workspace.linked ? 'worktree' : '', workspace.changes ? '✎' + workspace.changes : '', workspace.ahead ? '↑' + workspace.ahead : '', workspace.behind ? '↓' + workspace.behind : ''].filter(Boolean).join('  ');
  open.append(name, meta);
  row.append(open);
  if (workspace.current) row.append(iconButton('＋', 'New Thread', (event) => { event.stopPropagation(); vscode.postMessage({ type: 'newThread' }); }));
  if (removable) row.append(iconButton('×', 'Remove membership', () => vscode.postMessage({ type: 'removeMembership', path: workspace.path })));
  return row;
}

function projectGroup(project) {
  const fragment = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'group-row';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = project.name;
  row.append(name, iconButton('×', 'Remove membership', () => vscode.postMessage({ type: 'removeMembership', path: project.root })));
  fragment.append(row, ...project.workspaces.map((workspace) => workspaceRow(workspace)));
  return fragment;
}

function renderProjects() {
  const list = $('project-list');
  list.replaceChildren();
  for (const project of state.projects.projects) list.append(projectGroup(project));
  if (state.projects.ungrouped.length) {
    const heading = document.createElement('div');
    heading.className = 'group-row';
    heading.textContent = 'Ungrouped';
    list.append(heading);
    for (const workspace of state.projects.ungrouped) list.append(workspaceRow(workspace, true));
  }
  if (!state.projects.projects.length && !state.projects.ungrouped.length) empty(list, 'No managed Workspaces. Add one with ＋.');
}

function compactTime(value) {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return minutes + 'min';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

function renderThreads() {
  const list = $('thread-list');
  list.replaceChildren();
  const selected = state.threads.selected;
  $('threads-title').textContent = state.threads.workspace ? 'Threads' : 'Threads';
  $('new-thread').disabled = !state.threads.workspace;
  for (const thread of state.threads.threads) {
    const row = document.createElement('div');
    row.className = 'row' + (selected?.id === thread.id ? ' selected' : '');
    const open = document.createElement('button');
    open.className = 'row-open';
    open.addEventListener('click', () => vscode.postMessage({ type: 'selectThread', id: thread.id }));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = thread.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = thread.status + '  ' + compactTime(thread.updatedAt);
    open.append(name, meta);
    row.append(open, iconButton('×', 'Remove Thread', () => vscode.postMessage({ type: 'removeThread', id: thread.id })));
    list.append(row);
  }
  if (!state.threads.workspace) empty(list, 'Open a managed Workspace.');
  else if (!state.threads.threads.length) empty(list, 'No durable Threads yet.');
}

const icons = {
  alert: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg>',
  brain: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V5"></path><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"></path><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"></path><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"></path><path d="M18 18a4 4 0 0 0 2-7.464"></path><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"></path><path d="M6 18a4 4 0 0 1-2-7.464"></path><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"></path></svg>',
  bot: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>',
  plan: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 6h8"></path><path d="M13 12h8"></path><path d="M13 18h8"></path><path d="m3 17 2 2 4-4"></path><rect width="6" height="6" x="3" y="4" rx="1"></rect></svg>',
  tool: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-8 8l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 8-8z"></path></svg>',
  user: '<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>',
};

const entryMeta = {
  assistant: { icon: 'bot', label: 'Pi' },
  system: { icon: 'alert', label: 'Mischief' },
  thought: { icon: 'brain', label: 'Thinking' },
  user: { icon: 'user', label: 'You' },
};

function configKind(config) {
  const id = String(config.id || '').toLowerCase();
  const name = String(config.name || '').toLowerCase();
  if (id === 'model' || name === 'model') return 'model';
  if (id === 'thought_level' || id === 'thinking' || name.includes('thinking')) return 'thinking';
  return '';
}

function displayModelName(name) {
  const slash = name.indexOf('/');
  return slash > 0 ? name.slice(slash + 1) : name;
}

function appendOptions(select, config, kind) {
  if (kind === 'model') {
    const groups = new Map();
    for (const item of config.options) {
      if (!('value' in item)) {
        const group = document.createElement('optgroup');
        group.label = item.name;
        for (const child of item.options) group.append(option(child.value, displayModelName(child.name)));
        select.append(group);
        continue;
      }
      const slash = item.name.indexOf('/');
      if (slash < 1) {
        select.append(option(item.value, item.name));
        continue;
      }
      const provider = item.name.slice(0, slash);
      let group = groups.get(provider);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = provider;
        groups.set(provider, group);
        select.append(group);
      }
      group.append(option(item.value, displayModelName(item.name)));
    }
    return;
  }
  for (const item of config.options) {
    if ('value' in item) {
      const name = kind === 'thinking' ? item.name.replace(/^Thinking:\\s*/i, '') : item.name;
      select.append(option(item.value, name));
    } else {
      const group = document.createElement('optgroup');
      group.label = item.name;
      for (const child of item.options) group.append(option(child.value, child.name));
      select.append(group);
    }
  }
}

function inlineIcon(kind, className, title) {
  const icon = document.createElement('span');
  icon.className = className;
  icon.title = title;
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', title);
  icon.innerHTML = icons[kind];
  return icon;
}

function configIcon(kind, title) {
  return inlineIcon(kind, 'config-icon', title);
}

function renderConfig(selected) {
  const configs = $('configs');
  configs.replaceChildren();
  if (!selected) return;
  for (const config of selected.configOptions) {
    if (config.type === 'boolean') {
      const label = document.createElement('label');
      label.title = config.description || config.name;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = config.currentValue;
      input.addEventListener('change', () => vscode.postMessage({ type: 'setConfig', id: config.id, value: input.checked }));
      label.append(input, config.name);
      configs.append(label);
      continue;
    }
    const kind = configKind(config);
    const select = document.createElement('select');
    select.title = config.description || config.name;
    select.setAttribute('aria-label', config.name);
    appendOptions(select, config, kind);
    select.value = config.currentValue;
    select.addEventListener('change', () => vscode.postMessage({ type: 'setConfig', id: config.id, value: select.value }));
    if (kind) {
      const control = document.createElement('div');
      control.className = 'config-control';
      control.append(configIcon(kind === 'model' ? 'bot' : 'brain', config.name), select);
      configs.append(control);
    } else {
      configs.append(select);
    }
  }
}

function option(value, name) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = name;
  return item;
}

function renderTranscript() {
  const selected = state.threads.selected;
  const chat = $('chat');
  const transcript = $('transcript');
  const changed = renderedThread !== selected?.id;
  const stick = changed || chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
  renderedThread = selected?.id;
  if (changed) openTools.clear();
  transcript.replaceChildren();
  $('thread-title').textContent = selected?.name || 'Thread';
  $('rename-thread').disabled = !selected?.id;
  renderConfig(selected);
  $('notice').textContent = selected?.error || '';
  renderActions(selected);
  renderInteraction(selected?.interaction);
  renderPlan(selected);
  $('composer').disabled = !selected;
  $('processing').hidden = !selected || selected.status !== 'running' || selected.streaming;
  const running = selected && ['running', 'waiting'].includes(selected.status);
  const sendButton = $('send');
  sendButton.disabled = !selected;
  sendButton.title = running ? 'Stop' : 'Send';
  sendButton.setAttribute('aria-label', running ? 'Stop' : 'Send');
  sendButton.classList.toggle('stop', Boolean(running));

  const transcriptItems = selected?.items.filter((item) => item.kind !== 'plan') || [];
  if (!selected) empty(transcript, 'Select a managed Workspace.');
  else if (!transcriptItems.length) empty(transcript, 'Send a prompt to start this Thread.');
  else transcript.append(...transcriptNodes(transcriptItems));

  const draftKey = selected?.id + ':' + (selected?.drafts || []).join('\\u0000');
  if (!selected?.drafts?.length) consumedDrafts = '';
  if (selected?.drafts?.length && consumedDrafts !== draftKey) {
    const box = $('composer');
    box.value = [box.value, ...selected.drafts].filter(Boolean).join('\\n\\n');
    consumedDrafts = draftKey;
    vscode.postMessage({ type: 'draftsConsumed' });
  }
  if (stick) chat.scrollTop = chat.scrollHeight;
  if (changed && selected) $('composer').focus();
}

function renderActions(selected) {
  const actions = $('actions');
  actions.replaceChildren();
  if (!selected) return;
  if (selected.status === 'error') {
    const retry = actionButton('Retry', () => vscode.postMessage({ type: 'retry' }), true);
    actions.append(retry);
  }
  if (selected.authentication) actions.append(actionButton(selected.authentication.label, () => vscode.postMessage({ type: 'authenticate' }), true));
}

function renderPlan(selected) {
  const plan = selected?.items.find((item) => item.kind === 'plan' && item.text);
  const title = $('plan-title');
  $('plan').hidden = !plan;
  title.replaceChildren();
  if (plan) title.append(inlineIcon('plan', 'plan-icon', 'Plan'), plan.title || 'Plan');
  $('plan-body').textContent = plan?.text || '';
}

function transcriptNodes(items) {
  const nodes = [];
  for (let index = 0; index < items.length;) {
    if (items[index].kind !== 'thought') {
      nodes.push(transcriptItem(items[index]));
      index += 1;
      continue;
    }
    const thoughts = [];
    while (items[index]?.kind === 'thought') {
      thoughts.push(items[index]);
      index += 1;
    }
    nodes.push(thinkingGroup(thoughts));
  }
  return nodes;
}

function thinkingGroup(items) {
  const group = document.createElement('section');
  const heading = document.createElement('div');
  const content = document.createElement('div');
  group.className = 'entry thought thinking-group';
  heading.className = 'thinking-heading';
  content.className = 'thinking-content';
  heading.append(inlineIcon('brain', 'entry-icon', 'Thinking'), 'Thinking');
  for (const item of items) content.append(markdownBody(item, 'thinking-item markdown'));
  group.append(heading, content);
  return group;
}

function markdownBody(item, className = 'body markdown') {
  const body = document.createElement('div');
  body.className = className;
  if (item.html) body.innerHTML = item.html;
  else body.textContent = item.text || '';
  return body;
}

function transcriptItem(item) {
  if (item.kind === 'tool') {
    const details = document.createElement('details');
    details.className = 'entry tool';
    details.open = openTools.has(item.id);
    details.addEventListener('toggle', () => details.open ? openTools.add(item.id) : openTools.delete(item.id));
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = (item.title || 'Tool call') + (item.status ? ' · ' + item.status : '');
    summary.append(inlineIcon('tool', 'entry-icon', 'Tool'), label);
    const body = document.createElement('div');
    body.className = 'tool-body';
    if (item.input) body.append(labelledPre('Input', item.input));
    if (item.output) body.append(labelledPre('Output', item.output));
    for (const location of item.locations || []) body.append(linkButton(location.path + (location.line ? ':' + location.line : ''), () => vscode.postMessage({ type: 'openLocation', path: location.path, line: location.line })));
    for (const diff of item.diffs || []) body.append(linkButton('Open diff · ' + diff.path, () => vscode.postMessage({ type: 'openDiff', path: diff.path })));
    details.append(summary, body);
    return details;
  }
  const article = document.createElement('article');
  const meta = entryMeta[item.kind] || entryMeta.system;
  const content = document.createElement('div');
  article.className = 'entry ' + item.kind;
  content.className = 'entry-content';
  content.append(markdownBody(item));
  article.append(inlineIcon(meta.icon, 'entry-icon', meta.label), content);
  if (item.queued) {
    const queued = document.createElement('div');
    queued.className = 'cancelled';
    queued.textContent = 'Queued · position ' + item.queued;
    content.append(queued);
  }
  if (item.cancelled) {
    const cancelled = document.createElement('div');
    cancelled.className = 'cancelled';
    cancelled.textContent = 'Cancelled';
    content.append(cancelled);
  }
  return article;
}

function labelledPre(label, text) {
  const container = document.createElement('div');
  const heading = document.createElement('b');
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = text;
  container.append(heading, pre);
  return container;
}

function linkButton(label, click) {
  const button = document.createElement('button');
  button.className = 'link';
  button.textContent = label;
  button.addEventListener('click', click);
  return button;
}

function renderInteraction(interaction) {
  const container = $('interaction');
  container.replaceChildren();
  if (!interaction) return;
  const message = document.createElement('div');
  message.className = 'message';
  message.textContent = interaction.message;
  container.append(message);
  if (interaction.kind === 'permission') {
    const buttons = document.createElement('div');
    buttons.className = 'interaction-buttons';
    for (const item of interaction.options) buttons.append(actionButton(item.name, () => vscode.postMessage({ type: 'respond', id: interaction.id, response: { action: 'select', optionId: item.id } }), item.kind.startsWith('allow')));
    buttons.append(actionButton('Cancel', () => respondCancel(interaction.id)));
    container.append(buttons);
    return;
  }
  const form = document.createElement('form');
  for (const field of interaction.fields) form.append(formField(field));
  const buttons = document.createElement('div');
  buttons.className = 'interaction-buttons';
  buttons.append(actionButton('Submit', () => {}, true), actionButton('Cancel', () => respondCancel(interaction.id)));
  const submit = buttons.firstElementChild;
  submit.type = 'submit';
  form.append(buttons);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = {};
    for (const field of interaction.fields) {
      const input = form.elements.namedItem(field.name);
      if (field.type === 'boolean') values[field.name] = input.checked;
      else if (field.type === 'multiselect') values[field.name] = [...input.selectedOptions].map((item) => item.value);
      else if (field.required || input.value !== '') values[field.name] = input.value;
    }
    vscode.postMessage({ type: 'respond', id: interaction.id, response: { action: 'accept', values } });
  });
  container.append(form);
}

function formField(field) {
  const label = document.createElement('label');
  label.textContent = field.label + (field.required ? ' *' : '');
  let input;
  if (field.type === 'select' || field.type === 'multiselect') {
    input = document.createElement('select');
    input.multiple = field.type === 'multiselect';
    if (!field.required && field.type === 'select') input.append(option('', ''));
    for (const item of field.options || []) input.append(option(item.value, item.name));
    const defaults = Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue];
    for (const item of input.options) item.selected = defaults.includes(item.value);
  } else if (field.type === 'boolean') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(field.defaultValue);
  } else if (field.type === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    input.value = field.defaultValue ?? '';
  } else {
    input = document.createElement('textarea');
    input.rows = 2;
    input.value = field.defaultValue ?? '';
  }
  input.name = field.name;
  input.required = field.required && field.type !== 'boolean' && field.type !== 'multiselect';
  if (field.description) input.title = field.description;
  label.append(input);
  return label;
}

function respondCancel(id) {
  vscode.postMessage({ type: 'respond', id, response: { action: 'cancel' } });
}

function actionButton(label, click, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'action' + (primary ? ' primary' : '');
  button.textContent = label;
  button.addEventListener('click', click);
  return button;
}

function empty(container, text) {
  const message = document.createElement('div');
  message.className = 'empty';
  message.textContent = text;
  container.append(message);
}

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'state') return;
  state = event.data;
  document.documentElement.style.setProperty('--mischief-mono-font', state.font);
  renderProjects();
  renderThreads();
  renderTranscript();
});
setInterval(renderThreads, 60000);
setInterval(() => {
  if ($('processing').hidden) return;
  brailleFrame = (brailleFrame + 1) % brailleFrames.length;
  $('braille').textContent = brailleFrames[brailleFrame];
}, 60);
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
};
