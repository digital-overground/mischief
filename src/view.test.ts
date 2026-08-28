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
      configAlignment:
        /#configs \{[^}]*margin-left: auto;[^}]*justify-content: flex-end;[\s\S]*#send \{(?![^}]*margin-left: auto;)[^}]*\}/u.test(
          webview.html
        ),
      configIcons:
        /\.config-control \{[^}]*gap: 8px;[^}]*\}[\s\S]*\.config-control select \{ appearance: none; \}[\s\S]*control\.append\(select, configIcon/u.test(
          webview.html
        ),
      contextTooltip:
        /#usage:hover::after, #usage:focus-visible::after[^}]*opacity: 1;[\s\S]*usage\.dataset\.tooltip = usage\.title/u.test(
          webview.html
        ),
      customProfile:
        /isProfileConfig\(config\)[\s\S]*select\.selectedIndex < 0[\s\S]*option\('', 'Custom'\)[\s\S]*custom\.disabled = true/u.test(
          webview.html
        ),
      dropdowns:
        /#configs select \{[^}]*background: transparent;[^}]*color: var\(--vscode-foreground\)/u.test(
          webview.html
        ),
      markdown:
        /\.markdown pre[\s\S]*function markdownBody[\s\S]*body\.innerHTML = item\.html/u.test(
          webview.html
        ),
      modelAlignment: /#configs option \{ text-align: right; \}/u.test(
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
      progressWidth: /#usage \{[^}]*max-width: 200px;/u.test(webview.html),
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
      configAlignment: true,
      configIcons: true,
      contextTooltip: true,
      customProfile: true,
      dropdowns: true,
      markdown: true,
      modelAlignment: true,
      planLayout: true,
      planRendering: true,
      processing: true,
      progressWidth: true,
      resizable: true,
      thinking: true,
    });
    expect(webview.html).not.toMatch(
      /id="stop"|class="morse"|Enter to send|>Send<|>Stop</u
    );
  });

  test("bubbles Thread attention to the native view badge", () => {
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
        attentionCount: 2,
        threads: [
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "waiting",
            indicator: "waiting",
            name: "Needs input",
            needsAttention: true,
            status: "waiting",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: "completed",
            indicator: "completed",
            name: "Finished",
            needsAttention: true,
            status: "idle",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    };
    const provider = new MischiefView({} as never, threads as never);

    provider.resolveWebviewView(view as never);

    expect((view as { badge?: unknown }).badge).toStrictEqual({
      tooltip: "2 Threads need attention",
      value: 2,
    });
    expect(webview.html).toContain('id="threads-attention"');
    expect(webview.html).toContain("statusIndicator(indicatorKind(thread))");
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
