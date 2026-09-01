import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import { Projects } from "./projects/projects";
import { acpConnectionFactory } from "./threads/acp";
import type { AgentLaunch } from "./threads/acp";
import { Threads } from "./threads/threads";
import { MischiefView, registerMischiefView } from "./view";
import { ensureWorkspaceColors } from "./workspace-colors";

const agentLaunch = (context: vscode.ExtensionContext): AgentLaunch => {
  const env = { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" };
  const configured = vscode.workspace
    .getConfiguration("mischief")
    .get<string>("magpiAcpPath")
    ?.trim();
  if (configured) {
    return configured.endsWith(".js")
      ? { args: [configured], command: "node", env }
      : { args: [], command: configured, env };
  }

  const local = [
    path.resolve(context.extensionPath, "../magpi-acp/dist/index.js"),
    path.join(homedir(), "Projects/_tools/magpi-acp/dist/index.js"),
  ].find(existsSync);
  return local
    ? { args: [local], command: "node", env }
    : { args: [], command: "magpi-acp", env };
};

export const activate = async (
  context: vscode.ExtensionContext
): Promise<void> => {
  const output = vscode.window.createOutputChannel("Mischief");
  const threads = new Threads(
    context.globalState,
    acpConnectionFactory(agentLaunch(context), (message) =>
      output.appendLine(message)
    )
  );
  const view = new MischiefView(
    new Projects(context.globalState),
    threads,
    context.extensionUri,
    context.globalState
  );
  context.subscriptions.push(output, { dispose: () => threads.dispose() });
  registerMischiefView(context, view);

  context.subscriptions.push(
    vscode.commands.registerCommand("mischief.addWorkspace", () =>
      view.addWorkspace()
    ),
    vscode.commands.registerCommand("mischief.refresh", () => view.refresh()),
    vscode.commands.registerCommand("mischief.newThread", () =>
      view.newThread()
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mischief.fontFamily")) {
        view.configurationChanged();
      }
    })
  );

  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    if (folder && (await ensureWorkspaceColors(folder))) {
      output.appendLine("Applied workspace colors from the active theme");
    }
  } catch (error) {
    output.appendLine(
      `Workspace colors were not applied: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    await view.initialize(folder);
    output.appendLine("Mischief activated");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Activation failed: ${message}`);
    void vscode.window.showErrorMessage(`Mischief: ${message}`);
  }
};

export const deactivate = (): void => {
  // VS Code calls this hook when no cleanup is needed.
};
