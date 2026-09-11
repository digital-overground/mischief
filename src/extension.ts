import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as vscode from "vscode";

import { ProfileDatabase } from "./profile-database/profile-database";
import { Projects } from "./projects/projects";
import { acpConnectionFactory } from "./threads/acp";
import type { AgentLaunch } from "./threads/acp";
import { Threads } from "./threads/threads";
import { MischiefView, registerMischiefView } from "./view";

const PROJECTS_KEY = "mischief.projects";
const PROJECTS_VERSION_KEY = "mischief.profileDatabaseProjectsVersion";
let database: ProfileDatabase | undefined;

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
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const currentWorkspace = folder ? await realpath(folder) : undefined;
  const log = (message: string): void => output.appendLine(message);
  database = await ProfileDatabase.open({
    currentWorkspace,
    instanceId: randomUUID(),
    log,
    profileDirectory: context.globalStorageUri.fsPath,
  });
  const projects = new Projects(database);
  if (context.globalState.get<number>(PROJECTS_VERSION_KEY, 0) < 1) {
    await projects.importPreviousWorkspaces(
      context.globalState.get<unknown>(PROJECTS_KEY)
    );
    await context.globalState.update(PROJECTS_VERSION_KEY, 1);
  }
  const threads = new Threads(
    context.globalState,
    acpConnectionFactory(agentLaunch(context), log)
  );
  const view = new MischiefView(
    projects,
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
    vscode.commands.registerCommand("mischief.settings", () =>
      view.showSettings()
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mischief.fontFamily")) {
        view.configurationChanged();
      }
    })
  );

  try {
    await view.initialize(folder);
    output.appendLine("Mischief activated");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`Activation failed: ${message}`);
    void vscode.window.showErrorMessage(`Mischief: ${message}`);
  }
};

export const deactivate = async (): Promise<void> => {
  await database?.dispose();
  database = undefined;
};
