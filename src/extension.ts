import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Mischief");
  context.subscriptions.push(output);
  output.appendLine("Mischief activated");
}

export function deactivate() {}
