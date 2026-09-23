import { readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { describe, expect, test, vi } from "vitest";

import { isDefined, isNonEmpty } from "./present";
import { testValue } from "./test-value";
import { MischiefView } from "./view";

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolver: (() => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolve: () => resolver?.() };
};

const vscode = vi.hoisted(() => ({
  assignWorkspaceColors: true,
  createQuickPick: vi.fn<() => unknown>(),
  executeCommand: vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  }),
  openExternal: vi.fn<() => Promise<boolean>>(async () => {
    await Promise.resolve();
    return true;
  }),
  showErrorMessage: vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  }),
  showInformationMessage: vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  }),
  showInputBox: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  showQuickPick: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  showTextDocument: vi.fn<() => Promise<void>>(async () => {
    await Promise.resolve();
  }),
  updateConfiguration: vi.fn<
    (key: string, value: unknown, target: number) => Promise<void>
  >(async () => {
    await Promise.resolve();
  }),
}));

vi.mock(import("vscode"), () =>
  testValue<never>({
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    QuickPickItemKind: { Separator: -1 },
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
      showInputBox: vscode.showInputBox,
      showQuickPick: vscode.showQuickPick,
      showTextDocument: vscode.showTextDocument,
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) =>
          key === "assignWorkspaceColors" ? vscode.assignWorkspaceColors : "",
        inspect: () => ({}),
        update: vscode.updateConfiguration,
      }),
    },
  })
);

const profileDatabase = () => ({
  onChange: vi.fn<() => void>(),
  snapshot: () => ({ workspaces: [] }),
});

describe("view provider", () => {
  test("focuses Mischief and starts a Thread in a newly created Workspace", async () => {
    vscode.executeCommand.mockClear();
    const folder = process.cwd();
    let active: string | undefined;
    let pending = [{ path: folder }];
    const projects = {
      open: vi.fn<() => Promise<unknown>>(async () => {
        await Promise.resolve();
        return {
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
        };
      }),
    };
    const threads = {
      newThread: vi.fn<() => Promise<void>>(async () => {
        await Promise.resolve();
      }),
      onChange: vi.fn<() => void>(),
      openWorkspace: vi.fn<(workspace: string) => Promise<void>>(
        async (workspace) => {
          await Promise.resolve();
          active = workspace;
        }
      ),
      prompt: vi.fn<() => Promise<void>>(async () => {
        await Promise.resolve();
      }),
      snapshot: () => ({
        threads: [],
        ...(isNonEmpty(active) ? { workspace: active } : {}),
      }),
    };
    const storage = {
      get: () => pending,
      update: vi.fn<(_key: string, value: unknown) => Promise<void>>(
        async (_key, value) => {
          await Promise.resolve();
          pending = testValue<typeof pending>(value);
        }
      ),
    };
    const provider = new MischiefView(
      testValue<never>(projects),
      testValue<never>(threads),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>(storage),
      testValue<never>(profileDatabase())
    );

    await provider.initialize(folder);

    expect({
      command: vscode.executeCommand.mock.calls,
      newThreads: threads.newThread.mock.calls.length,
      pending,
      prompts: threads.prompt.mock.calls.length,
    }).toStrictEqual({
      command: [["workbench.view.extension.mischief"]],
      newThreads: 1,
      pending: [],
      prompts: 0,
    });
  });

  test("consumes a seeded Workspace start before focusing and prompting one Thread", async () => {
    const folder = process.cwd();
    const prompt =
      "start planning work on GitHub issue #123. Read it with gh issue view https://example.test/123 --comments.  return to the user once you've read the issue and give them a summary of the item";
    const events: string[] = [];
    const promptFinished = deferred();
    const promptStarted = deferred();
    let pending = [{ path: folder, prompt }];
    vscode.executeCommand.mockImplementation(async () => {
      await Promise.resolve();
      events.push("focus");
    });
    const threads = {
      newThread: vi.fn<() => Promise<void>>(async () => {
        await Promise.resolve();
        events.push("newThread");
      }),
      onChange: vi.fn<() => void>(),
      openWorkspace: vi.fn<() => Promise<void>>(async () => {
        await Promise.resolve();
      }),
      prompt: vi.fn<(text: string) => Promise<void>>(async (text) => {
        events.push(`prompt:${text}`);
        promptStarted.resolve();
        await promptFinished.promise;
      }),
      snapshot: () => ({ threads: [] }),
    };
    const provider = new MischiefView(
      testValue<never>({
        open: async () => {
          await Promise.resolve();
          return {
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
          };
        },
      }),
      testValue<never>(threads),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({
        get: () => pending,
        update: vi.fn<(_key: string, value: unknown) => Promise<void>>(
          async (_key, value) => {
            await Promise.resolve();
            pending = testValue<typeof pending>(value);
            events.push("remove");
          }
        ),
      }),
      testValue<never>(profileDatabase())
    );

    const initialization = provider.initialize(folder);
    await promptStarted.promise;
    const initialized = await Promise.race([
      initialization.then(() => true),
      setImmediate(false),
    ]);
    promptFinished.resolve();
    await initialization;

    expect({
      events,
      initialized,
      pending,
      prompts: threads.prompt.mock.calls,
    }).toStrictEqual({
      events: ["remove", "focus", "newThread", `prompt:${prompt}`],
      initialized: true,
      pending: [],
      prompts: [[prompt]],
    });

    await provider.initialize(folder);

    expect({ events, prompts: threads.prompt.mock.calls }).toStrictEqual({
      events: ["remove", "focus", "newThread", `prompt:${prompt}`],
      prompts: [[prompt]],
    });
    vscode.executeCommand.mockReset();
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
      items: testValue<
        { buttons?: unknown[]; issue: unknown; label: string }[]
      >([]),
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
      selectedItems: testValue<{ issue: unknown }[]>([]),
      show: vi.fn<() => void>(),
      title: "",
    };
    let sourceAccept: (() => void) | undefined;
    let sourceHidden: (() => void) | undefined;
    const sourcePicker = {
      activeItems: testValue<{ branch?: { current: boolean; name: string } }[]>(
        []
      ),
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(() => sourceHidden?.()),
      items: testValue<
        {
          branch?: { current: boolean; name: string };
          description?: string;
          kind?: number;
          label: string;
        }[]
      >([]),
      onDidAccept: vi.fn<(listener: () => void) => { dispose: () => void }>(
        (listener) => {
          sourceAccept = listener;
          return { dispose: vi.fn<() => void>() };
        }
      ),
      onDidHide: vi.fn<(listener: () => void) => { dispose: () => void }>(
        (listener) => {
          sourceHidden = listener;
          return { dispose: vi.fn<() => void>() };
        }
      ),
      selectedItems: testValue<
        { branch?: { current: boolean; name: string } }[]
      >([]),
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.assignWorkspaceColors = false;
    vscode.createQuickPick
      .mockReset()
      .mockReturnValueOnce(picker)
      .mockReturnValueOnce(sourcePicker);
    vscode.executeCommand.mockClear();
    vscode.openExternal.mockClear();
    vscode.showErrorMessage.mockClear();
    vscode.showInputBox
      .mockReset()
      .mockResolvedValueOnce("atomicobject/gilligan-golf")
      .mockResolvedValueOnce("Edited Name");
    const createWorkspace = vi.fn<() => Promise<string>>(async () => {
      await Promise.resolve();
      return "/worktree";
    });
    const sourceBranches = vi.fn<() => Promise<unknown[]>>(async () => {
      await Promise.resolve();
      return [
        {
          ahead: 2,
          behind: 1,
          current: true,
          name: "main",
          remoteOnly: false,
        },
        { current: false, name: "alpha", remoteOnly: false },
        { current: false, name: "origin/release", remoteOnly: true },
      ];
    });
    const snapshot = {
      projects: [
        {
          name: "project",
          root: "/project",
          workspaces: [
            {
              ahead: 0,
              behind: 0,
              changes: 0,
              current: false,
              linked: true,
              name: "worktree",
              path: "/worktree",
            },
          ],
        },
      ],
      ungrouped: [],
    };
    const listOpenIssues = vi.fn<
      (
        root: string,
        chooseRepository: (
          defaultRepository: string
        ) => Promise<string | undefined>
      ) => Promise<unknown[] | undefined>
    >(async (_root, chooseRepository) => {
      const repository = await chooseRepository(
        "Golf-With-GIlligan/gilligan-mono"
      );
      return isNonEmpty(repository)
        ? [
            {
              number: 6,
              title: "First issue",
              url: "https://example.test/6",
            },
            {
              number: 9,
              title: "Second issue",
              url: "https://example.test/9",
            },
          ]
        : undefined;
    });
    const projects = {
      createWorkspace,
      listOpenIssues,
      open: vi.fn<() => Promise<unknown>>(async () => {
        await Promise.resolve();
        return {
          projects: [{ name: "project", root: "/project", workspaces: [] }],
          ungrouped: [],
        };
      }),
      refresh: vi.fn<() => Promise<unknown>>(async () => {
        await Promise.resolve();
        return snapshot;
      }),
      sourceBranches,
    };
    const storage = {
      get: (_key: string, fallback: unknown) => fallback,
      update: vi.fn<() => Promise<void>>(async () => {
        await Promise.resolve();
      }),
    };
    const provider = new MischiefView(
      testValue<never>(projects),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>(storage),
      testValue<never>(profileDatabase())
    );
    await provider.initialize("/project");
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );

    receive?.({ path: "/project", type: "openIssues" });
    await vi.waitFor(() => {
      expect({
        items: picker.items.map((item) => {
          const button = testValue<
            { iconPath: { id: string }; tooltip: string } | undefined
          >(item.buttons?.[0]);
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
    });

    await triggerButton?.({ item: picker.items[1] });
    vscode.openExternal.mockRejectedValueOnce(new Error("blocked"));
    await triggerButton?.({ item: picker.items[0] });

    expect({
      errors: vscode.showErrorMessage.mock.calls,
      hidden: picker.hide.mock.calls.length,
      opened: vscode.openExternal.mock.calls,
      sourceRequests: sourceBranches.mock.calls.length,
    }).toStrictEqual({
      errors: [["Mischief: Could not open #6: blocked"]],
      hidden: 0,
      opened: [
        [{ value: "https://example.test/9" }],
        [{ value: "https://example.test/6" }],
      ],
      sourceRequests: 0,
    });

    picker.selectedItems = [picker.items[1]];
    accept?.();
    await vi.waitFor(() => {
      expect(sourcePicker.show).toHaveBeenCalledOnce();
    });
    sourcePicker.selectedItems = [
      testValue<{ branch: { current: boolean; name: string } }>(
        sourcePicker.items.find(
          (item) => item.branch?.name === "origin/release"
        )
      ),
    ];
    sourceAccept?.();
    await vi.waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledOnce();
    });
    const [repositoryOptions] = testValue<
      [{ prompt: string; title: string; value: string }]
    >(vscode.showInputBox.mock.calls[0]);
    const [nameOptions] = testValue<
      [{ prompt: string; title: string; value: string }]
    >(vscode.showInputBox.mock.calls[1]);

    expect({
      created: createWorkspace.mock.calls,
      hidden: picker.hide.mock.calls.length,
      name: {
        prompt: nameOptions.prompt,
        title: nameOptions.title,
        value: nameOptions.value,
      },
      opened: vscode.executeCommand.mock.calls,
      pending: storage.update.mock.calls,
      repository: {
        prompt: repositoryOptions.prompt,
        title: repositoryOptions.title,
        value: repositoryOptions.value,
      },
      repositoryRequests: listOpenIssues.mock.calls.map(([root]) => root),
      sourceActive: sourcePicker.activeItems.map((item) => item.branch?.name),
      sourceItems: sourcePicker.items.map(({ description, kind, label }) => ({
        ...(isNonEmpty(description) ? { description } : {}),
        ...(kind === undefined ? {} : { kind }),
        label,
      })),
      sourceRequests: sourceBranches.mock.calls,
      sourceTitle: sourcePicker.title,
    }).toStrictEqual({
      created: [["/project", "Edited Name", "origin/release"]],
      hidden: 1,
      name: {
        prompt: "Create a linked worktree and branch from origin/release",
        title: "New Workspace for #9",
        value: "issue-9_second-issue",
      },
      opened: [
        [
          "vscode.openFolder",
          { fsPath: "/worktree" },
          { forceNewWindow: true },
        ],
      ],
      pending: [
        [
          "mischief.startWorkspaces",
          [
            {
              path: "/worktree",
              prompt:
                "start planning work on GitHub issue #9. Read it with gh issue view https://example.test/9 --comments.  return to the user once you've read the issue and give them a summary of the item",
            },
          ],
        ],
      ],
      repository: {
        prompt: "Enter the GitHub issue repository as owner/repo",
        title: "Issue Repository for project",
        value: "Golf-With-GIlligan/gilligan-mono",
      },
      repositoryRequests: ["/project"],
      sourceActive: ["main"],
      sourceItems: [
        { kind: -1, label: "Local" },
        { description: "↑2 ↓1", label: "main" },
        { description: "local only", label: "alpha" },
        { kind: -1, label: "Remote only" },
        { label: "origin/release" },
      ],
      sourceRequests: [["/project"]],
      sourceTitle: "Source Branch for #9",
    });
    vscode.assignWorkspaceColors = true;
  });

  test("shows inactive Thread history with compact times and reopens the selection", async () => {
    let receive: ((message: unknown) => void) | undefined;
    const now = new Date("2026-09-16T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const entries = [
      {
        preview: "Fix the login cache",
        previewRole: "user" as const,
        sessionId: "now",
        title: "Now",
        updatedAt: now.toISOString(),
      },
      {
        sessionId: "minutes",
        title: "Minutes",
        updatedAt: "2026-09-16T11:47:00.000Z",
      },
      {
        sessionId: "hours",
        title: "Hours",
        updatedAt: "2026-09-16T10:00:00.000Z",
      },
      {
        sessionId: "days",
        title: "Days",
        updatedAt: "2026-09-12T12:00:00.000Z",
      },
      {
        sessionId: "five-days",
        title: "Five days",
        updatedAt: "2026-09-11T12:00:00.000Z",
      },
      {
        sessionId: "date",
        title: "Date",
        updatedAt: "2026-09-10T12:00:00.000Z",
      },
      { sessionId: "unknown", title: "Unknown" },
    ];
    const history = vi
      .fn<() => Promise<typeof entries>>()
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce(entries)
      .mockResolvedValueOnce([]);
    const reopen = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const loadingPicker = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: vi.fn<(_listener: () => void) => { dispose: () => void }>(
        () => ({ dispose: vi.fn<() => void>() })
      ),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loadingPicker);
    vscode.showInformationMessage.mockClear();
    vscode.showQuickPick
      .mockResolvedValueOnce(null)
      .mockImplementationOnce(async (items: unknown) => {
        await Promise.resolve();
        return testValue<unknown[]>(items)[1];
      });
    const provider = new MischiefView(
      testValue<never>({
        open: async () => {
          await Promise.resolve();
          return { projects: [], ungrouped: [] };
        },
      }),
      testValue<never>({
        history,
        onChange: vi.fn<() => void>(),
        reopen,
        snapshot: () => ({ threads: [], workspace: "/workspace" }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({ get: (_key: string, fallback: unknown) => fallback }),
      testValue<never>(profileDatabase())
    );
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );

    receive?.({ type: "threadHistory" });
    expect({
      busy: loadingPicker.busy,
      placeholder: loadingPicker.placeholder,
      shows: loadingPicker.show.mock.calls.length,
      title: loadingPicker.title,
    }).toStrictEqual({
      busy: true,
      placeholder: "Loading previous Threads…",
      shows: 1,
      title: "Thread History",
    });
    await vi.runAllTimersAsync();
    expect(reopen).not.toHaveBeenCalled();
    receive?.({ type: "threadHistory" });
    await vi.runAllTimersAsync();

    const firstCall = testValue<
      [
        { label: string; description?: string }[],
        { placeHolder: string; title: string },
      ]
    >(testValue<unknown>(vscode.showQuickPick.mock.calls[0]));
    expect(firstCall).toStrictEqual([
      [
        {
          description: "now",
          detail: "You: Fix the login cache",
          entry: entries[0],
          label: "Now",
        },
        { description: "13min", entry: entries[1], label: "Minutes" },
        { description: "2h", entry: entries[2], label: "Hours" },
        { description: "4d", entry: entries[3], label: "Days" },
        { description: "5d", entry: entries[4], label: "Five days" },
        {
          description: new Date(
            entries[5].updatedAt ?? ""
          ).toLocaleDateString(),
          entry: entries[5],
          label: "Date",
        },
        { entry: entries[6], label: "Unknown" },
      ],
      { placeHolder: "Select a Thread to reopen", title: "Thread History" },
    ]);
    expect(reopen).toHaveBeenCalledExactlyOnceWith(entries[1]);

    receive?.({ type: "threadHistory" });
    await vi.runAllTimersAsync();
    expect(vscode.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
      "No previous Threads in this Workspace."
    );
    vi.useRealTimers();
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
    const sourceBranches = vi.fn<() => Promise<unknown[]>>(async () => {
      await Promise.resolve();
      return [];
    });
    const createWorkspace = vi.fn<() => Promise<string>>(async () => {
      await Promise.resolve();
      return "/worktree";
    });
    const listOpenIssues = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([
        { number: 6, title: "First issue", url: "https://example.test/6" },
      ])
      .mockResolvedValueOnce([]);
    const provider = new MischiefView(
      testValue<never>({
        createWorkspace,
        listOpenIssues,
        open: async () => {
          await Promise.resolve();
          return {
            projects: [{ name: "project", root: "/project", workspaces: [] }],
            ungrouped: [],
          };
        },
        sourceBranches,
      }),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({ get: (_key: string, fallback: unknown) => fallback }),
      testValue<never>(profileDatabase())
    );
    await provider.initialize("/project");
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );

    receive?.({ path: "/project", type: "openIssues" });
    await vi.waitFor(() => {
      expect(picker.show).toHaveBeenCalledOnce();
    });
    hide?.();
    await vi.waitFor(() => {
      expect(picker.dispose).toHaveBeenCalledOnce();
    });
    receive?.({ path: "/project", type: "openIssues" });
    await vi.waitFor(() => {
      expect(vscode.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
        "No open GitHub issues for project."
      );
    });

    expect(sourceBranches).not.toHaveBeenCalled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  test.each(["repository", "branches", "source", "name"])(
    "stops at the %s step before creating a Workspace",
    async (step) => {
      let receive: ((message: unknown) => void) | undefined;
      let accept: (() => void) | undefined;
      let sourceAccept: (() => void) | undefined;
      let sourceHidden: (() => void) | undefined;
      const picker = {
        dispose: vi.fn<() => void>(),
        hide: vi.fn<() => void>(),
        items: testValue<{ issue: unknown }[]>([]),
        onDidAccept: vi.fn<(listener: () => void) => { dispose: () => void }>(
          (listener) => {
            accept = listener;
            return { dispose: vi.fn<() => void>() };
          }
        ),
        onDidHide: vi.fn<(_listener: () => void) => { dispose: () => void }>(
          () => ({ dispose: vi.fn<() => void>() })
        ),
        onDidTriggerItemButton: vi.fn<
          (_listener: (event: unknown) => Promise<void>) => {
            dispose: () => void;
          }
        >(() => ({ dispose: vi.fn<() => void>() })),
        selectedItems: testValue<{ issue: unknown }[]>([]),
        show: vi.fn<() => void>(),
        title: "",
      };
      const sourcePicker = {
        activeItems: [],
        dispose: vi.fn<() => void>(),
        hide: vi.fn<() => void>(() => sourceHidden?.()),
        items: testValue<{ branch?: { name: string } }[]>([]),
        onDidAccept: vi.fn<(listener: () => void) => { dispose: () => void }>(
          (listener) => {
            sourceAccept = listener;
            return { dispose: vi.fn<() => void>() };
          }
        ),
        onDidHide: vi.fn<(listener: () => void) => { dispose: () => void }>(
          (listener) => {
            sourceHidden = listener;
            return { dispose: vi.fn<() => void>() };
          }
        ),
        selectedItems: testValue<{ branch?: { name: string } }[]>([]),
        show: vi.fn<() => void>(),
        title: "",
      };
      vscode.createQuickPick
        .mockReset()
        .mockReturnValueOnce(picker)
        .mockReturnValueOnce(sourcePicker);
      vscode.showInformationMessage.mockClear();
      vscode.showInputBox.mockReset();
      const cancelled: unknown = undefined;
      vscode.showInputBox.mockResolvedValue(cancelled);
      const createWorkspace = vi.fn<() => Promise<string>>(async () => {
        await Promise.resolve();
        return "/worktree";
      });
      const sourceBranches = vi.fn<() => Promise<unknown[]>>(async () => {
        await Promise.resolve();
        return step === "branches"
          ? []
          : [{ current: true, name: "main", remoteOnly: false }];
      });
      const provider = new MischiefView(
        testValue<never>({
          createWorkspace,
          listOpenIssues: async (
            _root: string,
            chooseRepository: (
              defaultRepository: string
            ) => Promise<string | undefined>
          ): Promise<unknown[] | undefined> => {
            if (
              step === "repository" &&
              !isNonEmpty(await chooseRepository("owner/project"))
            ) {
              return undefined;
            }
            return [
              {
                number: 7,
                title: "Create Workspace",
                url: "https://example.test/7",
              },
            ];
          },
          open: async () => {
            await Promise.resolve();
            return {
              projects: [{ name: "project", root: "/project", workspaces: [] }],
              ungrouped: [],
            };
          },
          sourceBranches,
        }),
        testValue<never>({
          onChange: vi.fn<() => void>(),
          snapshot: () => ({ threads: [] }),
        }),
        testValue<never>({ fsPath: process.cwd() }),
        testValue<never>({
          get: (_key: string, fallback: unknown) => fallback,
        }),
        testValue<never>(profileDatabase())
      );
      await provider.initialize("/project");
      await provider.resolveWebviewView(
        testValue<never>({
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
        })
      );

      receive?.({ path: "/project", type: "openIssues" });
      if (step !== "repository") {
        await vi.waitFor(() => {
          if (!picker.show.mock.calls.length) {
            throw new Error("Issue picker is not open");
          }
        });
        picker.selectedItems = [picker.items[0]];
        accept?.();
        if (step !== "branches") {
          await vi.waitFor(() => {
            if (!sourcePicker.show.mock.calls.length) {
              throw new Error("Source picker is not open");
            }
          });
          if (step === "source") {
            sourceHidden?.();
          } else {
            sourcePicker.selectedItems = [
              testValue<{
                branch: { name: string };
              }>(sourcePicker.items.find((item) => item.branch)),
            ];
            sourceAccept?.();
          }
        }
      }
      await vi.waitFor(() => {
        expect({
          information: vscode.showInformationMessage.mock.calls,
          issueShows: picker.show.mock.calls.length,
          namePrompts: vscode.showInputBox.mock.calls.length,
          sourceRequests: sourceBranches.mock.calls.length,
          sourceShows: sourcePicker.show.mock.calls.length,
          workspaceCreations: createWorkspace.mock.calls.length,
        }).toStrictEqual({
          information:
            step === "branches" ? [["No source branches for project."]] : [],
          issueShows: step === "repository" ? 0 : 1,
          namePrompts: step === "repository" || step === "name" ? 1 : 0,
          sourceRequests: step === "repository" ? 0 : 1,
          sourceShows: step === "repository" || step === "branches" ? 0 : 1,
          workspaceCreations: 0,
        });
      });
    }
  );

  test("selects a native fork target from a loading QuickPick", async () => {
    const loading = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: vi.fn<(_listener: () => void) => { dispose: () => void }>(
        () => ({ dispose: vi.fn<() => void>() })
      ),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loading);
    vscode.showQuickPick.mockReset().mockImplementation(async (items) => {
      await Promise.resolve();
      return testValue<unknown[]>(items)[0];
    });
    const fork = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const threads = {
      fork,
      forkTargets: async () => {
        await Promise.resolve();
        return {
          targets: [
            { entryId: "pi-user-1", text: "First\n  prompt" },
            { entryId: "pi-user-2", text: "Second prompt" },
          ],
          threadId: "source-thread",
        };
      },
      onChange: vi.fn<() => void>(),
    };
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>(threads),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    await testValue<{ showForkThread: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showForkThread();

    expect({
      disposed: loading.dispose.mock.calls.length,
      hidden: loading.hide.mock.calls.length,
      picker: vscode.showQuickPick.mock.calls,
      shown: loading.show.mock.calls.length,
      state: {
        busy: loading.busy,
        placeholder: loading.placeholder,
        title: loading.title,
      },
    }).toStrictEqual({
      disposed: 1,
      hidden: 1,
      picker: [
        [
          [
            {
              label: "Second prompt",
              target: { entryId: "pi-user-2", text: "Second prompt" },
            },
            {
              label: "First prompt",
              target: { entryId: "pi-user-1", text: "First\n  prompt" },
            },
          ],
          {
            placeHolder: "Select a user message to edit in a new Thread",
            title: "Fork Thread",
          },
        ],
      ],
      shown: 1,
      state: {
        busy: true,
        placeholder: "Loading fork points…",
        title: "Fork Thread",
      },
    });
    expect(fork).toHaveBeenCalledExactlyOnceWith("source-thread", {
      entryId: "pi-user-2",
      text: "Second prompt",
    });
  });

  test("does nothing when loading fork targets is cancelled", async () => {
    let hide: (() => void) | undefined;
    let resolveTargets:
      | ((value: {
          targets: { entryId: string; text: string }[];
          threadId: string;
        }) => void)
      | undefined;
    const loading = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: (listener: () => void) => {
        hide = listener;
        return { dispose: vi.fn<() => void>() };
      },
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loading);
    vscode.showQuickPick.mockReset();
    const fork = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        fork,
        forkTargets: async () =>
          // oxlint-disable-next-line promise/avoid-new -- controls picker cancellation timing
          await new Promise((resolve) => {
            resolveTargets = resolve;
          }),
        onChange: vi.fn<() => void>(),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    const operation = testValue<{ showForkThread: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showForkThread();
    hide?.();
    resolveTargets?.({
      targets: [{ entryId: "pi-user-1", text: "First" }],
      threadId: "source-thread",
    });
    await operation;

    expect(vscode.showQuickPick).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });

  test("reports when a Thread has no fork points", async () => {
    const loading = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: () => ({ dispose: vi.fn<() => void>() }),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loading);
    vscode.showInformationMessage.mockClear();
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        forkTargets: async () => {
          await Promise.resolve();
          return { targets: [], threadId: "source-thread" };
        },
        onChange: vi.fn<() => void>(),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    await testValue<{ showForkThread: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showForkThread();

    expect(vscode.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
      "No fork points are available in this Thread."
    );
  });

  test("presents and selects a native Thread tree target", async () => {
    const loading = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: vi.fn<(_listener: () => void) => { dispose: () => void }>(
        () => ({ dispose: vi.fn<() => void>() })
      ),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loading);
    vscode.showQuickPick.mockReset().mockImplementation(async (items) => {
      await Promise.resolve();
      return testValue<unknown[]>(items)[1];
    });
    const navigateTree = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const targets = [
      {
        activeBranch: true,
        current: false,
        depth: 0,
        entryId: "pi-user-1",
        role: "user",
        text: "First prompt",
      },
      {
        activeBranch: true,
        current: true,
        depth: 1,
        entryId: "pi-assistant-1",
        role: "assistant",
        text: "First\nanswer",
      },
      {
        activeBranch: false,
        current: false,
        depth: 2,
        entryId: "pi-user-2",
        role: "user",
        text: "Alternate",
      },
    ];
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        navigateTree,
        onChange: vi.fn<() => void>(),
        treeTargets: async () => {
          await Promise.resolve();
          return {
            branchSummarySupported: true,
            targets,
            threadId: "source-thread",
          };
        },
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    await testValue<{ showNavigateThreadTree: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showNavigateThreadTree();

    expect({
      disposed: loading.dispose.mock.calls.length,
      hidden: loading.hide.mock.calls.length,
      picker: vscode.showQuickPick.mock.calls,
      shown: loading.show.mock.calls.length,
      state: {
        busy: loading.busy,
        placeholder: loading.placeholder,
        title: loading.title,
      },
    }).toStrictEqual({
      disposed: 1,
      hidden: 1,
      picker: [
        [
          [
            {
              label: "-- You: Alternate",
              target: targets[2],
            },
            {
              description: "current leaf",
              label: "- Agent: First answer",
              target: targets[1],
            },
            {
              label: "You: First prompt",
              target: targets[0],
            },
          ],
          {
            placeHolder: "Select a message to make active",
            title: "Navigate Thread Tree",
          },
        ],
      ],
      shown: 1,
      state: {
        busy: true,
        placeholder: "Loading Thread tree…",
        title: "Navigate Thread Tree",
      },
    });
    expect(navigateTree).toHaveBeenCalledExactlyOnceWith(
      "source-thread",
      targets[1],
      { summarize: false }
    );
  });

  test.each([
    {
      choice: 0,
      expected: { summarize: false },
      name: "without a summary",
    },
    {
      choice: 1,
      expected: { summarize: true },
      name: "with Pi's default summary",
    },
    {
      choice: 2,
      customInstructions: "Focus on unresolved errors",
      expected: {
        customInstructions: "Focus on unresolved errors",
        summarize: true,
      },
      name: "with custom summary focus",
    },
  ])("navigates $name", async ({ choice, customInstructions, expected }) => {
    const loading = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: () => ({ dispose: vi.fn<() => void>() }),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loading);
    let picker = 0;
    vscode.showQuickPick.mockReset().mockImplementation(async (items) => {
      await Promise.resolve();
      picker += 1;
      return testValue<unknown[]>(items)[picker === 1 ? 0 : choice];
    });
    vscode.showInputBox.mockReset().mockResolvedValue(customInstructions);
    const navigateTree = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const target = {
      activeBranch: false,
      current: false,
      depth: 1,
      entryId: "pi-user-2",
      role: "user",
      text: "Alternate",
    } as const;
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        navigateTree,
        onChange: vi.fn<() => void>(),
        treeTargets: async () => {
          await Promise.resolve();
          return {
            branchSummarySupported: true,
            targets: [target],
            threadId: "source-thread",
          };
        },
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );
    const render = vi.fn<() => Promise<boolean>>(async () => {
      await Promise.resolve();
      return true;
    });
    testValue<{ render: typeof render }>(provider).render = render;

    await testValue<{ showNavigateThreadTree: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showNavigateThreadTree();

    expect(vscode.showQuickPick.mock.calls[1]).toStrictEqual([
      [
        { label: "No summary", summarize: false },
        { label: "Pi's default branch summary", summarize: true },
        {
          custom: true,
          label: "Pi's branch summary with custom focus…",
          summarize: true,
        },
      ],
      {
        placeHolder: "Choose how to handle the abandoned branch",
        title: "Branch Summary",
      },
    ]);
    expect(navigateTree).toHaveBeenCalledExactlyOnceWith(
      "source-thread",
      target,
      expected
    );
    expect(vscode.showInputBox).toHaveBeenCalledTimes(choice === 2 ? 1 : 0);
    expect(render).toHaveBeenCalledOnce();
  });

  test.each([
    { custom: false, name: "branch-summary choice" },
    { custom: true, name: "custom-focus input" },
  ])("cancelling the $name does not navigate", async ({ custom }) => {
    vscode.createQuickPick.mockReset().mockReturnValue({
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: () => ({ dispose: vi.fn<() => void>() }),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    });
    let picker = 0;
    vscode.showQuickPick.mockReset().mockImplementation(async (items) => {
      await Promise.resolve();
      picker += 1;
      if (picker === 1) {
        return testValue<unknown[]>(items)[0];
      }
      return custom ? testValue<unknown[]>(items)[2] : undefined;
    });
    vscode.showInputBox.mockReset();
    const navigateTree = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        navigateTree,
        onChange: vi.fn<() => void>(),
        treeTargets: async () => {
          await Promise.resolve();
          return {
            branchSummarySupported: true,
            targets: [
              {
                activeBranch: false,
                current: false,
                depth: 0,
                entryId: "pi-user-2",
                role: "user",
                text: "Alternate",
              },
            ],
            threadId: "source-thread",
          };
        },
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    await testValue<{ showNavigateThreadTree: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showNavigateThreadTree();

    expect(navigateTree).not.toHaveBeenCalled();
  });

  test("marks the deepest visible target for a filtered active leaf", async () => {
    vscode.createQuickPick.mockReset().mockReturnValue({
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: () => ({ dispose: vi.fn<() => void>() }),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    });
    vscode.showQuickPick.mockReset().mockResolvedValue(null);
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        treeTargets: async () => {
          await Promise.resolve();
          return {
            targets: [
              {
                activeBranch: true,
                current: false,
                depth: 0,
                entryId: "pi-user-1",
                role: "user",
                text: "First",
              },
              {
                activeBranch: true,
                current: false,
                depth: 1,
                entryId: "pi-assistant-1",
                role: "assistant",
                text: "Answer",
              },
            ],
            threadId: "source-thread",
          };
        },
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    await testValue<{ showNavigateThreadTree: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showNavigateThreadTree();

    const [pickerCall] = vscode.showQuickPick.mock.calls;
    if (!isDefined(pickerCall)) {
      throw new Error("Missing tree picker");
    }
    expect(
      testValue<{ description?: string }[]>(pickerCall[0]).map(
        (item) => item.description ?? null
      )
    ).toStrictEqual(["active branch", null]);
  });

  test("does nothing when loading Thread tree targets is cancelled", async () => {
    let hide: (() => void) | undefined;
    let resolveTargets:
      | ((value: {
          targets: {
            activeBranch: boolean;
            current: boolean;
            depth: number;
            entryId: string;
            role: "user";
            text: string;
          }[];
          threadId: string;
        }) => void)
      | undefined;
    const loading = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: (listener: () => void) => {
        hide = listener;
        return { dispose: vi.fn<() => void>() };
      },
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loading);
    vscode.showQuickPick.mockReset();
    const navigateTree = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        navigateTree,
        onChange: vi.fn<() => void>(),
        treeTargets: async () =>
          // oxlint-disable-next-line promise/avoid-new -- controls picker cancellation timing
          await new Promise((resolve) => {
            resolveTargets = resolve;
          }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    const operation = testValue<{
      showNavigateThreadTree: () => Promise<void>;
    }>(testValue<unknown>(provider)).showNavigateThreadTree();
    hide?.();
    resolveTargets?.({
      targets: [
        {
          activeBranch: true,
          current: true,
          depth: 0,
          entryId: "pi-user-1",
          role: "user",
          text: "First",
        },
      ],
      threadId: "source-thread",
    });
    await operation;

    expect(vscode.showQuickPick).not.toHaveBeenCalled();
    expect(navigateTree).not.toHaveBeenCalled();
  });

  test("reports when a Thread tree has no message entries", async () => {
    const loading = {
      busy: false,
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(),
      onDidHide: () => ({ dispose: vi.fn<() => void>() }),
      placeholder: "",
      show: vi.fn<() => void>(),
      title: "",
    };
    vscode.createQuickPick.mockReset().mockReturnValue(loading);
    vscode.showInformationMessage.mockClear();
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        treeTargets: async () => {
          await Promise.resolve();
          return { targets: [], threadId: "source-thread" };
        },
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    await testValue<{ showNavigateThreadTree: () => Promise<void> }>(
      testValue<unknown>(provider)
    ).showNavigateThreadTree();

    expect(vscode.showInformationMessage).toHaveBeenCalledExactlyOnceWith(
      "No message entries are available in this Thread tree."
    );
  });

  test("creates and seeds a Thread after transcript setup completes", async () => {
    const newThread = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const prompt = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const setupComplete = new Map<
      string,
      { id: string; message: string }
    >().get("complete");
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({ newThread, onChange: vi.fn<() => void>(), prompt }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase()),
      {
        advance: async () => {
          await Promise.resolve();
          return setupComplete;
        },
        prompt: () => ({
          id: "node",
          message: "Node.js was not detected. Press Enter to continue.",
        }),
      }
    );

    await provider.newThread(true, "Read issue");
    expect(newThread).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();

    await testValue<{
      continueSetup: (selected: string[]) => Promise<void>;
    }>(testValue<unknown>(provider)).continueSetup([]);

    expect(newThread).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledExactlyOnceWith("Read issue");
  });

  test("opens the owning Workspace only after a remote Thread selection", async () => {
    vscode.executeCommand.mockClear();
    const select = vi
      .fn<(id: string) => Promise<string | undefined>>()
      .mockResolvedValueOnce("/current")
      .mockResolvedValueOnce("/remote");
    const threads = {
      onChange: vi.fn<() => void>(),
      openWorkspace: vi.fn<() => Promise<void>>(async () => {
        await Promise.resolve();
      }),
      select,
      snapshot: () => ({ threads: [], workspace: "/current" }),
    };
    const provider = new MischiefView(
      testValue<never>({
        refresh: async () => {
          await Promise.resolve();
          return {
            projects: [],
            ungrouped: [
              {
                ahead: 0,
                behind: 0,
                changes: 0,
                current: true,
                linked: false,
                name: "current",
                path: "/current",
              },
              {
                ahead: 0,
                behind: 0,
                changes: 0,
                current: false,
                linked: false,
                name: "remote",
                path: "/remote",
              },
            ],
          };
        },
      }),
      testValue<never>(threads),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({ get: (_key: string, fallback: unknown) => fallback }),
      testValue<never>(profileDatabase())
    );
    await provider.initialize();
    const handle = testValue<{
      handleThreadMessage: (data: Record<string, unknown>) => Promise<boolean>;
    }>(testValue<unknown>(provider)).handleThreadMessage.bind(provider);

    await handle({ id: "local-thread", type: "selectThread" });
    await handle({ id: "remote-thread", type: "selectThread" });

    expect(select.mock.calls).toStrictEqual([
      ["local-thread"],
      ["remote-thread"],
    ]);
    expect(vscode.executeCommand).toHaveBeenCalledExactlyOnceWith(
      "vscode.openFolder",
      { fsPath: "/remote" },
      { forceNewWindow: true }
    );
  });

  test("renames the clicked Thread instead of the selected Thread", async () => {
    vscode.showInputBox.mockReset();
    vscode.showInputBox.mockResolvedValue("Renamed Background");
    const rename = vi.fn<(id: string, name: string) => Promise<void>>(
      async () => {
        await Promise.resolve();
      }
    );
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        rename,
        snapshot: () => ({
          selected: { id: "selected", name: "Selected" },
          threads: [
            { id: "selected", name: "Selected" },
            { id: "background", name: "Background" },
          ],
        }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );
    const handled = await testValue<{
      handleThreadMessage: (data: Record<string, unknown>) => Promise<boolean>;
    }>(testValue<unknown>(provider)).handleThreadMessage({
      id: "background",
      type: "renameThread",
    });

    expect({
      handled,
      prompt: vscode.showInputBox.mock.calls,
      rename: rename.mock.calls,
    }).toStrictEqual({
      handled: true,
      prompt: [
        [
          expect.objectContaining({
            title: "Rename Thread",
            value: "Background",
          }),
        ],
      ],
      rename: [["background", "Renamed Background"]],
    });
  });

  test("toggles Expand All and Collapse All in the native Mischief title bar", () => {
    const manifest = testValue<{
      contributes: {
        commands: { command: string; icon?: string; title: string }[];
        menus: Record<string, { command: string; group: string }[]>;
      };
    }>(JSON.parse(readFileSync("package.json", "utf-8")));

    expect(manifest.contributes.commands).toStrictEqual(
      expect.arrayContaining([
        {
          command: "mischief.expandAll",
          icon: "$(expand-all)",
          title: "Mischief: Expand All",
        },
        {
          command: "mischief.collapseAll",
          icon: "$(collapse-all)",
          title: "Mischief: Collapse All",
        },
      ])
    );
    expect(manifest.contributes.menus["view/title"]).toStrictEqual(
      expect.arrayContaining([
        {
          command: "mischief.expandAll",
          group: "navigation@3",
          when: "view == mischief.view && !mischief.navigatorAllExpanded",
        },
        {
          command: "mischief.collapseAll",
          group: "navigation@3",
          when: "view == mischief.view && mischief.navigatorAllExpanded",
        },
      ])
    );
  });

  test("static webview shell loads the React bundle", () => {
    const html = readFileSync("media/webview.html", "utf-8");

    expect(html).toContain('id="root"');
    expect(html).toContain('src="{{scriptUri}}"');
    expect(html).toContain('href="{{styleUri}}"');
  });

  test("sends only the changed transcript item while streaming", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    let emit: ((change: unknown) => void) | undefined;
    const threads = {
      onChange: (listener: (change: unknown) => void) => {
        emit = listener;
      },
      snapshot: () => ({
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
      testValue<never>({}),
      testValue<never>(threads),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );
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

    postMessage.mockClear();
    emit?.({
      operation: "branchSummary",
      threadId: "thread-1",
      type: "sessionOperation",
    });

    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      operation: "branchSummary",
      threadId: "thread-1",
      type: "sessionOperation",
    });
  });

  test("loads static assets and counts visible Thread attention in the native badge", async () => {
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
    const view = { onDidDispose: vi.fn<() => void>(), webview };
    let needsAttention = true;
    let emit: (() => void) | undefined;
    const threads = {
      onChange: (listener: () => void) => {
        emit = listener;
      },
      snapshot: () => ({
        threads: ["waiting", "completed"].map((id) => ({
          id,
          indicator: id === "waiting" ? "waiting" : "completed",
          name: id,
          needsAttention,
          updatedAt: "2026-01-01T00:00:00.000Z",
          workspace: "/workspace",
        })),
      }),
    };
    const provider = new MischiefView(
      testValue<never>({
        refresh: async () => {
          await Promise.resolve();
          return {
            projects: [],
            ungrouped: [
              {
                ahead: 0,
                behind: 0,
                changes: 0,
                current: false,
                linked: false,
                name: "workspace",
                path: "/workspace",
              },
            ],
          };
        },
      }),
      testValue<never>(threads),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({ get: (_key: string, fallback: unknown) => fallback }),
      testValue<never>(profileDatabase())
    );
    await provider.initialize();
    await provider.resolveWebviewView(testValue<never>(view));

    expect(testValue<{ badge?: unknown }>(view).badge).toStrictEqual({
      tooltip: "2 Threads need attention",
      value: 2,
    });
    needsAttention = false;
    emit?.();
    expect(testValue<{ badge?: unknown }>(view).badge).toStrictEqual({
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

  test("posts synchronized Workspace and Thread summaries after a database change", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    let databaseChanged: (() => void) | undefined;
    let workspaces: unknown[] = [];
    const projectsSnapshot = {
      projects: [],
      ungrouped: [
        {
          ahead: 0,
          behind: 0,
          changes: 0,
          current: false,
          linked: false,
          name: "remote",
          path: "/remote",
        },
      ],
    };
    const provider = new MischiefView(
      testValue<never>({
        refresh: async () => {
          await Promise.resolve();
          return projectsSnapshot;
        },
      }),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        snapshot: () => ({
          threads: [
            {
              id: "remote-thread",
              indicator: "waiting",
              name: "Remote",
              needsAttention: true,
              updatedAt: "2026-01-01T00:00:00.000Z",
              workspace: "/remote",
            },
          ],
        }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>({
        onChange: (listener: () => void) => {
          databaseChanged = listener;
        },
        snapshot: () => ({ workspaces }),
      })
    );
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );
    postMessage.mockClear();
    workspaces = [{ path: "/remote", status: "active" }];
    databaseChanged?.();

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          projects: projectsSnapshot,
          threads: testValue<unknown>(
            expect.objectContaining({
              threads: [expect.objectContaining({ workspace: "/remote" })],
            })
          ),
          type: "state",
        })
      );
    });
  });

  test("posts Expand All and Collapse All requests to the Navigator", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );
    postMessage.mockClear();

    provider.setAllExpanded(true);
    provider.setAllExpanded(false);

    expect(postMessage.mock.calls).toStrictEqual([
      [{ expanded: true, type: "setAllExpanded" }],
      [{ expanded: false, type: "setAllExpanded" }],
    ]);
  });

  test("updates the native toggle after Navigator expansion changes", async () => {
    let receive: ((message: unknown) => void) | undefined;
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );
    vscode.executeCommand.mockClear();

    receive?.({ expanded: true, type: "navigatorExpanded" });
    receive?.({ expanded: false, type: "navigatorExpanded" });

    await vi.waitFor(() => {
      expect(vscode.executeCommand.mock.calls).toStrictEqual([
        ["setContext", "mischief.navigatorAllExpanded", true],
        ["setContext", "mischief.navigatorAllExpanded", false],
      ]);
    });
  });

  test("persists Workspace color assignment from Settings", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    let receive: ((message: unknown) => void) | undefined;
    vscode.assignWorkspaceColors = true;
    vscode.updateConfiguration.mockImplementation(async (_key, value) => {
      await Promise.resolve();
      vscode.assignWorkspaceColors = testValue<boolean>(value);
    });
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );
    postMessage.mockClear();

    provider.showSettings();
    receive?.({ type: "setAssignWorkspaceColors", value: false });
    await vi.waitFor(() => {
      expect(vscode.updateConfiguration).toHaveBeenCalledWith(
        "assignWorkspaceColors",
        false,
        1
      );
    });
    provider.showSettings();

    expect(postMessage.mock.calls).toStrictEqual([
      [{ assignWorkspaceColors: true, type: "showSettings" }],
      [{ assignWorkspaceColors: false, type: "showSettings" }],
    ]);
    vscode.updateConfiguration.mockReset();
    vscode.assignWorkspaceColors = true;
  });

  test("opens file links from transcript Markdown in the owning Workspace", async () => {
    let receive: ((message: unknown) => void) | undefined;
    const workspace = process.cwd();
    const { showTextDocument } = vscode;
    showTextDocument.mockClear();
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>({
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [], workspace }),
      }),
      testValue<never>({ fsPath: process.cwd() }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );
    await provider.resolveWebviewView(
      testValue<never>({
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
      })
    );

    receive?.({
      href: pathToFileURL(path.join(workspace, "src/view.ts")).href,
      type: "openTranscriptLink",
    });

    await vi.waitFor(() => {
      expect(showTextDocument).toHaveBeenCalledExactlyOnceWith(
        { fsPath: path.join(workspace, "src/view.ts") },
        { preview: true }
      );
    });
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
              text: "**Bold** <script>alert(1)</script> [Open](file:///workspace/src/view.ts)",
            },
          ],
        },
        threads: [],
      }),
    };
    const provider = new MischiefView(
      testValue<never>({}),
      testValue<never>(threads),
      testValue<never>({
        fsPath: process.cwd(),
      }),
      testValue<never>({}),
      testValue<never>(profileDatabase())
    );

    await provider.resolveWebviewView(testValue<never>(view));

    const state = testValue<{
      threads: { selected: { items: { html: string }[] } };
    }>(postMessage.mock.calls.at(-1)?.[0]);
    expect(state.threads.selected.items[0]?.html).toBe(
      '<p><strong>Bold</strong> &lt;script&gt;alert(1)&lt;/script&gt; <a href="file:///workspace/src/view.ts">Open</a></p>\n'
    );
  });
});
