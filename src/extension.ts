import * as vscode from "vscode";
import { Projects } from "./projects/projects";
import { MischiefView, registerMischiefView } from "./view";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Mischief");
  const view = new MischiefView(new Projects(context.globalState));
  context.subscriptions.push(output);
  registerMischiefView(context, view);

  context.subscriptions.push(
    vscode.commands.registerCommand("mischief.addWorkspace", () => view.addWorkspace()),
    vscode.commands.registerCommand("mischief.refresh", () => view.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mischief.fontFamily")) void view.refresh();
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

export function deactivate() {}
