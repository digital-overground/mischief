import { expect, test, vi } from "vitest";
import { MischiefView } from "./view";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: () => "" }),
  },
}));

test("webview script remains valid after interpolation", () => {
  const webview = {
    options: {},
    html: "",
    onDidReceiveMessage: vi.fn(),
    postMessage: vi.fn(),
  };
  const view = {
    webview,
    onDidDispose: vi.fn(),
  };
  const threads = {
    onChange: vi.fn(),
    snapshot: () => ({ threads: [] }),
  };
  const provider = new MischiefView({} as never, threads as never);

  provider.resolveWebviewView(view as never);

  const script = webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  expect(() => new Function(script!)).not.toThrow();
});
