import { randomBytes } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { Projects, type ProjectsSnapshot, type Workspace } from "./projects/projects";
import { Threads, type ThreadInteractionResponse } from "./threads/threads";

const VIEW_ID = "mischief.view";

export class MischiefView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projectsSnapshot: ProjectsSnapshot = { projects: [], ungrouped: [] };

  constructor(
    private readonly projects: Projects,
    private readonly threads: Threads,
  ) {
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
    if (!selected?.[0]) return;
    this.projectsSnapshot = await this.projects.add(selected[0].fsPath);
    await this.syncThreads();
    this.render();
  }

  async refresh(): Promise<void> {
    this.projectsSnapshot = await this.projects.refresh();
    await this.syncThreads();
    this.render();
  }

  newThread(): void {
    this.threads.newThread();
    this.view?.show(true);
  }

  configurationChanged(): void {
    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.render();
  }

  private async syncThreads(): Promise<void> {
    const current = this.workspaces().find((workspace) => workspace.current);
    const active = this.threads.snapshot().workspace;
    if (current && active !== current.path) await this.threads.openWorkspace(current.path);
    else if (!current && active) await this.threads.closeWorkspace();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const data = message as Record<string, unknown>;
    try {
      if (data.type === "ready") this.render();
      else if (data.type === "add") await this.addWorkspace();
      else if (data.type === "refresh") await this.refresh();
      else if (data.type === "newThread") this.threads.newThread();
      else if (data.type === "openWorkspace" && typeof data.path === "string") {
        await this.openWorkspace(data.path);
      } else if (data.type === "removeMembership" && typeof data.path === "string") {
        await this.removeMembership(data.path);
      } else if (data.type === "selectThread" && typeof data.id === "string") {
        await this.threads.select(data.id);
      } else if (data.type === "removeThread" && typeof data.id === "string") {
        await this.threads.remove(data.id);
      } else if (data.type === "renameThread") {
        await this.renameThread();
      } else if (data.type === "prompt" && typeof data.text === "string") {
        if (data.text.length > 1_000_000) throw new Error("Prompt is too large");
        this.run(this.threads.prompt(data.text));
      } else if (data.type === "cancel") {
        await this.threads.cancel();
      } else if (data.type === "retry") {
        this.run(this.threads.retry());
      } else if (
        data.type === "setConfig" &&
        typeof data.id === "string" &&
        (typeof data.value === "string" || typeof data.value === "boolean")
      ) {
        await this.threads.setConfig(data.id, data.value);
      } else if (data.type === "respond" && typeof data.id === "string") {
        const response = interactionResponse(data.response);
        if (response) await this.threads.respond(data.id, response);
      } else if (data.type === "draftsConsumed") {
        this.threads.consumeDrafts();
      } else if (data.type === "authenticate") {
        this.authenticate();
      } else if (data.type === "openLocation" && typeof data.path === "string") {
        await this.openLocation(data.path, typeof data.line === "number" ? data.line : undefined);
      } else if (data.type === "openDiff" && typeof data.path === "string") {
        await this.openDiff(data.path);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Mischief: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private run(operation: Promise<void>): void {
    void operation.catch((error) => {
      void vscode.window.showErrorMessage(
        `Mischief: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async openWorkspace(candidate: string): Promise<void> {
    const workspace = this.workspaces().find((item) => item.path === candidate);
    if (!workspace || workspace.current) return;
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(candidate), {
      forceNewWindow: true,
    });
  }

  private async removeMembership(candidate: string): Promise<void> {
    const project = this.projectsSnapshot.projects.find((item) => item.root === candidate);
    const standalone = this.projectsSnapshot.ungrouped.find((item) => item.path === candidate);
    if (!project && !standalone) return;
    const removesCurrent =
      project?.workspaces.some((workspace) => workspace.current) || standalone?.current;
    this.projectsSnapshot = await this.projects.remove(candidate);
    if (removesCurrent) await this.threads.closeWorkspace();
    this.render();
  }

  private async renameThread(): Promise<void> {
    const selected = this.threads.snapshot().selected;
    if (!selected?.id) return;
    const name = await vscode.window.showInputBox({
      title: "Rename Thread",
      value: selected.name,
      validateInput: (value) => (value.trim() ? undefined : "Enter a Thread name"),
    });
    if (name !== undefined) await this.threads.rename(selected.id, name);
  }

  private authenticate(): void {
    const authentication = this.threads.snapshot().selected?.authentication;
    if (!authentication) return;
    const terminal = vscode.window.createTerminal({
      name: `Mischief: ${authentication.label}`,
      shellPath: authentication.command,
      shellArgs: authentication.args,
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
          entry.diffs?.some((diff) => diff.path === candidate),
      );
    if (!item) return;
    const selection = line && line > 0 ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
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
    if (!diff) return;
    const [before, after] = await Promise.all([
      vscode.workspace.openTextDocument({ content: diff.oldText ?? "" }),
      vscode.workspace.openTextDocument({ content: diff.newText }),
    ]);
    await vscode.commands.executeCommand(
      "vscode.diff",
      before.uri,
      after.uri,
      `${path.basename(candidate)} (Agent Diff)`,
    );
  }

  private workspaces(): Workspace[] {
    return [
      ...this.projectsSnapshot.projects.flatMap((project) => project.workspaces),
      ...this.projectsSnapshot.ungrouped,
    ];
  }

  private render(): void {
    if (!this.view) return;
    const font = vscode.workspace.getConfiguration("mischief").get<string>("fontFamily")?.trim();
    void this.view.webview.postMessage({
      type: "state",
      projects: this.projectsSnapshot,
      threads: this.threads.snapshot(),
      font: font || "var(--vscode-font-family)",
    });
  }
}

export function registerMischiefView(
  context: vscode.ExtensionContext,
  provider: MischiefView,
): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

function interactionResponse(value: unknown): ThreadInteractionResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const response = value as Record<string, unknown>;
  if (response.action === "cancel") return { action: "cancel" };
  if (response.action === "select" && typeof response.optionId === "string") {
    return { action: "select", optionId: response.optionId };
  }
  if (
    response.action === "accept" &&
    response.values &&
    typeof response.values === "object" &&
    !Array.isArray(response.values)
  ) {
    return { action: "accept", values: response.values as Record<string, unknown> };
  }
  return undefined;
}

function html(): string {
  const nonce = randomBytes(16).toString("hex");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root { --mischief-font: var(--vscode-font-family); }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size) var(--mischief-font); }
main { height: 100%; display: flex; flex-direction: column; }
section { min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border)); }
#projects { flex: 0 0 30%; }
#threads { flex: 0 0 20%; }
#thread { flex: 1; border-bottom: 0; }
header { min-height: 26px; padding: 4px 8px; display: flex; align-items: center; gap: 4px; background: var(--vscode-sideBarSectionHeader-background); font-size: 11px; font-weight: 600; text-transform: uppercase; }
header > .heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.empty { margin: auto; padding: 14px; color: var(--vscode-descriptionForeground); text-align: center; line-height: 1.5; }
#thread-header { flex-wrap: wrap; text-transform: none; }
#thread-title { font-size: 12px; }
#configs { width: 100%; display: flex; gap: 4px; overflow-x: auto; }
#configs:empty { display: none; }
#configs select { min-width: 0; flex: 1; border: 1px solid var(--vscode-dropdown-border); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); }
#transcript { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.entry { margin: 0 0 10px; border-left: 2px solid transparent; padding-left: 8px; overflow-wrap: anywhere; }
.entry.user { border-color: var(--vscode-charts-purple); }
.entry.assistant { border-color: var(--vscode-textLink-foreground); }
.entry.thought { border-color: var(--vscode-charts-yellow); color: var(--vscode-descriptionForeground); }
.entry.plan { border-color: var(--vscode-charts-green); }
.role { margin-bottom: 3px; color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; }
.body, pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; line-height: 1.45; }
details.entry > summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
.tool-body { margin-top: 6px; }
.tool-body pre { margin: 4px 0; padding: 6px; background: var(--vscode-textCodeBlock-background); max-height: 180px; overflow: auto; }
.link { border: 0; padding: 2px 0; display: block; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; text-align: left; }
#notice { padding: 0 8px; color: var(--vscode-errorForeground); white-space: pre-wrap; }
#actions { padding: 4px 8px; display: flex; gap: 5px; }
#actions:empty, #interaction:empty { display: none; }
#interaction { margin: 5px 8px; padding: 8px; border: 1px solid var(--vscode-focusBorder); background: var(--vscode-editorWidget-background); }
#interaction .message { margin-bottom: 7px; }
#interaction label { display: block; margin: 6px 0; }
#interaction input:not([type=checkbox]), #interaction select, #interaction textarea { display: block; width: 100%; margin-top: 3px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 4px; }
.interaction-buttons { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.action { border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 3px 8px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
.action.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
footer { border-top: 1px solid var(--vscode-panel-border); padding: 7px; background: var(--vscode-sideBar-background); }
#composer { display: block; width: 100%; min-height: 58px; max-height: 160px; resize: vertical; border: 1px solid var(--vscode-input-border); border-radius: 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 6px; outline: none; }
#composer:focus { border-color: var(--vscode-focusBorder); }
.footer-row { margin-top: 5px; display: flex; align-items: center; gap: 5px; }
#hint { flex: 1; color: var(--vscode-descriptionForeground); font-size: 11px; }
.cancelled { color: var(--vscode-descriptionForeground); font-size: 10px; }
</style>
</head>
<body>
<main>
  <section id="projects"><header><span class="heading">Projects / Workspaces</span><button class="icon" id="add" title="Add Workspace" aria-label="Add Workspace">＋</button><button class="icon" id="refresh" title="Refresh" aria-label="Refresh">↻</button></header><div class="content" id="project-list"></div></section>
  <section id="threads"><header><span class="heading" id="threads-title">Threads</span><button class="icon" id="new-thread" title="New Thread" aria-label="New Thread">＋</button></header><div class="content" id="thread-list"></div></section>
  <section id="thread"><header id="thread-header"><span class="heading" id="thread-title">Thread</span><button class="icon" id="rename-thread" title="Rename Thread" aria-label="Rename Thread">✎</button><div id="configs"></div></header><div id="transcript"></div><div id="notice"></div><div id="actions"></div><div id="interaction"></div><footer><textarea id="composer" placeholder="Message MagPi…"></textarea><div class="footer-row"><span id="hint">⌘↵ to send</span><button class="action" id="stop">Stop</button><button class="action primary" id="send">Send</button></div></footer></section>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let state = { projects: { projects: [], ungrouped: [] }, threads: { threads: [] } };
let renderedThread;
let consumedDrafts = '';
const openTools = new Set();

$('add').addEventListener('click', () => vscode.postMessage({ type: 'add' }));
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('new-thread').addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
$('rename-thread').addEventListener('click', () => vscode.postMessage({ type: 'renameThread' }));
$('stop').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
$('send').addEventListener('click', send);
$('composer').addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); send(); }
});

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
    const select = document.createElement('select');
    select.title = config.description || config.name;
    select.setAttribute('aria-label', config.name);
    for (const item of config.options) {
      if ('value' in item) select.append(option(item.value, item.name));
      else {
        const group = document.createElement('optgroup');
        group.label = item.name;
        for (const child of item.options) group.append(option(child.value, child.name));
        select.append(group);
      }
    }
    select.value = config.currentValue;
    select.addEventListener('change', () => vscode.postMessage({ type: 'setConfig', id: config.id, value: select.value }));
    configs.append(select);
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
  const transcript = $('transcript');
  const changed = renderedThread !== selected?.id;
  const stick = changed || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
  renderedThread = selected?.id;
  if (changed) openTools.clear();
  transcript.replaceChildren();
  $('thread-title').textContent = selected?.name || 'Thread';
  $('rename-thread').disabled = !selected?.id;
  renderConfig(selected);
  $('notice').textContent = selected?.error || '';
  renderActions(selected);
  renderInteraction(selected?.interaction);
  $('composer').disabled = !selected;
  $('send').disabled = !selected;
  $('stop').disabled = !selected || !['running', 'waiting'].includes(selected.status);

  if (!selected) empty(transcript, 'Select a managed Workspace.');
  else if (!selected.items.length) empty(transcript, 'Send a prompt to start this Thread.');
  else for (const item of selected.items) transcript.append(transcriptItem(item));

  const draftKey = selected?.id + ':' + (selected?.drafts || []).join('\\u0000');
  if (!selected?.drafts?.length) consumedDrafts = '';
  if (selected?.drafts?.length && consumedDrafts !== draftKey) {
    const box = $('composer');
    box.value = [box.value, ...selected.drafts].filter(Boolean).join('\\n\\n');
    consumedDrafts = draftKey;
    vscode.postMessage({ type: 'draftsConsumed' });
  }
  if (stick) transcript.scrollTop = transcript.scrollHeight;
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

function transcriptItem(item) {
  if (item.kind === 'tool') {
    const details = document.createElement('details');
    details.className = 'entry tool';
    details.open = openTools.has(item.id);
    details.addEventListener('toggle', () => details.open ? openTools.add(item.id) : openTools.delete(item.id));
    const summary = document.createElement('summary');
    summary.textContent = '⚙ ' + (item.title || 'Tool call') + (item.status ? ' · ' + item.status : '');
    const body = document.createElement('div');
    body.className = 'tool-body';
    if (item.input) body.append(labelledPre('Input', item.input));
    if (item.output) body.append(labelledPre('Output', item.output));
    for (const location of item.locations || []) body.append(linkButton(location.path + (location.line ? ':' + location.line : ''), () => vscode.postMessage({ type: 'openLocation', path: location.path, line: location.line })));
    for (const diff of item.diffs || []) body.append(linkButton('Open diff · ' + diff.path, () => vscode.postMessage({ type: 'openDiff', path: diff.path })));
    details.append(summary, body);
    return details;
  }
  if (item.kind === 'plan') {
    const details = document.createElement('details');
    details.className = 'entry plan';
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = item.title || 'Plan';
    const body = document.createElement('pre');
    body.className = 'body';
    body.textContent = item.text || '';
    details.append(summary, body);
    return details;
  }
  const article = document.createElement('article');
  article.className = 'entry ' + item.kind;
  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = item.kind === 'user' ? 'You' : item.kind === 'assistant' ? 'Pi' : item.kind === 'thought' ? 'Thinking' : 'Mischief';
  const body = document.createElement('pre');
  body.className = 'body';
  body.textContent = item.text || '';
  article.append(role, body);
  if (item.queued) {
    const queued = document.createElement('div');
    queued.className = 'cancelled';
    queued.textContent = 'Queued · position ' + item.queued;
    article.append(queued);
  }
  if (item.cancelled) {
    const cancelled = document.createElement('div');
    cancelled.className = 'cancelled';
    cancelled.textContent = 'Cancelled';
    article.append(cancelled);
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
  document.documentElement.style.setProperty('--mischief-font', state.font);
  renderProjects();
  renderThreads();
  renderTranscript();
});
setInterval(renderThreads, 60000);
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
