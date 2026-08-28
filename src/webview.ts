import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as vscode from "vscode";

export const webviewHtml = async (
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): Promise<string> => {
  const media = vscode.Uri.joinPath(extensionUri, "media");
  const assetUri = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
  const document = await readFile(
    vscode.Uri.joinPath(media, "webview.html").fsPath,
    "utf-8"
  );

  return document
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{nonce}}", randomBytes(16).toString("hex"))
    .replaceAll("{{styleUri}}", assetUri("webview.css"))
    .replaceAll("{{scriptUri}}", assetUri("webview.js"));
};
