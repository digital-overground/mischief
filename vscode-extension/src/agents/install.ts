import * as vscode from "vscode";

import type { AgentService } from "./manager";
import { AGENTS } from "./update";
import type { AgentId } from "./update";

export const requestAgentInstall = async (
  manager: AgentService,
  id: AgentId
): Promise<boolean> => {
  const approved = await vscode.window.showInformationMessage(
    `Install ${AGENTS[id].name} (${AGENTS[id].package}) into Mischief-owned storage? Agent updates remain manual while active-turn-safe staging is being completed.`,
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
