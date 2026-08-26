import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { Projects, type ProjectsSnapshot, type Workspace } from "./projects/projects";

const VIEW_ID = "mischief.view";

export class MischiefView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private snapshot: ProjectsSnapshot = { projects: [], ungrouped: [] };

  constructor(private readonly projects: Projects) {}

  async initialize(folder?: string): Promise<void> {
    this.snapshot = folder ? await this.projects.open(folder) : await this.projects.refresh();
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
    this.snapshot = await this.projects.add(selected[0].fsPath);
    this.render();
  }

  async refresh(): Promise<void> {
    this.snapshot = await this.projects.refresh();
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

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const data = message as { type?: string; path?: string };
    try {
      if (data.type === "ready") this.render();
      else if (data.type === "add") await this.addWorkspace();
      else if (data.type === "refresh") await this.refresh();
      else if (data.type === "open" && data.path && this.isKnownWorkspace(data.path)) {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(data.path), {
          forceNewWindow: true,
        });
      } else if (data.type === "remove" && data.path && this.isKnownMembership(data.path)) {
        this.snapshot = await this.projects.remove(data.path);
        this.render();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Mischief: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private isKnownWorkspace(candidate: string): boolean {
    return this.workspaces().some((workspace) => workspace.path === candidate);
  }

  private isKnownMembership(candidate: string): boolean {
    return (
      this.snapshot.projects.some((project) => project.root === candidate) ||
      this.snapshot.ungrouped.some((workspace) => workspace.path === candidate)
    );
  }

  private workspaces(): Workspace[] {
    return [
      ...this.snapshot.projects.flatMap((project) => project.workspaces),
      ...this.snapshot.ungrouped,
    ];
  }

  private render(): void {
    if (!this.view) return;
    const font = vscode.workspace.getConfiguration("mischief").get<string>("fontFamily")?.trim();
    void this.view.webview.postMessage({
      type: "state",
      snapshot: this.snapshot,
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
#projects { flex: 0 0 42%; }
#threads { flex: 0 0 22%; }
#thread { flex: 1; border-bottom: 0; }
header { min-height: 26px; padding: 4px 8px; display: flex; align-items: center; gap: 4px; background: var(--vscode-sideBarSectionHeader-background); font-size: 11px; font-weight: 600; text-transform: uppercase; }
header span { flex: 1; }
button { color: inherit; font: inherit; }
.icon { border: 0; padding: 1px 5px; background: transparent; cursor: pointer; border-radius: 3px; }
.icon:hover, .workspace:hover { background: var(--vscode-list-hoverBackground); }
.content { overflow: auto; padding: 4px 0; }
.group-row { display: flex; align-items: center; min-height: 24px; padding: 2px 6px 2px 8px; font-weight: 600; }
.group-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace { width: 100%; min-height: 25px; display: flex; align-items: center; padding-left: 20px; }
.workspace.current { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.workspace-open { min-width: 0; flex: 1; display: flex; align-items: center; gap: 6px; border: 0; padding: 3px 8px 3px 0; text-align: left; background: transparent; cursor: pointer; }
.workspace .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
.current .meta { color: inherit; opacity: .8; }
.empty { margin: auto; padding: 14px; color: var(--vscode-descriptionForeground); text-align: center; line-height: 1.5; }
</style>
</head>
<body>
<main>
  <section id="projects"><header><span>Projects / Workspaces</span><button class="icon" id="add" title="Add Workspace" aria-label="Add Workspace">＋</button><button class="icon" id="refresh" title="Refresh" aria-label="Refresh">↻</button></header><div class="content" id="project-list"></div></section>
  <section id="threads"><header><span>Threads</span></header><div class="empty">Thread support is next.</div></section>
  <section id="thread"><header><span>Thread</span></header><div class="empty">Select or create a Thread after the next slice.</div></section>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const list = document.getElementById('project-list');
document.getElementById('add').addEventListener('click', () => vscode.postMessage({ type: 'add' }));
document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

function workspaceRow(workspace, removable = false) {
  const row = document.createElement('div');
  row.className = 'workspace' + (workspace.current ? ' current' : '');
  const open = document.createElement('button');
  open.className = 'workspace-open';
  open.title = workspace.path;
  open.addEventListener('click', () => vscode.postMessage({ type: 'open', path: workspace.path }));
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = (workspace.current ? '● ' : '') + workspace.name;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = [workspace.branch, workspace.linked ? 'worktree' : '', workspace.changes ? '✎' + workspace.changes : '', workspace.ahead ? '↑' + workspace.ahead : '', workspace.behind ? '↓' + workspace.behind : ''].filter(Boolean).join('  ');
  open.append(name, meta);
  row.append(open);
  if (removable) {
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.textContent = '×';
    remove.title = 'Remove membership';
    remove.setAttribute('aria-label', 'Remove ' + workspace.name);
    remove.addEventListener('click', () => vscode.postMessage({ type: 'remove', path: workspace.path }));
    row.append(remove);
  }
  return row;
}

function group(label, removePath, workspaces) {
  const fragment = document.createDocumentFragment();
  const row = document.createElement('div');
  row.className = 'group-row';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;
  const remove = document.createElement('button');
  remove.className = 'icon';
  remove.title = 'Remove membership';
  remove.setAttribute('aria-label', 'Remove ' + label);
  remove.textContent = '×';
  remove.addEventListener('click', () => vscode.postMessage({ type: 'remove', path: removePath }));
  row.append(name, remove);
  fragment.append(row, ...workspaces.map((workspace) => workspaceRow(workspace)));
  return fragment;
}

window.addEventListener('message', (event) => {
  if (event.data?.type !== 'state') return;
  document.documentElement.style.setProperty('--mischief-font', event.data.font);
  list.replaceChildren();
  const snapshot = event.data.snapshot;
  for (const project of snapshot.projects) list.append(group(project.name, project.root, project.workspaces));
  if (snapshot.ungrouped.length) {
    const heading = document.createElement('div');
    heading.className = 'group-row';
    heading.textContent = 'Ungrouped';
    list.append(heading);
    for (const workspace of snapshot.ungrouped) list.append(workspaceRow(workspace, true));
  }
  if (!snapshot.projects.length && !snapshot.ungrouped.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No managed Workspaces. Add one with ＋.';
    list.append(empty);
  }
});
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
