import { readFileSync } from "node:fs";
import path from "node:path";
import { Script } from "node:vm";

import { describe, expect, test, vi } from "vitest";

import { MischiefView } from "./view";

vi.mock(
  import("vscode"),
  () =>
    ({
      Uri: {
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
          fsPath: path.join(base.fsPath, ...parts),
        }),
      },
      workspace: {
        getConfiguration: vi.fn<() => { get: () => string }>(() => ({
          get: () => "",
        })),
      },
    }) as never
);

describe("view provider", () => {
  test("static webview assets remain valid", () => {
    const html = readFileSync("media/webview.html", "utf-8");
    const style = readFileSync("media/webview.css", "utf-8");
    const script = readFileSync("media/webview.js", "utf-8");
    const normalizedHtml = html
      .replaceAll(/\s+>/gu, ">")
      .replaceAll(/>\s+</gu, "><");
    const normalizedScript = script.replaceAll('"', "'");
    const document =
      `${style}\n${normalizedHtml}\n${normalizedScript}`.replaceAll(
        /\s+/gu,
        " "
      );

    expect(() => new Script(script)).not.toThrow();
    expect({
      enterToSend: document.includes(
        "event.key === 'Enter' && !event.shiftKey"
      ),
      script: html.includes('src="{{scriptUri}}"'),
      stopButton: document.includes(
        "sendButton.classList.toggle('stop', Boolean(running));"
      ),
      style: html.includes('href="{{styleUri}}"'),
    }).toStrictEqual({
      enterToSend: true,
      script: true,
      stopButton: true,
      style: true,
    });
    expect({
      accordion:
        /main > section\.collapsed[\s\S]*const togglePane[\s\S]*aria-expanded/u.test(
          document
        ),
      chatFlow:
        /id="chat"><div id="transcript"><\/div><div id="processing"[\s\S]*<\/div><div id="plan"/u.test(
          document
        ),
      configAlignment:
        /#configs \{[^}]*margin-left: auto;[^}]*justify-content: flex-end;[\s\S]*#send \{(?![^}]*margin-left: auto;)[^}]*\}/u.test(
          document
        ),
      configIcons:
        /\.config-control \{[^}]*gap: 8px;[^}]*\}[\s\S]*\.config-control select \{ appearance: none; \}[\s\S]*control\.append\(\s*select, configIcon/u.test(
          document
        ),
      contextTooltip:
        /#usage:hover::after, #usage:focus-visible::after[^}]*opacity: 1;[\s\S]*usage\.dataset\.tooltip = usage\.title/u.test(
          document
        ),
      customProfile:
        /isProfileConfig\(config\)[\s\S]*select\.selectedIndex < 0[\s\S]*option\('', 'Custom'\)[\s\S]*custom\.disabled = true/u.test(
          document
        ),
      dropdowns:
        /#configs select \{[^}]*background: transparent;[^}]*color: var\(--vscode-foreground\)/u.test(
          document
        ),
      markdown:
        /\.markdown pre[\s\S]*const markdownBody[\s\S]*body\.innerHTML = item\.html/u.test(
          document
        ),
      modelAlignment: /#configs option \{ text-align: right; \}/u.test(
        document
      ),
      pastedImage:
        /id="attachments"[\s\S]*readAsDataURL[\s\S]*addEventListener\('paste'[\s\S]*type: 'prompt'/u.test(
          document
        ),
      planLayout:
        /#plan-body \{ max-height: 110px; overflow-y: auto;[\s\S]*id="processing"[\s\S]*id="plan"[\s\S]*<\/div><footer>/u.test(
          document
        ),
      planRendering: /renderPlan\(selected\)[\s\S]*item\.kind !== 'plan'/u.test(
        document
      ),
      processing:
        /id="braille"[\s\S]*selected\.status !== 'running' \|\| selected\.streaming/u.test(
          document
        ),
      progressWidth: /#usage \{[^}]*max-width: 200px;/u.test(document),
      resizable:
        /class="resizer" data-before="projects" data-after="threads"[\s\S]*class="resizer" data-before="threads" data-after="thread"[\s\S]*const resizePanes/u.test(
          document
        ),
      thinking:
        /const transcriptNodes[\s\S]*kind === 'thought'[\s\S]*const thinkingGroup[\s\S]*'entry thought thinking-group'/u.test(
          document
        ),
      transcriptImages:
        /\.transcript-images img[\s\S]*const imageGallery[\s\S]*item\.images/u.test(
          document
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
      pastedImage: true,
      planLayout: true,
      planRendering: true,
      processing: true,
      progressWidth: true,
      resizable: true,
      thinking: true,
      transcriptImages: true,
    });
    expect(document).not.toMatch(
      /id="stop"|class="morse"|Enter to send|>Send<|>Stop</u
    );
  });

  test("loads static assets and bubbles Thread attention to the native view badge", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    const webview = {
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      }),
      cspSource: "webview-csp",
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
    const provider = new MischiefView(
      {} as never,
      threads as never,
      {
        fsPath: process.cwd(),
      } as never
    );

    await provider.resolveWebviewView(view as never);

    expect((view as { badge?: unknown }).badge).toStrictEqual({
      tooltip: "2 Threads need attention",
      value: 2,
    });
    expect(webview.html).toContain('id="threads-attention"');
    expect({
      csp: webview.html.includes("webview-csp"),
      placeholders: webview.html.includes("{{"),
      uris: webview.html.includes("webview:/"),
    }).toStrictEqual({ csp: true, placeholders: false, uris: true });
  });

  test("renders Markdown without allowing raw HTML", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    const webview = {
      asWebviewUri: (uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      }),
      cspSource: "webview-csp",
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
    const provider = new MischiefView(
      {} as never,
      threads as never,
      {
        fsPath: process.cwd(),
      } as never
    );

    await provider.resolveWebviewView(view as never);

    const state = postMessage.mock.calls.at(-1)?.[0] as {
      threads: { selected: { items: { html: string }[] } };
    };
    expect(state.threads.selected.items[0]?.html).toBe(
      "<p><strong>Bold</strong> &lt;script&gt;alert(1)&lt;/script&gt;</p>\n"
    );
  });
});
