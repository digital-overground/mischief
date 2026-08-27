import { Script } from "node:vm";

import { describe, expect, test, vi } from "vitest";

import { MischiefView } from "./view";

vi.mock(
  import("vscode"),
  () =>
    ({
      workspace: {
        getConfiguration: vi.fn<() => { get: () => string }>(() => ({
          get: () => "",
        })),
      },
    }) as never
);

describe("view provider", () => {
  test("webview script remains valid after interpolation", () => {
    const webview = {
      html: "",
      onDidReceiveMessage: vi.fn<() => void>(),
      options: {},
      postMessage: vi.fn<() => void>(),
    };
    const view = {
      onDidDispose: vi.fn<() => void>(),
      webview,
    };
    const threads = {
      onChange: vi.fn<() => void>(),
      snapshot: () => ({ threads: [] }),
    };
    const provider = new MischiefView({} as never, threads as never);

    provider.resolveWebviewView(view as never);

    const script = webview.html.match(
      /<script nonce="(?<nonce>[^"]+)">(?<script>[\s\S]*?)<\/script>/u
    )?.groups?.script;
    if (!script) {
      throw new Error("Webview script was not generated");
    }
    expect(() => new Script(script)).not.toThrow();
    expect(webview.html).toContain("event.key === 'Enter' && !event.shiftKey");
    expect(webview.html).toContain(
      "sendButton.classList.toggle('stop', Boolean(running));"
    );
    expect(webview.html).toMatch(
      /id="processing"[\s\S]*id="braille"[\s\S]*<\/div><footer>[\s\S]*selected\.status !== 'running' \|\| selected\.streaming/u
    );
    expect(webview.html).not.toMatch(
      /id="stop"|class="morse"|Enter to send|>Send<|>Stop</u
    );
  });
});
