import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import * as vscode from "vscode";

import { isNonEmpty } from "./present";
import { ProfileDatabase } from "./profile-database/profile-database";
import { locateWorkspace, Projects } from "./projects/projects";
import {
  addOnInstallCommand,
  missingRecommendedAddons,
  nextSoftwareRequirement,
} from "./setup";
import type { SoftwareRequirement } from "./setup";
import { acpConnectionFactory } from "./threads/acp";
import type { AgentLaunch } from "./threads/acp";
import { Threads } from "./threads/threads";
import { MischiefView, registerMischiefView } from "./view";
import type { ThreadSetup } from "./view";
import type { SetupStep } from "./webview/protocol";

const ADDONS_OFFERED_KEY = "mischief.addonsOffered";
const AGENT_INSTALL_COMMAND =
  "npm install -g @earendil-works/pi-coding-agent magpi-acp";

const PROJECTS_KEY = "mischief.projects";
const PROJECTS_VERSION_KEY = "mischief.profileDatabaseProjectsVersion";
const THREADS_KEY = "mischief.threads";
const THREADS_VERSION_KEY = "mischief.profileDatabaseThreadsVersion";
let database: ProfileDatabase | undefined;
let activeThreads: Threads | undefined;

const agentLaunch = (context: vscode.ExtensionContext): AgentLaunch => {
  const env = { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" };
  const configured = vscode.workspace
    .getConfiguration("mischief")
    .get<string>("magpiAcpPath")
    ?.trim();
  if (isNonEmpty(configured)) {
    return configured.endsWith(".js")
      ? { args: [configured], command: "node", env }
      : { args: [], command: configured, env };
  }

  const local = path.resolve(
    context.extensionPath,
    "../magpi-acp/dist/index.js"
  );
  return existsSync(local)
    ? { args: [local], command: "node", env }
    : { args: [], command: "magpi-acp", env };
};

const softwareSetup = (
  launch: AgentLaunch,
  storage: vscode.Memento
): ThreadSetup => {
  let installingAddons = false;
  let waitingFor: SoftwareRequirement | undefined;
  const prompt = (): SetupStep | undefined => {
    const requirement = nextSoftwareRequirement(launch);
    if (requirement) {
      if (waitingFor && waitingFor !== requirement) {
        waitingFor = undefined;
      }
      if (requirement === "node") {
        return {
          id: "node",
          message: waitingFor
            ? "Install Node.js, then press Enter to check again."
            : "Node.js was not detected. Press Enter to open the Node.js install page.",
        };
      }
      if (requirement === "git") {
        return {
          id: "git",
          message: waitingFor
            ? "Install Git, then press Enter to check again."
            : "Git was not detected. Press Enter to open the Git install page.",
        };
      }
      return {
        id: "agents",
        message: waitingFor
          ? "The install command is running in the Mischief Setup terminal. When it finishes, press Enter to check again."
          : `Pi or MagPi ACP was not detected. Press Enter to run:\n\n\`${AGENT_INSTALL_COMMAND}\``,
      };
    }
    waitingFor = undefined;
    if (installingAddons) {
      return {
        id: "installing-addons",
        message:
          "The selected add-ons are installing in the Mischief Setup terminal. When it finishes, press Enter to continue.",
      };
    }
    const addons = missingRecommendedAddons();
    return storage.get<boolean>(ADDONS_OFFERED_KEY, false) ||
      addons.length === 0
      ? undefined
      : {
          id: "addons",
          message:
            "Recommended Pi add-ons. Select what to install, then press Enter to continue.",
          options: addons,
        };
  };

  return {
    advance: async (selected) => {
      const requirement = nextSoftwareRequirement(launch);
      if (requirement && waitingFor === requirement) {
        return prompt();
      }
      if (waitingFor) {
        waitingFor = undefined;
        return prompt();
      }
      if (requirement) {
        waitingFor = requirement;
        if (requirement === "node") {
          await vscode.env.openExternal(
            vscode.Uri.parse("https://nodejs.org/en/download")
          );
        } else if (requirement === "git") {
          await vscode.env.openExternal(
            vscode.Uri.parse("https://git-scm.com/downloads")
          );
        } else {
          const terminal = vscode.window.createTerminal("Mischief Setup");
          terminal.show();
          terminal.sendText(AGENT_INSTALL_COMMAND, true);
        }
        return prompt();
      }
      if (installingAddons) {
        installingAddons = false;
        return prompt();
      }

      await storage.update(ADDONS_OFFERED_KEY, true);
      const command = addOnInstallCommand(selected);
      if (!isNonEmpty(command)) {
        return prompt();
      }
      installingAddons = true;
      const terminal = vscode.window.createTerminal("Mischief Setup");
      terminal.show();
      terminal.sendText(command, true);
      return prompt();
    },
    prompt,
  };
};

export const activate = async (
  context: vscode.ExtensionContext
): Promise<void> => {
  const output = vscode.window.createOutputChannel("Mischief");
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const workspace = isNonEmpty(folder)
    ? await locateWorkspace(folder)
    : undefined;
  const log = (message: string): void => {
    output.appendLine(message);
  };
  database = await ProfileDatabase.open({
    currentWorkspace: workspace?.path,
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
  if (context.globalState.get<number>(THREADS_VERSION_KEY, 0) < 1) {
    await database.importPreviousThreads(
      context.globalState.get<unknown>(THREADS_KEY)
    );
    await context.globalState.update(THREADS_VERSION_KEY, 1);
  }
  const launch = agentLaunch(context);
  const threads = new Threads(database, acpConnectionFactory(launch, log));
  activeThreads = threads;
  const view = new MischiefView(
    projects,
    threads,
    context.extensionUri,
    context.globalState,
    database,
    softwareSetup(launch, context.globalState)
  );
  context.subscriptions.push(output);
  registerMischiefView(context, view);

  context.subscriptions.push(
    vscode.commands.registerCommand("mischief.addWorkspace", async () => {
      await view.addWorkspace();
    }),
    vscode.commands.registerCommand("mischief.refresh", async () => {
      await view.refresh();
    }),
    vscode.commands.registerCommand("mischief.expandAll", () => {
      view.setAllExpanded(true);
    }),
    vscode.commands.registerCommand("mischief.collapseAll", () => {
      view.setAllExpanded(false);
    }),
    vscode.commands.registerCommand("mischief.newThread", async () => {
      await view.newThread();
    }),
    vscode.commands.registerCommand("mischief.settings", () => {
      view.showSettings();
    }),
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
  await activeThreads?.dispose();
  activeThreads = undefined;
  await database?.dispose();
  database = undefined;
};
