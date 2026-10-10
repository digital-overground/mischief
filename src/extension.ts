import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import { requestAgentInstall } from "./agents/install";
import { AgentManager } from "./agents/manager";
import { AGENTS, AGENT_IDS, DEFAULT_AGENT } from "./agents/update";
import type { AgentId } from "./agents/update";
import { isNonEmpty } from "./present";
import { ProfileDatabase } from "./profile-database/profile-database";
import { locateWorkspace, Projects } from "./projects/projects";
import {
  addOnInstallCommand,
  commandExists,
  missingRecommendedAddons,
  nextSoftwareRequirement,
} from "./setup";
import type { SoftwareRequirement } from "./setup";
import {
  acpConnectionFactory,
  probeAgent,
  unavailableAgent,
} from "./threads/acp/acp";
import { Threads } from "./threads/threads/threads";
import { MischiefView, registerMischiefView } from "./view";
import type { ThreadSetup } from "./view";
import type { SetupStep } from "./webview/protocol";

const ADDONS_OFFERED_KEY = "mischief.addonsOffered";
const PROJECTS_KEY = "mischief.projects";
const PROJECTS_VERSION_KEY = "mischief.profileDatabaseProjectsVersion";
const THREADS_KEY = "mischief.threads";
const THREADS_VERSION_KEY = "mischief.profileDatabaseThreadsVersion";
let database: ProfileDatabase | undefined;
let activeThreads: Threads | undefined;
let agentManager: AgentManager | undefined;

const softwareSetup = (
  manager: AgentManager,
  storage: vscode.Memento
): ThreadSetup => {
  let installingAddons = false;
  let waitingFor: SoftwareRequirement | undefined;
  let selectedAgent = manager.availableAgents()[0] ?? DEFAULT_AGENT;
  const nextRequirement = (): SoftwareRequirement | undefined =>
    nextSoftwareRequirement(manager.availableAgents().length > 0);
  const prompt = (agentId?: AgentId): SetupStep | undefined => {
    selectedAgent = agentId ?? selectedAgent;
    const requirement = nextRequirement();
    if (requirement) {
      if (waitingFor && waitingFor !== requirement) {
        waitingFor = undefined;
      }
      if (requirement === "node") {
        return {
          id: "node",
          message: waitingFor
            ? "Install Node.js 22.19 or newer and npm, then press Enter to check again."
            : "Node.js 22.19 or newer and npm are required. Press Enter to open the Node.js install page.",
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
        message:
          "At least one Agent ACP is required. Press Enter to choose MagPi, Claude Agent, or Codex to install in Mischief-owned storage. Subsequent updates are automatic.",
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
      addons.length === 0 ||
      selectedAgent !== DEFAULT_AGENT ||
      !manager.availableAgents().includes(DEFAULT_AGENT) ||
      (manager.piCli() === undefined && !commandExists("pi"))
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
      const requirement = nextRequirement();
      if (requirement === "agents") {
        const choice = await vscode.window.showQuickPick(
          AGENT_IDS.map((id) => ({ id, label: AGENTS[id].name })),
          { title: "Choose an Agent to install" }
        );
        if (choice) {
          await requestAgentInstall(manager, choice.id);
        }
        return prompt();
      }
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
        }
        return prompt();
      }
      if (installingAddons) {
        installingAddons = false;
        return prompt();
      }

      await storage.update(ADDONS_OFFERED_KEY, true);
      const command = addOnInstallCommand(selected, manager.piCli());
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
  const manager = new AgentManager(
    context.globalStorageUri.fsPath,
    context.extensionPath,
    vscode.workspace.getConfiguration("mischief").get<string>("magpiAcpPath"),
    probeAgent,
    { log }
  );
  agentManager = manager;
  const warnedCapabilities = new Set<string>();
  const threads = new Threads(
    database,
    (handlers, agentId = DEFAULT_AGENT) => {
      try {
        const launch = manager.launch(agentId);
        return acpConnectionFactory(
          launch,
          log,
          (capability) => {
            if (
              agentId !== DEFAULT_AGENT ||
              warnedCapabilities.has(capability)
            ) {
              return;
            }
            warnedCapabilities.add(capability);
            void (async () => {
              const choice = await vscode.window.showWarningMessage(
                "Update MagPi ACP to enable Fork and Tree in Message history.",
                "Update instructions"
              );
              if (choice === "Update instructions") {
                await vscode.env.openExternal(
                  vscode.Uri.parse(
                    "https://github.com/digital-overground/magpi-acp#installation"
                  )
                );
              }
            })();
          },
          (info) => {
            manager.connected(agentId, info?.version);
            void manager.check(agentId);
          },
          agentId
        )(handlers);
      } catch (error) {
        return unavailableAgent(
          error instanceof Error ? error.message : String(error)
        )(handlers);
      }
    },
    manager.availableAgents()[0] ?? DEFAULT_AGENT
  );
  activeThreads = threads;
  const view = new MischiefView(
    projects,
    threads,
    context.extensionUri,
    context.globalState,
    database,
    softwareSetup(manager, context.globalState),
    manager.snapshot(),
    manager
  );
  manager.onChange((statuses) => {
    const available = manager.availableAgents();
    const { selected } = threads.snapshot();
    if (
      selected?.id === null &&
      !available.includes(selected.agentId ?? DEFAULT_AGENT) &&
      available[0] !== undefined
    ) {
      threads.selectDraftAgent(available[0]);
    }
    for (const status of statuses) {
      view.setAgentStatus(status);
    }
  });
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
    vscode.commands.registerCommand(
      "mischief.addSelectionToCurrentThread",
      async () => {
        await view.stageEditorSelection("current");
      }
    ),
    vscode.commands.registerCommand(
      "mischief.addSelectionToNewThread",
      async () => {
        await view.stageEditorSelection("new");
      }
    ),
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
    manager.startAutoUpdates();
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
  agentManager?.dispose();
  agentManager = undefined;
  await database?.dispose();
  database = undefined;
};
