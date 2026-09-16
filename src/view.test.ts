import { readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import { describe, expect, test, vi } from "vitest";

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
  executeCommand: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  openExternal: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
  showErrorMessage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  showInformationMessage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  showInputBox: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  updateConfiguration: vi.fn<
    (key: string, value: unknown, target: number) => Promise<void>
  >(() => Promise.resolve()),
}));

vi.mock(
  import("vscode"),
  () =>
    ({
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
      prompt: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      snapshot: () => ({
        threads: [],
        ...(active ? { workspace: active } : {}),
      }),
    };
    const storage = {
      get: () => pending,
      update: vi.fn<(_key: string, value: unknown) => Promise<void>>(
        (_key, value) => {
          pending = value as typeof pending;
          return Promise.resolve();
        }
      ),
    };
    const provider = new MischiefView(
      projects as never,
      threads as never,
      { fsPath: process.cwd() } as never,
      storage as never,
      profileDatabase() as never
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
    vscode.executeCommand.mockImplementation(() => {
      events.push("focus");
      return Promise.resolve();
    });
    const threads = {
      newThread: vi.fn<() => Promise<void>>(() => {
        events.push("newThread");
        return Promise.resolve();
      }),
      onChange: vi.fn<() => void>(),
      openWorkspace: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      prompt: vi.fn<(text: string) => Promise<void>>((text) => {
        events.push(`prompt:${text}`);
        promptStarted.resolve();
        return promptFinished.promise;
      }),
      snapshot: () => ({ threads: [] }),
    };
    const provider = new MischiefView(
      {
        open: () =>
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
          }),
      } as never,
      threads as never,
      { fsPath: process.cwd() } as never,
      {
        get: () => pending,
        update: vi.fn<(_key: string, value: unknown) => Promise<void>>(
          (_key, value) => {
            pending = value as typeof pending;
            events.push("remove");
            return Promise.resolve();
          }
        ),
      } as never,
      profileDatabase() as never
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
    let sourceAccept: (() => void) | undefined;
    let sourceHidden: (() => void) | undefined;
    const sourcePicker = {
      activeItems: [] as { branch?: { current: boolean; name: string } }[],
      dispose: vi.fn<() => void>(),
      hide: vi.fn<() => void>(() => sourceHidden?.()),
      items: [] as {
        branch?: { current: boolean; name: string };
        description?: string;
        kind?: number;
        label: string;
      }[],
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
      selectedItems: [] as { branch?: { current: boolean; name: string } }[],
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
    const createWorkspace = vi.fn<() => Promise<string>>(() =>
      Promise.resolve("/worktree")
    );
    const sourceBranches = vi.fn<() => Promise<unknown[]>>(() =>
      Promise.resolve([
        {
          ahead: 2,
          behind: 1,
          current: true,
          name: "main",
          remoteOnly: false,
        },
        { current: false, name: "alpha", remoteOnly: false },
        { current: false, name: "origin/release", remoteOnly: true },
      ])
    );
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
      return repository
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
      open: vi.fn<() => Promise<unknown>>(() =>
        Promise.resolve({
          projects: [{ name: "project", root: "/project", workspaces: [] }],
          ungrouped: [],
        })
      ),
      refresh: vi.fn<() => Promise<unknown>>(() => Promise.resolve(snapshot)),
      sourceBranches,
    };
    const storage = {
      get: (_key: string, fallback: unknown) => fallback,
      update: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    };
    const provider = new MischiefView(
      projects as never,
      {
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      storage as never,
      profileDatabase() as never
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
    await vi.waitFor(() =>
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
      })
    );

    await triggerButton?.({ item: picker.items[1] as { issue: unknown } });
    vscode.openExternal.mockRejectedValueOnce(new Error("blocked"));
    await triggerButton?.({ item: picker.items[0] as { issue: unknown } });

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

    picker.selectedItems = [picker.items[1] as { issue: unknown }];
    accept?.();
    await vi.waitFor(() => expect(sourcePicker.show).toHaveBeenCalledOnce());
    sourcePicker.selectedItems = [
      sourcePicker.items.find(
        (item) => item.branch?.name === "origin/release"
      ) as { branch: { current: boolean; name: string } },
    ];
    sourceAccept?.();
    await vi.waitFor(() => expect(createWorkspace).toHaveBeenCalledOnce());
    const [repositoryOptions] = vscode.showInputBox.mock.calls[0] as [
      { prompt: string; title: string; value: string },
    ];
    const [nameOptions] = vscode.showInputBox.mock.calls[1] as [
      { prompt: string; title: string; value: string },
    ];

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
        ...(description ? { description } : {}),
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
        snapshot: () => ({ threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      profileDatabase() as never
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
        items: [] as { issue: unknown }[],
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
        selectedItems: [] as { issue: unknown }[],
        show: vi.fn<() => void>(),
        title: "",
      };
      const sourcePicker = {
        activeItems: [],
        dispose: vi.fn<() => void>(),
        hide: vi.fn<() => void>(() => sourceHidden?.()),
        items: [] as { branch?: { name: string } }[],
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
        selectedItems: [] as { branch?: { name: string } }[],
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
      const createWorkspace = vi.fn<() => Promise<string>>(() =>
        Promise.resolve("/worktree")
      );
      const sourceBranches = vi.fn<() => Promise<unknown[]>>(() =>
        Promise.resolve(
          step === "branches"
            ? []
            : [{ current: true, name: "main", remoteOnly: false }]
        )
      );
      const provider = new MischiefView(
        {
          createWorkspace,
          listOpenIssues: async (
            _root: string,
            chooseRepository: (
              defaultRepository: string
            ) => Promise<string | undefined>
          ): Promise<unknown[] | undefined> => {
            if (
              step === "repository" &&
              !(await chooseRepository("owner/project"))
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
          open: () =>
            Promise.resolve({
              projects: [{ name: "project", root: "/project", workspaces: [] }],
              ungrouped: [],
            }),
          sourceBranches,
        } as never,
        {
          onChange: vi.fn<() => void>(),
          snapshot: () => ({ threads: [] }),
        } as never,
        { fsPath: process.cwd() } as never,
        { get: (_key: string, fallback: unknown) => fallback } as never,
        profileDatabase() as never
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
      if (step !== "repository") {
        await vi.waitFor(() => {
          if (!picker.show.mock.calls.length) {
            throw new Error("Issue picker is not open");
          }
        });
        picker.selectedItems = [picker.items[0] as { issue: unknown }];
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
              sourcePicker.items.find((item) => item.branch) as {
                branch: { name: string };
              },
            ];
            sourceAccept?.();
          }
        }
      }
      await vi.waitFor(() =>
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
        })
      );
    }
  );

  test("creates and seeds a Thread after transcript setup completes", async () => {
    const newThread = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const prompt = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const setupComplete = new Map<
      string,
      { id: string; message: string }
    >().get("complete");
    const provider = new MischiefView(
      {} as never,
      { newThread, onChange: vi.fn<() => void>(), prompt } as never,
      { fsPath: process.cwd() } as never,
      {} as never,
      profileDatabase() as never,
      {
        advance: () => Promise.resolve(setupComplete),
        prompt: () => ({
          id: "node",
          message: "Node.js was not detected. Press Enter to continue.",
        }),
      }
    );

    await provider.newThread(true, "Read issue");
    expect(newThread).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();

    await (
      provider as unknown as {
        continueSetup: (selected: string[]) => Promise<void>;
      }
    ).continueSetup([]);

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
      openWorkspace: vi.fn<() => Promise<void>>(() => Promise.resolve()),
      select,
      snapshot: () => ({ threads: [], workspace: "/current" }),
    };
    const provider = new MischiefView(
      {
        refresh: () =>
          Promise.resolve({
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
          }),
      } as never,
      threads as never,
      { fsPath: process.cwd() } as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      profileDatabase() as never
    );
    await provider.initialize();
    const handle = (
      provider as unknown as {
        handleThreadMessage: (
          data: Record<string, unknown>
        ) => Promise<boolean>;
      }
    ).handleThreadMessage.bind(provider);

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
    const rename = vi.fn<(id: string, name: string) => Promise<void>>(() =>
      Promise.resolve()
    );
    const provider = new MischiefView(
      {} as never,
      {
        onChange: vi.fn<() => void>(),
        rename,
        snapshot: () => ({
          selected: { id: "selected", name: "Selected" },
          threads: [
            { id: "selected", name: "Selected" },
            { id: "background", name: "Background" },
          ],
        }),
      } as never,
      { fsPath: process.cwd() } as never,
      {} as never,
      profileDatabase() as never
    );
    const handled = await (
      provider as unknown as {
        handleThreadMessage: (
          data: Record<string, unknown>
        ) => Promise<boolean>;
      }
    ).handleThreadMessage({ id: "background", type: "renameThread" });

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
    const manifest = JSON.parse(readFileSync("package.json", "utf-8")) as {
      contributes: {
        commands: { command: string; icon?: string; title: string }[];
        menus: Record<string, { command: string; group: string }[]>;
      };
    };

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

  test("anchors the Thread directly beneath content-sized navigation", () => {
    const style = readFileSync("media/webview.css", "utf-8");

    expect(style).toMatch(/#navigator \{[^}]*flex: 0 1 auto;/u);
    expect(style).toMatch(/#thread \{[^}]*flex: 1 0 72px;/u);
    expect(style).not.toContain(".resizer");
  });

  test("keeps Navigator metadata and hover actions compact", () => {
    const style = readFileSync("media/webview.css", "utf-8");

    expect(style).toMatch(
      /\.project-action-icon \{[^}]*width: 14px;[^}]*height: 14px;/u
    );
    expect(style).toMatch(
      /\.thread-action-icon \{[^}]*width: 14px;[^}]*height: 14px;/u
    );
    expect(style).toMatch(
      /\.workspace-branch \{[^}]*margin-left: 10px;[\s\S]*\.thread-activity \{[^}]*gap: 6px;[^}]*padding-left: 0;[\s\S]*\.thread-activity::before \{[^}]*content: "·";/u
    );
    expect(style).toMatch(
      /#navigator :is\(\.group-row, \.row\) > \.icon \{[^}]*opacity: 0;[\s\S]*#navigator :is\(\.group-row, \.row\):is\(:hover, :focus-within\) > \.icon \{[^}]*opacity: 1;/u
    );
  });

  test("conversation content wraps instead of creating horizontal overflow", () => {
    const style = readFileSync("media/webview.css", "utf-8");

    expect(style).toMatch(
      /#thread \{[^}]*min-width: 0;[^}]*overflow: hidden;/u
    );
    expect(style).toMatch(
      /#configs \{[^}]*overflow-x: auto;[^}]*scrollbar-width: none;[\s\S]*#chat \* \{[^}]*min-width: 0;[^}]*max-width: 100%;/u
    );
    expect(style).toMatch(
      /\.markdown pre \{[^}]*overflow-x: hidden;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/u
    );
    expect(style).toMatch(/\.markdown table \{[^}]*table-layout: fixed;/u);
    expect(style).toMatch(
      /\.tool-body pre \{[^}]*overflow-y: auto;[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/u
    );
  });

  test("keeps operation targets compact and statuses visual", () => {
    const style = readFileSync("media/webview.css", "utf-8");

    expect(style).toMatch(
      /\.tool-operation-target \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;[\s\S]*\.terminal-command \{[^}]*font-family: var\(--mischief-mono-font\);/u
    );
    expect(style).toMatch(
      /\.tool-operation-status:is\(\.pending, \.in_progress\)::before \{[^}]*animation: thread-status-frame/u
    );
    expect(style).toMatch(
      /\.entry\.thought \{[^}]*--entry-accent: var\(--vscode-charts-purple,[\s\S]*\.entry\.tool \{[^}]*--entry-accent: var\(--vscode-charts-orange,[\s\S]*\.entry\.file-operations-group \{[^}]*--entry-accent: var\(--vscode-charts-blue,/u
    );
    expect(style).toMatch(
      /\.entry\.ask-user-result \{[^}]*--entry-accent: var\([^}]*--vscode-charts-yellow,[^}]*--vscode-descriptionForeground[\s\S]*\.ask-user-title \{[^}]*color: var\(--entry-accent\);[\s\S]*\.ask-user-question \{[^}]*color: var\(--entry-accent\);[\s\S]*\.ask-user-answer \{[^}]*color: var\(--vscode-foreground\);/u
    );
    expect(style).toMatch(
      /\.thinking-content,\s*\.tool-group-content,\s*\.ask-user-content \{[^}]*margin: 8px 0 0 6px;[^}]*border-left: 1px solid[^}]*padding-left: 15px;/u
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
      {} as never,
      profileDatabase() as never
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
          createdAt: "2026-01-01T00:00:00.000Z",
          id,
          indicator: id === "waiting" ? "waiting" : "completed",
          name: id,
          needsAttention,
          status: id === "waiting" ? "waiting" : "idle",
          updatedAt: "2026-01-01T00:00:00.000Z",
          workspace: "/workspace",
        })),
      }),
    };
    const provider = new MischiefView(
      {
        refresh: () =>
          Promise.resolve({
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
          }),
      } as never,
      threads as never,
      { fsPath: process.cwd() } as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      profileDatabase() as never
    );
    await provider.initialize();
    await provider.resolveWebviewView(view as never);

    expect((view as { badge?: unknown }).badge).toStrictEqual({
      tooltip: "2 Threads need attention",
      value: 2,
    });
    needsAttention = false;
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
      { refresh: () => Promise.resolve(projectsSnapshot) } as never,
      {
        onChange: vi.fn<() => void>(),
        snapshot: () => ({
          threads: [
            {
              createdAt: "2026-01-01T00:00:00.000Z",
              id: "remote-thread",
              indicator: "waiting",
              name: "Remote",
              needsAttention: true,
              status: "waiting",
              updatedAt: "2026-01-01T00:00:00.000Z",
              workspace: "/remote",
            },
          ],
        }),
      } as never,
      { fsPath: process.cwd() } as never,
      {} as never,
      {
        onChange: (listener: () => void) => {
          databaseChanged = listener;
        },
        snapshot: () => ({ workspaces }),
      } as never
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
    workspaces = [{ path: "/remote", status: "active" }];
    databaseChanged?.();

    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          projects: projectsSnapshot,
          threads: expect.objectContaining({
            threads: [expect.objectContaining({ workspace: "/remote" })],
          }),
          type: "state",
        })
      )
    );
  });

  test("posts Expand All and Collapse All requests to the Navigator", async () => {
    const postMessage = vi.fn<(message: unknown) => void>();
    const provider = new MischiefView(
      {} as never,
      {
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      {} as never,
      profileDatabase() as never
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
      {} as never,
      {
        onChange: vi.fn<() => void>(),
        snapshot: () => ({ threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      {} as never,
      profileDatabase() as never
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
        postMessage: vi.fn<() => void>(),
      },
    } as never);
    vscode.executeCommand.mockClear();

    receive?.({ expanded: true, type: "navigatorExpanded" });
    receive?.({ expanded: false, type: "navigatorExpanded" });

    await vi.waitFor(() =>
      expect(vscode.executeCommand.mock.calls).toStrictEqual([
        ["setContext", "mischief.navigatorAllExpanded", true],
        ["setContext", "mischief.navigatorAllExpanded", false],
      ])
    );
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
        snapshot: () => ({ threads: [] }),
      } as never,
      { fsPath: process.cwd() } as never,
      {} as never,
      profileDatabase() as never
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
      {} as never,
      profileDatabase() as never
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
