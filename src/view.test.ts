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
    expect({
      accordion:
        /main > section\.collapsed[\s\S]*function togglePane[\s\S]*aria-expanded/u.test(
          webview.html
        ),
      chatFlow:
        /id="chat"><div id="transcript"><\/div><div id="processing"[\s\S]*<\/div><div id="plan"/u.test(
          webview.html
        ),
      markdown:
        /\.markdown pre[\s\S]*function markdownBody[\s\S]*body\.innerHTML = item\.html/u.test(
          webview.html
        ),
      planLayout:
        /#plan-body \{ max-height: 110px; overflow-y: auto;[\s\S]*id="processing"[\s\S]*id="plan"[\s\S]*<\/div><footer>/u.test(
          webview.html
        ),
      planRendering: /renderPlan\(selected\)[\s\S]*item\.kind !== 'plan'/u.test(
        webview.html
      ),
      processing:
        /id="braille"[\s\S]*selected\.status !== 'running' \|\| selected\.streaming/u.test(
          webview.html
        ),
      resizable:
        /class="resizer" data-before="projects" data-after="threads"[\s\S]*class="resizer" data-before="threads" data-after="thread"[\s\S]*function resizePanes/u.test(
          webview.html
        ),
      thinking:
        /function transcriptNodes[\s\S]*kind === 'thought'[\s\S]*function thinkingGroup[\s\S]*'entry thought thinking-group'/u.test(
          webview.html
        ),
    }).toStrictEqual({
      accordion: true,
      chatFlow: true,
      markdown: true,
      planLayout: true,
      planRendering: true,
      processing: true,
      resizable: true,
      thinking: true,
    });
    expect(webview.html).not.toMatch(
      /id="stop"|class="morse"|Enter to send|>Send<|>Stop</u
    );
  });

  test("renders Markdown without allowing raw HTML", () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    const webview = {
      html: "",
      onDidReceiveMessage: vi.fn<() => void>(),
      options: {},
      postMessage,
    };
    const view = {
      onDidDispose: vi.fn<() => void>(),
      webview,
    };
    const threads = {
      onChange: vi.fn<() => void>(),
      snapshot: () => ({
        selected: {
          items: [
            {
              id: "assistant-1",
              kind: "assistant",
              text: "**Bold** <script>alert(1)</script>",
            },
          ],
        },
        threads: [],
      }),
    };
    const provider = new MischiefView({} as never, threads as never);

    provider.resolveWebviewView(view as never);

    const state = postMessage.mock.calls.at(-1)?.[0] as {
      threads: { selected: { items: { html: string }[] } };
    };
    expect(state.threads.selected.items[0]?.html).toBe(
      "<p><strong>Bold</strong> &lt;script&gt;alert(1)&lt;/script&gt;</p>\n"
    );
  });
});
