import type { WebviewToHostMessage } from "./protocol";

interface VsCodeApi {
  postMessage: (message: WebviewToHostMessage) => void;
}

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const send = vscode.postMessage.bind(vscode);

export const postMessage = (message: WebviewToHostMessage): void => {
  send(message);
};
