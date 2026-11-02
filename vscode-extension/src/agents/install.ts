import * as vscode from "vscode";

import type { AgentManager } from "./manager";
import { AGENTS } from "./update";
import type { AgentId } from "./update";

export const requestAgentInstall = async (
  manager: AgentManager,
  id: AgentId
): Promise<boolean> => {
  const approved = await vscode.window.showInformationMessage(
    `Install ${AGENTS[id].name} (${AGENTS[id].package}) into Mischief-owned storage? After this first approval, Mischief will automatically update it for new connections. Running Threads keep their current Agent process.`,
    { modal: true },
    "Install"
  );
  if (approved !== "Install") {
    return false;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing ${AGENTS[id].name}`,
    },
    async () => {
      await manager.install(id);
    }
  );
  return true;
};
