import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { MischiefView } from "./view";

const vscode = vi.hoisted(() => ({
  assignWorkspaceColors: true,
  createQuickPick: vi.fn<() => unknown>(),
  executeCommand: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  openExternal: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  showErrorMessage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  showInformationMessage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  updateConfiguration: vi.fn<
    (key: string, value: unknown, target: number) => Promise<void>
  >(() => Promise.resolve()),
}));

vi.mock(
  import("vscode"),
  () =>
    ({
      ConfigurationTarget: { Global: 1, Workspace: 2 },
      ThemeIcon: class ThemeIcon {
        readonly id: string;

        constructor(id: string) {
          this.id = id;
        }
      },
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
        joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
          fsPath: path.join(base.fsPath, ...parts),
        }),
        parse: (value: string) => ({ value }),
      },
      commands: { executeCommand: vscode.executeCommand },
      env: { openExternal: vscode.openExternal },
      extensions: { all: [] },
      window: {
        createQuickPick: vscode.createQuickPick,
        showErrorMessage: vscode.showErrorMessage,
        showInformationMessage: vscode.showInformationMessage,
      },
      workspace: {
        getConfiguration: () => ({
          get: (key: string) =>
            key === "assignWorkspaceColors" ? vscode.assignWorkspaceColors : "",
          inspect: () => ({}),
          update: vscode.updateConfiguration,
        }),
      },
    }) as never
);

describe("view provider", () => {
  test("focuses Mischief and starts a Thread in a newly created Workspace", async () => {
    vscode.executeCommand.mockClear();
    const folder = "/workspace";
    let active: string | undefined;
    let pending = [folder];
    const projects = {
      open: vi.fn<() => Promise<unknown>>(() =>
        Promise.resolve({
          projects: [],
          ungrouped: [
            {
              ahead: 0,
              behind: 0,
              changes: 0,
              current: true,
              linked: false,
              name: "workspace",
              path: folder,
            },
          ],
        })
      ),
    };
    const threads = {
      newThread: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      onChange: vi.fn<() => void>(),
      openWorkspace: vi.fn<(workspace: string) => Promise<void>>(
        (workspace) => {
          active = workspace;
          return Promise.resolve();
        }
      ),
      snapshot: () => ({
        attentionCount: 0,
        threads: [],
        ...(active ? { workspace: active } : {}),
      }),
    };
    const storage = {
      get: () => pending,
      update: vi.fn<(_key: string, value: unknown) => Promise<void>>(
        (_key, value) => {
          pending = value as string[];
          return Promise.resolve();
        }
      ),
    };
    const provider = new MischiefView(
      projects as never,
      threads as never,
      { fsPath: process.cwd() } as never,
      storage as never
    );

    await provider.initialize(folder);

    expect({
      command: vscode.executeCommand.mock.calls,
      newThreads: threads.newThread.mock.calls.length,
      pending,
    }).toStrictEqual({
      command: [["workbench.view.extension.mischief"]],
      newThreads: 1,
      pending: [],
    });
  });

  test("lists Project issues and opens one externally without closing the picker", async () => {
    let receive: ((message: unknown) => void) | undefined;
    let accept: (() => void) | undefined;
    let hidden: (() => void) | undefined;
    let triggerButton:
      | ((event: { item: { issue: unknown } }) => Promise<void>)
      | undefined;
    const picker = {
      activeItems: [],
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(() => hidden?.()),
      items: [] as { buttons?: unknown[]; issue: unknown; label: string }[],
      onDidAccept: vi.fn<(listener: () => void) => { dispose: () => void }>(
        (listener) => {
          accept = listener;
          return { dispose: vi.fn<() => void>() };
        }
      ),
      onDidHide: vi.fn<(listener: () => void) => { dispose: () => void }>(
        (listener) => {
          hidden = listener;
          return { dispose: vi.fn<() => void>() };
        }
      ),
      onDidTriggerItemButton: vi.fn<
        (listener: (event: { item: { issue: unknown } }) => Promise<void>) => {
          dispose: () => void;
        }
      >((listener) => {
        triggerButton = listener;
        return { dispose: vi.fn<() => void>() };
      }),
      selectedItems: [] as { issue: unknown }[],
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReturnValue(picker);
    vscode.openExternal.mockClear();
    const createWorkspace = vi.fn<() => Promise<string>>(() =>
      Promise.resolve("/worktree")
    );
    const sourceBranches = vi.fn<() => Promise<unknown[]>>(() =>
      Promise.resolve([])
    );
    const projects = {
      createWorkspace,
      listOpenIssues: vi.fn<() => Promise<unknown[]>>(() =>
        Promise.resolve([
          { number: 6, title: "First issue", url: "https://example.test/6" },
          { number: 9, title: "Second issue", url: "https://example.test/9" },
        ])
      ),
      open: vi.fn<() => Promise<unknown>>(() =>
        Promise.resolve({
          projects: [{ name: "project", root: "/project", workspaces: [] }],
          ungrouped: [],
        })
      ),
      sourceBranches,
    };
    const provider = new MischiefView(
      projects as never,
      {
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ attentionCount: 0, threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      { get: (_key: string, fallback: unknown) => fallback } as never
    );
    await provider.initialize("/project");
    await provider.resolveWebviewView({
      onDidDispose: vi.fn<() => void>(),
      webview: {
        asWebviewUri: (uri: { fsPath: string }) => ({
          toString: () => `webview:${uri.fsPath}`,
        }),
        cspSource: "webview-csp",
        html: "",
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receive = listener;
        },
        options: {},
        postMessage: vi.fn<() => void>(),
      },
    } as never);

    receive?.({ path: "/project", type: "openIssues" });
    await vi.waitFor(() => expect(picker.show).toHaveBeenCalledOnce());

    expect({
      items: picker.items.map((item) => {
        const button = item.buttons?.[0] as
          | { iconPath: { id: string }; tooltip: string }
          | undefined;
        return {
          button: button && {
            icon: button.iconPath.id,
            tooltip: button.tooltip,
          },
          label: item.label,
        };
      }),
      title: picker.title,
    }).toStrictEqual({
      items: [
        {
          button: { icon: "link-external", tooltip: "Open #6 on GitHub" },
          label: "#6 First issue",
        },
        {
          button: { icon: "link-external", tooltip: "Open #9 on GitHub" },
          label: "#9 Second issue",
        },
      ],
      title: "Open Issues · project",
    });

    await triggerButton?.({ item: picker.items[1] as { issue: unknown } });

    expect({
      hidden: picker.hide.mock.calls.length,
      opened: vscode.openExternal.mock.calls,
    }).toStrictEqual({
      hidden: 0,
      opened: [[{ value: "https://example.test/9" }]],
    });

    picker.selectedItems = [picker.items[1] as { issue: unknown }];
    accept?.();
    await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalledOnce());

    expect({
      hidden: picker.hide.mock.calls.length,
      sourceRequests: sourceBranches.mock.calls.length,
      workspaceCreations: createWorkspace.mock.calls.length,
    }).toStrictEqual({ hidden: 1, sourceRequests: 0, workspaceCreations: 0 });
  });

  test("cancels the issue picker without mutation and reports no open issues", async () => {
    let receive: ((message: unknown) => void) | undefined;
    let hide: (() => void) | undefined;
    const picker = {
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      items: [],
      onDidAccept: vi.fn<(_listener: () => void) => { dispose: () => void }>(
        () => ({ dispose: vi.fn<() => void>() })
      ),
      onDidHide: vi.fn<(listener: () => void) => { dispose: () => void }>(
        (listener) => {
          hide = listener;
          return { dispose: vi.fn<() => void>() };
        }
      ),
      onDidTriggerItemButton: vi.fn<
        (_listener: (event: unknown) => Promise<void>) => {
          dispose: () => void;
        }
      >(() => ({ dispose: vi.fn<() => void>() })),
      selectedItems: [],
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReturnValue(picker);
    vscode.showInformationMessage.mockClear();
    const sourceBranches = vi.fn<() => Promise<unknown[]>>(() =>
      Promise.resolve([])
    );
    const createWorkspace = vi.fn<() => Promise<string>>(() =>
      Promise.resolve("/worktree")
    );
    const listOpenIssues = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([
        { number: 6, title: "First issue", url: "https://example.test/6" },
      ])
      .mockResolvedValueOnce([]);
    const provider = new MischiefView(
      {
        createWorkspace,
        listOpenIssues,
        open: () =>
          Promise.resolve({
            projects: [{ name: "project", root: "/project", workspaces: [] }],
            ungrouped: [],
          }),
        sourceBranches,
      } as never,
      {
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ attentionCount: 0, threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      { get: (_key: string, fallback: unknown) => fallback } as never
    );
    await provider.initialize("/project");
    await provider.resolveWebviewView({
      onDidDispose: vi.fn<() => void>(),
      webview: {
        asWebviewUri: (uri: { fsPath: string }) => ({
          toString: () => `webview:${uri.fsPath}`,
        }),
        cspSource: "webview-csp",
        html: "",
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receive = listener;
        },
        options: {},
        postMessage: vi.fn<() => void>(),
      },
    } as never);

    receive?.({ path: "/project", type: "openIssues" });
    await vi.waitFor(() => expect(picker.show).toHaveBeenCalledOnce());
    hide?.();
    await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalledOnce());
    receive?.({ path: "/project", type: "openIssues" });
    await vi.waitFor(() =>
      expect(vscode.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
        "No open GitHub issues for project."
      )
    );

    expect(sourceBranches).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test("static webview shell loads the React bundle", () => {
    const html = readFileSync("media/webview.html", "utf-8");
    const style = readFileSync("media/webview.css", "utf-8");

    expect(html).toContain('id="root"');
    expect(html).toContain('src="{{scriptUri}}"');
    expect(html).toContain('href="{{styleUri}}"');
    expect(style).toMatch(
      /#steering,\s*#plan \{[^}]*flex: 0 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto;/u
    );
    expect(style).toMatch(
      /footer \{[^}]*flex: none;[\s\S]*#processing::before \{[^}]*animation: thread-status-frame/u
    );
  });

  test("conversation content wraps instead of creating horizontal overflow", () => {
    const style = readFileSync("media/webview.css", "utf-8");

    expect(style).toMatch(
      /#thread \{[^}]*min-width: 0;[^}]*overflow: hidden;/u
    );
    expect(style).toMatch(
      /#chat \* \{[^}]*min-width: 0;[^}]*max-width: 100%;/u
    );
    expect(style).toMatch(
      /\.markdown pre \{[^}]*overflow-x: hidden;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/u
    );
    expect(style).toMatch(/\.markdown table \{[^}]*table-layout: fixed;/u);
    expect(style).toMatch(
      /\.tool-body pre \{[^}]*overflow-y: auto;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/u
    );
  });

  test("sends only the changed transcript item while streaming", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    let emit: ((change: unknown) => void) | undefined;
    const threads = {
      onChange: (listener: (change: unknown) => void) => {
        emit = listener;
      },
      snapshot: () => ({
        attentionCount: 0,
        selected: {
          configOptions: [],
          drafts: [],
          id: "thread-1",
          items: [{ id: "old", kind: "assistant", text: "Old history" }],
          name: "Thread",
          status: "running",
          steering: [],
          streaming: true,
        },
        threads: [],
      }),
    };
    const provider = new MischiefView(
      {} as never,
      threads as never,
      { fsPath: process.cwd() } as never,
      {} as never
    );
    await provider.resolveWebviewView({
      onDidDispose: vi.fn<() => void>(),
      webview: {
        asWebviewUri: (uri: { fsPath: string }) => ({
          toString: () => `webview:${uri.fsPath}`,
        }),
        cspSource: "webview-csp",
        html: "",
        onDidReceiveMessage: vi.fn<() => void>(),
        options: {},
        postMessage,
      },
    } as never);
    postMessage.mockClear();

    emit?.({
      item: { id: "current", kind: "assistant", text: "**New**" },
      streaming: true,
      threadId: "thread-1",
      type: "transcript",
    });

    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      item: {
        html: "<p><strong>New</strong></p>\n",
        id: "current",
        kind: "assistant",
        text: "**New**",
      },
      streaming: true,
      threadId: "thread-1",
      type: "transcript",
    });
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
    let attentionCount = 2;
    let emit: (() => void) | undefined;
    const threads = {
      onChange: (listener: () => void) => {
        emit = listener;
      },
      snapshot: () => ({
        attentionCount,
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
      } as never,
      {} as never
    );

    await provider.resolveWebviewView(view as never);

    expect((view as { badge?: unknown }).badge).toStrictEqual({
      tooltip: "2 Threads need attention",
      value: 2,
    });

    attentionCount = 0;
    emit?.();

    expect((view as { badge?: unknown }).badge).toStrictEqual({
      tooltip: "",
      value: 0,
    });
    expect(webview.html).toContain('id="root"');
    expect({
      csp: webview.html.includes("webview-csp"),
      placeholders: webview.html.includes("{{"),
      uris: webview.html.includes("webview:/"),
    }).toStrictEqual({ csp: true, placeholders: false, uris: true });
  });

  test("persists Workspace color assignment from Settings", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    let receive: ((message: unknown) => void) | undefined;
    vscode.assignWorkspaceColors = true;
    vscode.updateConfiguration.mockImplementation((_key, value) => {
      vscode.assignWorkspaceColors = value as boolean;
      return Promise.resolve();
    });
    const provider = new MischiefView(
      {} as never,
      {
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ attentionCount: 0, threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      {} as never
    );
    await provider.resolveWebviewView({
      onDidDispose: vi.fn<() => void>(),
      webview: {
        asWebviewUri: (uri: { fsPath: string }) => ({
          toString: () => `webview:${uri.fsPath}`,
        }),
        cspSource: "webview-csp",
        html: "",
        onDidReceiveMessage: (listener: (message: unknown) => void) => {
          receive = listener;
        },
        options: {},
        postMessage,
      },
    } as never);
    postMessage.mockClear();

    provider.showSettings();
    receive?.({ type: "setAssignWorkspaceColors", value: false });
    await vi.waitFor(() =>
      expect(vscode.updateConfiguration).toHaveBeenCalledWith(
        "assignWorkspaceColors",
        false,
        1
      )
    );
    provider.showSettings();

    expect(postMessage.mock.calls).toStrictEqual([
      [{ assignWorkspaceColors: true, type: "showSettings" }],
      [{ assignWorkspaceColors: false, type: "showSettings" }],
    ]);
    vscode.updateConfiguration.mockReset();
    vscode.assignWorkspaceColors = true;
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
      } as never,
      {} as never
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
