import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { Projects } from "./projects/projects";
import { acpConnectionFactory, type AgentLaunch } from "./threads/acp";
import { Threads } from "./threads/threads";
import { MischiefView, registerMischiefView } from "./view";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Mischief");
  const threads = new Threads(
    context.globalState,
    acpConnectionFactory(agentLaunch(context), (message) => output.appendLine(message)),
  );
  const view = new MischiefView(new Projects(context.globalState), threads);
  context.subscriptions.push(output, { dispose: () => threads.dispose() });
  registerMischiefView(context, view);

  context.subscriptions.push(
    vscode.commands.registerCommand("mischief.addWorkspace", () => view.addWorkspace()),
    vscode.commands.registerCommand("mischief.refresh", () => view.refresh()),
    vscode.commands.registerCommand("mischief.newThread", () => view.newThread()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mischief.fontFamily")) view.configurationChanged();
    }),
  );

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    await view.initialize(folder);
    output.appendLine("Mischief activated");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Activation failed: ${message}`);
    void vscode.window.showErrorMessage(`Mischief: ${message}`);
  }
}

function agentLaunch(context: vscode.ExtensionContext): AgentLaunch {
  const configured = vscode.workspace
    .getConfiguration("mischief")
    .get<string>("magpiAcpPath")
    ?.trim();
  if (configured) {
    return configured.endsWith(".js")
      ? { command: "node", args: [configured] }
      : { command: configured, args: [] };
  }

  const local = [
    path.resolve(context.extensionPath, "../magpi-acp/dist/index.js"),
    path.join(homedir(), "Projects/_tools/magpi-acp/dist/index.js"),
  ].find(existsSync);
  return local ? { command: "node", args: [local] } : { command: "magpi-acp", args: [] };
}

export function deactivate() {}
