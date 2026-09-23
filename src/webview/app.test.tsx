import { act } from "react";
// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isDefined } from "../present";
import { testValue } from "../test-value";
import type { HostToWebviewMessage } from "./protocol";

const postMessage = vi.fn<(message: unknown) => void>();
const writeText = vi.fn<(text: string) => Promise<void>>(async () => {
  await Promise.resolve();
});
vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }));
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});
testValue<{ IS_REACT_ACT_ENVIRONMENT?: boolean }>(
  globalThis
).IS_REACT_ACT_ENVIRONMENT = true;

const { App } = await import("./app");

const threadState = (id: string, drafts: string[]): HostToWebviewMessage => ({
  font: "Test Mono",
  projects: { projects: [], ungrouped: [] },
  threads: {
    selected: {
      commands: [],
      configOptions: [],
      drafts,
      id,
      items: [],
      name: id,
      status: "idle",
      steering: [],
      streaming: false,
    },
    threads: [],
    workspace: "/workspace",
  },
  type: "state",
});

const renderApp = async (): Promise<() => Promise<void>> => {
  await Promise.resolve();
  const container = document.querySelector("#root");
  if (!(container instanceof HTMLElement)) {
    throw new Error("Missing test root");
  }
  const root = createRoot(container);
  act(() => {
    root.render(<App />);
  });
  return async () => {
    await Promise.resolve();
    act(() => {
      root.unmount();
    });
  };
};

describe("React webview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessage.mockClear();
    writeText.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("continues text-based setup when Enter is pressed", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: { projects: [], ungrouped: [] },
            setup: {
              id: "addons",
              item: {
                id: "setup:addons",
                kind: "system",
                text: "Select recommended add-ons.",
              },
              options: [
                {
                  description: "Highly recommended",
                  id: "todo",
                  label: "Todo",
                },
                {
                  description: "Engineering workflows",
                  id: "matt",
                  label: "Matt Pocock Skills",
                },
              ],
            },
            threads: {
              threads: [],
              workspace: "/workspace",
            },
            type: "state",
          },
        })
      );
    });
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    const options = [
      ...document.querySelectorAll<HTMLInputElement>(
        ".setup-option input[type='checkbox']"
      ),
    ];
    if (!composer || !isDefined(options[0])) {
      throw new Error("Missing setup controls");
    }
    expect(options.map(({ checked }) => checked)).toStrictEqual([true, true]);
    act(() => {
      options[0]?.click();
    });

    act(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        })
      );
    });

    expect(document.querySelector("#transcript")?.textContent).toContain(
      "Matt Pocock Skills"
    );
    expect(composer.placeholder).toBe("Press Enter to continue");
    expect(postMessage).toHaveBeenCalledWith({
      selected: ["matt"],
      type: "setupContinue",
    });
    await unmount();
  });

  test("keeps the Project list visible while maximizing the current Thread", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [
                {
                  name: "project",
                  root: "/project",
                  workspaces: [
                    {
                      ahead: 0,
                      behind: 0,
                      changes: 0,
                      current: true,
                      linked: false,
                      name: "workspace",
                      path: "/workspace",
                    },
                    {
                      ahead: 0,
                      behind: 0,
                      changes: 0,
                      current: false,
                      linked: true,
                      name: "remote",
                      path: "/remote",
                    },
                  ],
                },
              ],
              ungrouped: [],
            },
            threads: { threads: [], workspace: "/workspace" },
            type: "state",
          },
        })
      );
    });
    const navigator = document.querySelector<HTMLElement>("#navigator");
    const thread = document.querySelector<HTMLElement>("#thread");
    const maximize =
      document.querySelector<HTMLButtonElement>("#maximize-thread");
    if (!navigator || !thread || !maximize) {
      throw new Error("Missing pane controls");
    }
    const maximizeIcon = maximize.innerHTML;

    act(() => {
      maximize.click();
    });
    expect({
      iconChanged: maximize.innerHTML !== maximizeIcon,
      maximized: maximize.getAttribute("aria-pressed"),
      navigatorHidden: navigator.classList.contains("collapsed"),
      projectExpanded: document
        .querySelector(".project-toggle")
        ?.getAttribute("aria-expanded"),
      projectNames: [...document.querySelectorAll(".group-row .name")].map(
        (name) => name.textContent
      ),
      resizer: document.querySelector(".resizer"),
      threadHidden: thread.classList.contains("collapsed"),
      workspaces: document.querySelectorAll(".workspace-node").length,
    }).toStrictEqual({
      iconChanged: true,
      maximized: "true",
      navigatorHidden: false,
      projectExpanded: "false",
      projectNames: ["project"],
      resizer: null,
      threadHidden: false,
      workspaces: 0,
    });

    act(() => {
      maximize.click();
    });
    expect({
      maximized: maximize.getAttribute("aria-pressed"),
      projectExpanded: document
        .querySelector(".project-toggle")
        ?.getAttribute("aria-expanded"),
      workspacesExpanded: [
        ...document.querySelectorAll(".workspace-toggle"),
      ].map((toggle) => toggle.getAttribute("aria-expanded")),
    }).toStrictEqual({
      maximized: "false",
      projectExpanded: "true",
      workspacesExpanded: ["true", "true"],
    });

    postMessage.mockClear();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { expanded: false, type: "setAllExpanded" },
        })
      );
    });
    expect({
      maximized: maximize.getAttribute("aria-pressed"),
      navigatorState: postMessage.mock.calls,
      projectExpanded: document
        .querySelector(".project-toggle")
        ?.getAttribute("aria-expanded"),
      workspaces: document.querySelectorAll(".workspace-node").length,
    }).toStrictEqual({
      maximized: "true",
      navigatorState: [[{ expanded: false, type: "navigatorExpanded" }]],
      projectExpanded: "false",
      workspaces: 0,
    });

    postMessage.mockClear();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { expanded: true, type: "setAllExpanded" },
        })
      );
    });
    expect({
      maximized: maximize.getAttribute("aria-pressed"),
      navigatorState: postMessage.mock.calls,
      projectExpanded: document
        .querySelector(".project-toggle")
        ?.getAttribute("aria-expanded"),
      workspacesExpanded: [
        ...document.querySelectorAll(".workspace-toggle"),
      ].map((toggle) => toggle.getAttribute("aria-expanded")),
    }).toStrictEqual({
      maximized: "false",
      navigatorState: [[{ expanded: true, type: "navigatorExpanded" }]],
      projectExpanded: "true",
      workspacesExpanded: ["true", "true"],
    });
    await unmount();
  });

  test("shows a button tooltip after a short hover delay", async () => {
    vi.useFakeTimers();
    const unmount = await renderApp();
    try {
      const maximize =
        document.querySelector<HTMLButtonElement>("#maximize-thread");
      if (!maximize) {
        throw new Error("Missing maximize button");
      }

      void act(() =>
        maximize.dispatchEvent(
          new MouseEvent("mouseover", {
            bubbles: true,
            clientX: 20,
            clientY: 20,
          })
        )
      );

      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      void act(() => vi.advanceTimersByTime(350));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        "Maximize Current Thread"
      );
      void act(() =>
        maximize.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
      );
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        maximize.focus();
      });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      void act(() => vi.advanceTimersByTime(350));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        "Maximize Current Thread"
      );
    } finally {
      await unmount();
      vi.useRealTimers();
    }
  });

  test("opens Settings and toggles Workspace window colors", async () => {
    const unmount = await renderApp();
    const dialog =
      document.querySelector<HTMLDialogElement>("#settings-dialog");
    const checkbox = dialog?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    );
    const close = dialog?.querySelector<HTMLButtonElement>(
      '[aria-label="Close Settings"]'
    );
    if (!dialog || !checkbox || !close) {
      throw new Error("Missing Settings controls");
    }
    Object.defineProperties(dialog, {
      close: {
        value: () => {
          dialog.removeAttribute("open");
        },
      },
      showModal: {
        value: () => {
          dialog.setAttribute("open", "");
        },
      },
    });
    const defaultChecked = checkbox.checked;

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            assignWorkspaceColors: false,
            type: "showSettings",
          } satisfies HostToWebviewMessage,
        })
      );
    });

    expect({
      checked: checkbox.checked,
      defaultChecked,
      description: dialog.querySelector(".settings-description")?.textContent,
      open: dialog.open,
      title: dialog.querySelector(".settings-name")?.textContent,
    }).toStrictEqual({
      checked: false,
      defaultChecked: true,
      description:
        "Automatically assigns colors from the active theme to Workspace windows that do not already define them.",
      open: true,
      title: "Assign Workspace window colors",
    });

    postMessage.mockClear();
    act(() => {
      checkbox.click();
    });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "setAssignWorkspaceColors",
      value: true,
    });

    act(() => {
      close.click();
    });
    expect(dialog.open).toBeFalsy();
    await unmount();
  });

  test("routes open GitHub issues from a Project", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [{ name: "project", root: "/project", workspaces: [] }],
              ungrouped: [],
            },
            threads: { threads: [] },
            type: "state",
          } satisfies HostToWebviewMessage,
        })
      );
    });
    const openIssues = document.querySelector<HTMLButtonElement>(
      '[aria-label="Open GitHub Issues"]'
    );
    const icon = openIssues?.querySelector("svg");
    if (!openIssues || !icon) {
      throw new Error("Missing Open GitHub Issues control");
    }
    postMessage.mockClear();

    act(() => {
      openIssues.click();
    });

    expect({
      circles: icon.querySelectorAll("circle").length,
      className: icon.getAttribute("class"),
      message: postMessage.mock.calls,
      paths: icon.querySelectorAll("path").length,
    }).toStrictEqual({
      circles: 2,
      className: "lucide project-action-icon",
      message: [[{ path: "/project", type: "openIssues" }]],
      paths: 2,
    });
    await unmount();
  });

  test("renders nested Navigator controls and attention", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [
                {
                  name: "project",
                  root: "/project",
                  workspaces: [
                    {
                      ahead: 1,
                      behind: 3,
                      branch: "feature/ui",
                      changes: 2,
                      color: "#0e1c14",
                      current: true,
                      linked: true,
                      name: "current",
                      path: "/current",
                    },
                    {
                      ahead: 0,
                      behind: 0,
                      branch: "main",
                      changes: 0,
                      current: false,
                      linked: true,
                      name: "remote",
                      path: "/remote",
                    },
                  ],
                },
              ],
              ungrouped: [],
            },
            threads: {
              selected: {
                commands: [],
                configOptions: [],
                drafts: [],
                id: "current-thread",
                items: [],
                name: "Current",
                status: "idle",
                steering: [],
                streaming: false,
              },
              threads: [
                {
                  id: "current-thread",
                  indicator: "waiting",
                  name: "Current",
                  needsAttention: true,
                  updatedAt: "2026-01-02T00:00:00Z",
                  workspace: "/current",
                },
                {
                  id: "error-thread",
                  indicator: "error",
                  name: "Error",
                  needsAttention: true,
                  updatedAt: "2026-01-01T00:00:00Z",
                  workspace: "/current",
                },
                {
                  id: "remote-thread",
                  indicator: "completed",
                  name: "Remote",
                  needsAttention: true,
                  updatedAt: "2026-01-03T00:00:00Z",
                  workspace: "/remote",
                },
              ],
              workspace: "/current",
            },
            type: "state",
          } satisfies HostToWebviewMessage,
        })
      );
    });

    expect(
      [...document.querySelectorAll(".workspace-node")].map((node) => ({
        branch: node.querySelector(".workspace-branch")?.textContent,
        current: node.classList.contains("current"),
        expanded: node
          .querySelector(".workspace-toggle")
          ?.getAttribute("aria-expanded"),
        headerSelected: node
          .querySelector(".workspace-row")
          ?.classList.contains("selected"),
        threads: [...node.querySelectorAll(".thread-row")].map((thread) => ({
          activity: thread.querySelector(".thread-activity")?.textContent,
          name: thread.querySelector(".name")?.textContent,
          selected: thread.classList.contains("selected"),
        })),
      }))
    ).toStrictEqual([
      {
        branch: "feature/ui",
        current: true,
        expanded: "true",
        headerSelected: false,
        threads: [
          {
            activity: testValue<unknown>(
              expect.stringMatching(/^(?:now|\d+(?:min|h|d))$/u)
            ),
            name: "Current",
            selected: true,
          },
          {
            activity: testValue<unknown>(
              expect.stringMatching(/^(?:now|\d+(?:min|h|d))$/u)
            ),
            name: "Error",
            selected: false,
          },
        ],
      },
      {
        branch: "main",
        current: false,
        expanded: "false",
        headerSelected: false,
        threads: [],
      },
    ]);
    expect({
      archiveIcons: document.querySelectorAll(
        '.workspace-node.current [aria-label="Remove Thread"] .thread-action-icon'
      ).length,
      attention: document.querySelectorAll(
        ".workspace-node.current .workspace-statuses .thread-status"
      ).length,
      branchIcons: document.querySelectorAll(".workspace-branch-icon").length,
      closeIcons: document.querySelectorAll(
        '[aria-label="Close Workspace"] .thread-action-icon'
      ).length,
      history: document.querySelectorAll(
        '.workspace-node.current [aria-label="Thread History"]'
      ).length,
      newThread: document.querySelectorAll(
        '.workspace-node.current [aria-label="New Thread"]'
      ).length,
      newThreadMatchesFooter:
        document.querySelector(
          '.workspace-node.current [aria-label="New Thread"] svg'
        )?.innerHTML ===
        document.querySelector("#footer-new-thread svg")?.innerHTML,
      newWorkspaceIcons: document.querySelectorAll(
        '[aria-label="New Workspace"] .thread-action-icon'
      ).length,
      openWorkspaceWindows: document.querySelectorAll(
        '.workspace-node:not(.current) [aria-label$=" Window"]'
      ).length,
      remoteHistory: document.querySelectorAll(
        '.workspace-node:not(.current) [aria-label="Thread History"]'
      ).length,
      remove: document.querySelectorAll(
        '.workspace-node.current [aria-label="Remove Thread"]'
      ).length,
      rename: document.querySelectorAll(
        '.workspace-node.current [aria-label="Rename Thread"]'
      ).length,
      untitledButtons: document.querySelectorAll("button:not([title])").length,
    }).toStrictEqual({
      archiveIcons: 2,
      attention: 2,
      branchIcons: 2,
      closeIcons: 2,
      history: 1,
      newThread: 1,
      newThreadMatchesFooter: true,
      newWorkspaceIcons: 1,
      openWorkspaceWindows: 1,
      remoteHistory: 0,
      remove: 2,
      rename: 2,
      untitledButtons: 0,
    });

    const projectTitle = document.querySelector<HTMLElement>(
      ".navigator-group > .group-row .name"
    );
    const projectToggle = document.querySelector<HTMLButtonElement>(
      ".navigator-group > .group-row .project-toggle"
    );
    if (!projectTitle || !projectToggle) {
      throw new Error("Missing Project toggle");
    }
    act(() => {
      projectTitle.click();
    });
    const projectCollapsed = {
      expanded: projectToggle.getAttribute("aria-expanded"),
      workspaces: document.querySelectorAll(".workspace-node").length,
    };
    act(() => {
      projectTitle.click();
    });
    expect({
      collapsed: projectCollapsed,
      expanded: {
        expanded: projectToggle.getAttribute("aria-expanded"),
        workspaces: document.querySelectorAll(".workspace-node").length,
      },
    }).toStrictEqual({
      collapsed: { expanded: "false", workspaces: 0 },
      expanded: { expanded: "true", workspaces: 2 },
    });

    const history = document.querySelector<HTMLButtonElement>(
      '.workspace-node.current [aria-label="Thread History"]'
    );
    if (!history) {
      throw new Error("Missing Thread History control");
    }
    postMessage.mockClear();
    act(() => {
      history.click();
    });
    const historyMessage = [...postMessage.mock.calls];

    const [, renameError] = document.querySelectorAll<HTMLButtonElement>(
      '.workspace-node.current [aria-label="Rename Thread"]'
    );
    if (!isDefined(renameError)) {
      throw new Error("Missing Thread rename control");
    }
    postMessage.mockClear();
    act(() => {
      renameError.click();
    });

    const [currentToggle, remoteToggle] =
      document.querySelectorAll<HTMLButtonElement>(".workspace-toggle");
    const currentWorkspaceTitle = document.querySelector<HTMLElement>(
      ".workspace-node.current .workspace-label"
    );
    if (
      !(
        isDefined(currentToggle) &&
        isDefined(remoteToggle) &&
        currentWorkspaceTitle
      )
    ) {
      throw new Error("Missing Workspace toggles");
    }
    act(() => {
      currentWorkspaceTitle.click();
    });
    const collapsed = {
      expanded: currentToggle.getAttribute("aria-expanded"),
      headerSelected: document
        .querySelector(".workspace-node.current .workspace-row")
        ?.classList.contains("selected"),
      selectedThread: document.querySelector(
        ".workspace-node.current .thread-row.selected"
      ),
    };
    act(() => {
      currentWorkspaceTitle.click();
    });
    const reexpanded = {
      expanded: currentToggle.getAttribute("aria-expanded"),
      headerSelected: document
        .querySelector(".workspace-node.current .workspace-row")
        ?.classList.contains("selected"),
      selectedThread: document.querySelector(
        ".workspace-node.current .thread-row.selected .name"
      )?.textContent,
    };
    act(() => {
      remoteToggle.click();
    });
    const toggleMessages = [...postMessage.mock.calls];
    const remoteThread = document.querySelector<HTMLButtonElement>(
      ".workspace-node:not(.current) .thread-row .row-open"
    );
    if (!remoteThread) {
      throw new Error("Missing remote Thread");
    }
    postMessage.mockClear();
    act(() => {
      remoteThread.click();
    });
    expect({
      collapsed,
      historyMessage,
      reexpanded,
      remoteMessage: postMessage.mock.calls,
      remoteRemove: document.querySelector(
        '.workspace-node:not(.current) [aria-label="Remove Thread"]'
      ),
      remoteRename: document.querySelector(
        '.workspace-node:not(.current) [aria-label="Rename Thread"]'
      ),
      toggleMessages,
    }).toStrictEqual({
      collapsed: {
        expanded: "false",
        headerSelected: true,
        selectedThread: null,
      },
      historyMessage: [[{ type: "threadHistory" }]],
      reexpanded: {
        expanded: "true",
        headerSelected: false,
        selectedThread: "Current",
      },
      remoteMessage: [[{ id: "remote-thread", type: "selectThread" }]],
      remoteRemove: null,
      remoteRename: null,
      toggleMessages: [
        [{ id: "error-thread", type: "renameThread" }],
        [{ expanded: true, type: "navigatorExpanded" }],
      ],
    });
    const remoteWorkspaceTitle = document.querySelector<HTMLElement>(
      ".workspace-node:not(.current) .workspace-label"
    );
    const openWorkspaceWindow = document.querySelector<HTMLButtonElement>(
      '.workspace-node:not(.current) [aria-label="Open remote Window"]'
    );
    if (!remoteWorkspaceTitle || !openWorkspaceWindow) {
      throw new Error("Missing remote Workspace controls");
    }
    postMessage.mockClear();
    act(() => {
      remoteWorkspaceTitle.click();
    });
    const remoteCollapsed = {
      expanded: remoteToggle.getAttribute("aria-expanded"),
      messages: [...postMessage.mock.calls],
    };
    postMessage.mockClear();
    act(() => {
      openWorkspaceWindow.click();
    });
    expect({
      collapsed: remoteCollapsed,
      opened: {
        expanded: remoteToggle.getAttribute("aria-expanded"),
        messages: postMessage.mock.calls,
      },
    }).toStrictEqual({
      collapsed: {
        expanded: "false",
        messages: [[{ expanded: false, type: "navigatorExpanded" }]],
      },
      opened: {
        expanded: "false",
        messages: [[{ path: "/remote", type: "openWorkspace" }]],
      },
    });
    await unmount();
  });

  test("renders an answered ask_user as a question and user reply", async () => {
    const unmount = await renderApp();
    const state = threadState("selected", []);
    if (state.type !== "state" || !state.threads.selected) {
      throw new Error("Missing selected Thread");
    }
    const question = "Which transcript style should we use?";
    const answer = "Plain conversation text";
    state.threads.selected.items = [
      {
        id: "ask-user",
        input: JSON.stringify({ question }),
        kind: "tool",
        output: `User answered: ${answer}`,
        status: "completed",
        title: "ask_user",
        toolKind: "other",
      },
    ];

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });

    const result = document.querySelector(".ask-user-result");
    expect({
      answer: result?.querySelector(".ask-user-answer")?.textContent,
      content: result?.querySelector(".ask-user-content")?.textContent,
      entries: [...document.querySelectorAll("#transcript > .entry")].map(
        ({ className }) => className
      ),
      icon: result?.querySelector(".entry-icon")?.getAttribute("aria-label"),
      question: result?.querySelector(".ask-user-question")?.textContent,
      title: result?.querySelector(".ask-user-title")?.textContent,
      toolBody: result?.querySelector(".tool-body"),
    }).toStrictEqual({
      answer,
      content: `${question}${answer}`,
      entries: ["entry ask-user-result"],
      icon: "Question",
      question,
      title: "Question",
      toolBody: null,
    });
    await unmount();
  });

  test("groups terminal and file operations into compact expandable rows", async () => {
    const unmount = await renderApp();
    const state = threadState("selected", []);
    if (state.type !== "state" || !state.threads.selected) {
      throw new Error("Missing selected Thread");
    }
    state.threads.selected.items = [
      {
        id: "command-1",
        kind: "tool",
        output: "Checks passed",
        status: "completed",
        title: "pnpm check --filter package-with-an-excessively-long-name",
        toolKind: "execute",
      },
      {
        id: "command-2",
        kind: "tool",
        status: "in_progress",
        title: "git status --short",
        toolKind: "execute",
      },
      { id: "assistant", kind: "assistant", text: "Next" },
      {
        id: "command-3",
        kind: "tool",
        output: "One test failed",
        status: "failed",
        title: "gh pr checks",
        toolKind: "execute",
      },
      {
        id: "command-4",
        kind: "tool",
        status: "completed",
        title: "rg -n TODO src",
        toolKind: "execute",
      },
      {
        id: "read",
        kind: "tool",
        locations: [
          {
            line: 12,
            path: "src/components/a-file-with-an-excessively-long-name.ts",
          },
        ],
        status: "pending",
        title: "read",
        toolKind: "read",
      },
      {
        diffs: [{ newText: "new", oldText: "old", path: "src/b.ts" }],
        id: "edit",
        kind: "tool",
        locations: [{ line: 20, path: "src/b.ts" }],
        status: "completed",
        title: "edit",
        toolKind: "edit",
      },
      {
        diffs: [{ newText: "created", path: "src/c.ts" }],
        id: "write",
        kind: "tool",
        locations: [{ path: "src/c.ts" }],
        status: "completed",
        title: "write",
        toolKind: "edit",
      },
      {
        id: "search-1",
        input:
          '{"query":"current VS Code extension APIs for grouping transcript tool calls"}',
        kind: "tool",
        status: "in_progress",
        title: "web_search",
        toolKind: "other",
      },
      {
        id: "fetch",
        input:
          '{"urls":"https://example.com/documentation/a-page-with-a-very-long-name"}',
        kind: "tool",
        status: "completed",
        title: "web_fetch",
        toolKind: "other",
      },
      {
        id: "search-2",
        input: '{"query":"previous tool grouping decisions"}',
        kind: "tool",
        status: "in_progress",
        title: "session_search",
        toolKind: "other",
      },
      {
        id: "other",
        kind: "tool",
        status: "completed",
        title: "todo",
        toolKind: "other",
      },
    ];

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });

    const terminalGroups = [
      ...document.querySelectorAll<HTMLElement>(".terminal-group"),
    ];
    const fileGroup = document.querySelector<HTMLElement>(
      ".file-operations-group"
    );
    if (
      !isDefined(terminalGroups[0]) ||
      !isDefined(terminalGroups[1]) ||
      !fileGroup
    ) {
      throw new Error("Missing operation groups");
    }
    expect({
      fileIcons: [
        ...fileGroup.querySelectorAll<HTMLElement>(
          ".tool-operation > summary > .entry-icon"
        ),
      ].map((icon) => icon.getAttribute("aria-label")),
      fileRows: [...fileGroup.querySelectorAll(".tool-operation summary")].map(
        (summary) => summary.textContent
      ),
      fileTargets: [
        ...fileGroup.querySelectorAll<HTMLElement>(".tool-operation-target"),
      ].map((target) => ({ text: target.textContent, title: target.title })),
      groupHeadings: [...document.querySelectorAll(".tool-group-heading")].map(
        (heading) => heading.textContent
      ),
      groupIcons: [
        ...document.querySelectorAll<HTMLElement>(
          ".tool-group-heading [role='img']"
        ),
      ].map((icon) => icon.getAttribute("aria-label")),
      operationStatuses: [
        ...document.querySelectorAll<HTMLElement>(".tool-operation-status"),
      ].map((status) => ({
        className: status.className,
        label: status.getAttribute("aria-label"),
      })),
      terminalIcons: terminalGroups.flatMap((group) =>
        [
          ...group.querySelectorAll<HTMLElement>(
            ".tool-operation > summary > .entry-icon"
          ),
        ].map((icon) => ({
          className: icon.className,
          label: icon.getAttribute("aria-label"),
        }))
      ),
      terminalRows: terminalGroups.map((group) =>
        [...group.querySelectorAll(".tool-operation summary")].map(
          (summary) => summary.textContent
        )
      ),
      terminalTargets: [
        ...document.querySelectorAll<HTMLElement>(
          ".terminal-group .tool-operation-target"
        ),
      ].map((target) => ({
        className: target.className,
        text: target.textContent,
        title: target.title,
      })),
      toolsIcons: [
        ...document.querySelectorAll<HTMLElement>(
          ".tools-group .tool-operation > summary > .entry-icon"
        ),
      ].map((icon) => icon.getAttribute("aria-label")),
      toolsRows: [
        ...document.querySelectorAll(".tools-group .tool-operation summary"),
      ].map((summary) => summary.textContent),
      ungroupedTools: document.querySelectorAll(".entry.tool:not(.tool-group)")
        .length,
      webIcons: [
        ...document.querySelectorAll<HTMLElement>(
          ".web-group .tool-operation > summary > .entry-icon"
        ),
      ].map((icon) => icon.getAttribute("aria-label")),
      webRows: [
        ...document.querySelectorAll(".web-group .tool-operation summary"),
      ].map((summary) => summary.textContent),
    }).toStrictEqual({
      fileIcons: ["Read", "Edit", "Write"],
      fileRows: [
        "Read · a-file-with-an-excessively-long-name.ts:12",
        "Edit · b.ts:20",
        "Write · c.ts",
      ],
      fileTargets: [
        {
          text: "a-file-with-an-excessively-long-name.ts:12",
          title: "src/components/a-file-with-an-excessively-long-name.ts:12",
        },
        { text: "b.ts:20", title: "src/b.ts:20" },
        { text: "c.ts", title: "src/c.ts" },
      ],
      groupHeadings: [
        "Terminal",
        "Terminal",
        "File operations",
        "Web",
        "Tools",
      ],
      groupIcons: ["Terminal", "Terminal", "File operations", "Web", "Tools"],
      operationStatuses: [
        {
          className: "tool-operation-status completed",
          label: "Completed",
        },
        {
          className: "tool-operation-status in_progress",
          label: "In progress",
        },
        { className: "tool-operation-status failed", label: "Failed" },
        {
          className: "tool-operation-status completed",
          label: "Completed",
        },
        { className: "tool-operation-status pending", label: "Pending" },
        {
          className: "tool-operation-status completed",
          label: "Completed",
        },
        {
          className: "tool-operation-status completed",
          label: "Completed",
        },
        {
          className: "tool-operation-status in_progress",
          label: "In progress",
        },
        {
          className: "tool-operation-status completed",
          label: "Completed",
        },
        {
          className: "tool-operation-status in_progress",
          label: "In progress",
        },
        {
          className: "tool-operation-status completed",
          label: "Completed",
        },
      ],
      terminalIcons: [
        {
          className: "entry-icon",
          label: "Package manager",
        },
        {
          className: "entry-icon",
          label: "Git command",
        },
        {
          className: "entry-icon",
          label: "GitHub CLI",
        },
        {
          className: "entry-icon",
          label: "Command",
        },
      ],
      terminalRows: [
        [
          "pnpm check --filter package-with-an-excessively-long-name",
          "git status --short",
        ],
        ["gh pr checks", "rg -n TODO src"],
      ],
      terminalTargets: [
        {
          className: "tool-operation-target terminal-command",
          text: "pnpm check --filter package-with-an-excessively-long-name",
          title: "pnpm check --filter package-with-an-excessively-long-name",
        },
        {
          className: "tool-operation-target terminal-command",
          text: "git status --short",
          title: "git status --short",
        },
        {
          className: "tool-operation-target terminal-command",
          text: "gh pr checks",
          title: "gh pr checks",
        },
        {
          className: "tool-operation-target terminal-command",
          text: "rg -n TODO src",
          title: "rg -n TODO src",
        },
      ],
      toolsIcons: ["Search", "Tool"],
      toolsRows: ["previous tool grouping decisions", "todo"],
      ungroupedTools: 0,
      webIcons: ["Search", "Fetch"],
      webRows: [
        "current VS Code extension APIs for grouping transcript tool calls",
        "https://example.com/documentation/a-page-with-a-very-long-name",
      ],
    });

    const [firstCommand, secondCommand] =
      terminalGroups[0].querySelectorAll<HTMLDetailsElement>(".tool-operation");
    if (!(isDefined(firstCommand) && isDefined(secondCommand))) {
      throw new Error("Missing Terminal operations");
    }
    act(() => firstCommand.querySelector("summary")?.click());
    expect({
      firstOpen: firstCommand.open,
      output: firstCommand.querySelector(".tool-body")?.textContent,
      secondOpen: secondCommand.open,
    }).toStrictEqual({
      firstOpen: true,
      output: "OutputChecks passed",
      secondOpen: false,
    });

    const openLocation = fileGroup.querySelector<HTMLButtonElement>(
      '[title="Open file"]'
    );
    const openDiff = fileGroup.querySelector<HTMLButtonElement>(
      '[title="Open diff"]'
    );
    if (!(openLocation && openDiff)) {
      throw new Error("Missing file actions");
    }
    postMessage.mockClear();
    act(() => {
      openLocation.click();
    });
    act(() => {
      openDiff.click();
    });
    expect(postMessage.mock.calls).toStrictEqual([
      [
        {
          line: 12,
          path: "src/components/a-file-with-an-excessively-long-name.ts",
          type: "openLocation",
        },
      ],
      [{ path: "src/b.ts", type: "openDiff" }],
    ]);
    await unmount();
  });

  test("opens linked transcript files in the host", async () => {
    const unmount = await renderApp();
    const state = threadState("selected", []);
    if (state.type !== "state" || !state.threads.selected) {
      throw new Error("Missing selected Thread");
    }
    state.threads.selected.items = [
      {
        html: '<p><a href="src/view.ts">src/view.ts</a></p>',
        id: "assistant",
        kind: "assistant",
      },
    ];
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });
    postMessage.mockClear();

    const link = document.querySelector<HTMLAnchorElement>("#transcript a");
    if (!link) {
      throw new Error("Missing transcript file link");
    }
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(click);
    });

    expect(click.defaultPrevented).toBeTruthy();
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      href: "src/view.ts",
      type: "openTranscriptLink",
    });
    await unmount();
  });

  test("applies streaming transcript items without replacing history or composer text", async () => {
    const unmount = await renderApp();
    const state: HostToWebviewMessage = {
      font: "Test Mono",
      projects: {
        projects: [],
        ungrouped: [
          {
            ahead: 0,
            behind: 0,
            changes: 0,
            current: true,
            linked: false,
            name: "workspace",
            path: "/workspace",
          },
        ],
      },
      threads: {
        selected: {
          commands: [],
          configOptions: [],
          drafts: [],
          id: "selected",
          items: [
            { id: "assistant", kind: "assistant", text: "First" },
            {
              id: "streamed",
              kind: "assistant",
              text: "Second partial",
            },
          ],
          name: "Selected Thread",
          status: "idle",
          steering: [],
          streaming: false,
        },
        threads: [],
        workspace: "/workspace",
      },
      type: "state",
    };
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });
    expect(
      postMessage.mock.calls.filter(
        ([message]) =>
          testValue<{ type?: string }>(message).type === "contextItems"
      )
    ).toHaveLength(1);
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    if (!composer) {
      throw new Error("Missing composer");
    }
    composer.value = "unfinished draft";
    const chat = document.querySelector<HTMLDivElement>("#chat");
    if (!chat) {
      throw new Error("Missing chat");
    }
    const scrollHeight = vi.fn<() => number>(() => 1000);
    const scrollTop = vi.fn<() => number>(() => 0);
    const clientHeight = vi.fn<() => number>(() => 100);
    Object.defineProperties(chat, {
      clientHeight: { configurable: true, get: clientHeight },
      scrollHeight: { configurable: true, get: scrollHeight },
      scrollTop: {
        configurable: true,
        get: scrollTop,
        set: vi.fn<(value: number) => void>(),
      },
    });
    chat.dispatchEvent(new Event("scroll", { bubbles: true }));
    scrollHeight.mockClear();
    scrollTop.mockClear();
    clientHeight.mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            item: {
              id: "streamed",
              kind: "assistant",
              text: "Second streamed update",
            },
            streaming: true,
            threadId: "selected",
            type: "transcript",
          } satisfies HostToWebviewMessage,
        })
      );
    });

    expect(
      [...document.querySelectorAll("#transcript .entry")].map(
        (entry) => entry.textContent
      )
    ).toStrictEqual(["First", "Second streamed update"]);
    expect(composer.value).toBe("unfinished draft");
    expect({
      clientHeight: clientHeight.mock.calls.length,
      scrollHeight: scrollHeight.mock.calls.length,
      scrollTop: scrollTop.mock.calls.length,
    }).toStrictEqual({ clientHeight: 0, scrollHeight: 0, scrollTop: 0 });
    await unmount();
  });

  test("copies and clears highlighted transcript text when selection ends", async () => {
    const unmount = await renderApp();
    const state = threadState("selected", []);
    if (state.type !== "state" || !state.threads.selected) {
      throw new Error("Missing selected Thread");
    }
    state.threads.selected.items = [
      { id: "assistant", kind: "assistant", text: "Copy this" },
    ];
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });
    const body = document.querySelector<HTMLElement>("#transcript .body");
    const selection = window.getSelection();
    if (!body || !selection) {
      throw new Error("Missing transcript selection");
    }
    const range = document.createRange();
    range.selectNodeContents(body);
    selection.removeAllRanges();
    selection.addRange(range);

    await act(async () => {
      body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      // Browser finalizes selection after mouseup handlers.
      selection.addRange(range);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledExactlyOnceWith("Copy this");
    expect(document.querySelector(".toast")?.textContent).toBe(
      "copied to clipboard"
    );
    void act(() => vi.advanceTimersByTime(1));
    expect(selection.toString()).toBe("");
    await unmount();
  });

  test("defers worst-case context matching outside the input event", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: { projects: [], ungrouped: [] },
            threads: {
              selected: {
                commands: [],
                configOptions: [],
                drafts: [],
                id: "selected",
                items: [],
                name: "Selected Thread",
                status: "idle",
                steering: [],
                streaming: false,
              },
              threads: [],
              workspace: "/workspace",
            },
            type: "state",
          } satisfies HostToWebviewMessage,
        })
      );
    });
    let reads = 0;
    const candidates = new Proxy(
      Array.from({ length: 5000 }, (_, index) => `file-${index}.ts`),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/u.test(property)) {
            reads += 1;
          }
          return testValue<unknown>(Reflect.get(target, property, receiver));
        },
      }
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { items: candidates, type: "contextItems" },
        })
      );
    });
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    const valueDescriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    );
    if (!composer || !valueDescriptor?.set) {
      throw new Error("Missing composer");
    }
    postMessage.mockClear();
    let synchronousReads = -1;
    act(() => {
      valueDescriptor.set?.call(composer, "@missing");
      composer.setSelectionRange(8, 8);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      synchronousReads = reads;
    });

    expect(synchronousReads).toBe(0);
    expect(postMessage).toHaveBeenCalledWith({ type: "contextItems" });
    expect({
      reads,
      suggestions: document.querySelectorAll("#context-suggestions button")
        .length,
    }).toStrictEqual({ reads: 5000, suggestions: 0 });
    await unmount();
  });

  test("keeps composer drafts with their Threads while switching", async () => {
    const unmount = await renderApp();

    void act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("original", []) })
      )
    );
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    if (!composer) {
      throw new Error("Missing composer");
    }
    composer.value = "Original draft";

    void act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: threadState("fork", ["Fork from here"]),
        })
      )
    );
    expect(composer.value).toBe("Fork from here");

    void act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("original", []) })
      )
    );
    expect(composer.value).toBe("Original draft");

    void act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("fork", []) })
      )
    );
    expect(composer.value).toBe("Fork from here");
    await unmount();
  });

  test("appends a tree-navigation draft without losing typed text", async () => {
    const unmount = await renderApp();
    void act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("selected", []) })
      )
    );
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    if (!composer) {
      throw new Error("Missing composer");
    }
    composer.value = "Unsent local draft";
    postMessage.mockClear();

    void act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: threadState("selected", ["Try this again"]),
        })
      )
    );

    expect(composer.value).toBe("Unsent local draft\n\nTry this again");
    expect(postMessage).toHaveBeenCalledWith({ type: "draftsConsumed" });
    await unmount();
  });

  test("autocompletes advertised slash commands and sends unknown slash text", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: { projects: [], ungrouped: [] },
            threads: {
              selected: {
                commands: [
                  {
                    description: "Review changes",
                    inputHint: "[branch]",
                    name: "review",
                  },
                  { description: "Resume work", name: "resume" },
                ],
                configOptions: [],
                drafts: [],
                id: "selected",
                items: [],
                name: "Selected Thread",
                status: "idle",
                steering: [],
                streaming: false,
              },
              threads: [],
              workspace: "/workspace",
            },
            type: "state",
          } satisfies HostToWebviewMessage,
        })
      );
    });
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    const valueDescriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    );
    if (!composer || !valueDescriptor?.set) {
      throw new Error("Missing composer");
    }
    const input = async (value: string): Promise<void> => {
      await Promise.resolve();
      act(() => {
        valueDescriptor.set?.call(composer, value);
        composer.setSelectionRange(value.length, value.length);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await input("/");
    expect(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          "#context-suggestions button"
        ),
      ].map((button) => ({ text: button.textContent, title: button.title }))
    ).toStrictEqual([
      { text: "/review [branch]Review changes", title: "Use command" },
      { text: "/resumeResume work", title: "Use command" },
    ]);

    const [, resume] = document.querySelectorAll<HTMLButtonElement>(
      "#context-suggestions button"
    );
    const scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>();
    if (!isDefined(resume)) {
      throw new Error("Missing second command suggestion");
    }
    resume.scrollIntoView = scrollIntoView;
    act(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    act(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      );
    });
    expect({
      scroll: scrollIntoView.mock.calls,
      value: composer.value,
    }).toStrictEqual({
      scroll: [[{ block: "nearest" }]],
      value: "/resume",
    });

    await input("/rev");
    const review = document.querySelector<HTMLButtonElement>(
      "#context-suggestions button"
    );
    if (!review) {
      throw new Error("Missing command suggestion");
    }
    act(() => {
      review.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(composer.value).toBe("/review ");

    postMessage.mockClear();
    await input("/new");
    act(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      );
    });
    expect(postMessage).toHaveBeenCalledWith({
      images: [],
      text: "/new",
      type: "prompt",
    });
    expect(postMessage).not.toHaveBeenCalledWith({ type: "newThread" });
    await unmount();
  });

  test("keeps an in-progress model choice open across streaming snapshots", async () => {
    const unmount = await renderApp();
    const model = {
      currentValue: "provider/one",
      id: "model",
      name: "Model",
      options: [
        { name: "provider/one", value: "provider/one" },
        { name: "provider/two", value: "provider/two" },
      ],
      type: "select" as const,
    };
    const state: HostToWebviewMessage = {
      font: "Test Mono",
      projects: { projects: [], ungrouped: [] },
      threads: {
        selected: {
          commands: [],
          configOptions: [model],
          drafts: [],
          id: "selected",
          items: [{ id: "assistant", kind: "assistant", text: "First" }],
          name: "Selected Thread",
          status: "running",
          steering: [],
          streaming: true,
        },
        threads: [],
        workspace: "/workspace",
      },
      type: "state",
    };
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Model"]'
    );
    if (!select) {
      throw new Error("Missing model select");
    }
    select.focus();
    select.value = "provider/two";

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            ...state,
            threads: {
              ...state.threads,
              selected: state.threads.selected
                ? {
                    ...state.threads.selected,
                    configOptions: [{ ...model, options: [...model.options] }],
                    drafts: [],
                    items: [
                      {
                        id: "assistant",
                        kind: "assistant",
                        text: "First streamed update",
                      },
                    ],
                    usage: { size: 100, used: 10 },
                  }
                : undefined,
            },
          } satisfies HostToWebviewMessage,
        })
      );
    });

    expect({
      active: document.activeElement,
      value: select.value,
    }).toStrictEqual({
      active: select,
      value: "provider/two",
    });
    await unmount();
  });

  test("renders snapshots and routes steering and plan actions", async () => {
    const unmount = await renderApp();

    const state: HostToWebviewMessage = {
      font: "Test Mono",
      projects: { projects: [], ungrouped: [] },
      threads: {
        selected: {
          commands: [],
          configOptions: [],
          drafts: [],
          id: "thread-1",
          items: [
            {
              id: "summary-1",
              kind: "branchSummary",
              text: "Preserve the adapter decision.",
            },
            {
              id: "plan-1",
              kind: "plan",
              planEntries: [
                { content: "Inspect the view", status: "completed" },
                { content: "Refactor the view", status: "in_progress" },
                { content: "Test the view", status: "pending" },
              ],
              text: "1. Refactor the view",
              title: "Plan",
            },
          ],
          name: "React refactor",
          status: "running",
          steering: [{ id: "steer-1", text: "Keep the controls small" }],
          streaming: true,
        },
        threads: [],
        workspace: "/workspace",
      },
      type: "state",
    };
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            operation: "branchSummary",
            threadId: "thread-1",
            type: "sessionOperation",
          },
        })
      );
    });

    expect({
      branchBody: document.querySelector(".branch-summary-content")
        ?.textContent,
      branchHeading: document.querySelector(".branch-summary-heading")
        ?.textContent,
      branchIcon: document
        .querySelector(".branch-summary-heading [role='img']")
        ?.getAttribute("aria-label"),
      branchOpen:
        document.querySelector<HTMLDetailsElement>(".branch-summary")?.open,
      completedIcon: document.querySelector<HTMLElement>(
        ".plan-task.completed .plan-task-icon"
      )?.title,
      font: document.documentElement.style.getPropertyValue(
        "--mischief-mono-font"
      ),
      plan: document.querySelector("#plan-body")?.textContent,
      planProcessing: document.querySelector(
        '.plan-task-indicator[aria-label="In progress"]'
      ),
      steering: document
        .querySelector("#steering")
        ?.textContent?.includes("Keep the controls small"),
      summaryOverlay: document.querySelector(".thread-operation-overlay")
        ?.textContent,
      threadContentInert: document
        .querySelector("#thread-content")
        ?.hasAttribute("inert"),
      title: document.querySelector("#thread-title")?.textContent,
    }).toStrictEqual({
      branchBody: "Preserve the adapter decision.",
      branchHeading: "Branch summary",
      branchIcon: "Branch summary",
      branchOpen: false,
      completedIcon: "Completed",
      font: "Test Mono",
      plan: "Inspect the viewRefactor the viewTest the view",
      planProcessing: testValue<unknown>(expect.any(HTMLElement)),
      steering: true,
      summaryOverlay: "Generating branch summary…",
      threadContentInert: true,
      title: "React refactor",
    });

    const sendSteering = document.querySelector<HTMLButtonElement>(
      '[aria-label="Send steering message immediately"]'
    );
    const clearPlan = document.querySelector<HTMLButtonElement>("#clear-plan");
    if (!sendSteering || !clearPlan) {
      throw new Error("Missing Thread controls");
    }
    act(() => {
      sendSteering.click();
    });
    act(() => {
      clearPlan.click();
    });

    expect(postMessage).toHaveBeenCalledWith({
      id: "steer-1",
      type: "sendSteering",
    });
    expect(postMessage).toHaveBeenCalledWith({ type: "clearPlan" });

    await unmount();
  });

  test("renders elicitation choices as radios and submits custom context with the selection", async () => {
    const unmount = await renderApp();
    const state: HostToWebviewMessage = {
      font: "Test Mono",
      projects: { projects: [], ungrouped: [] },
      threads: {
        selected: {
          commands: [],
          configOptions: [],
          drafts: [],
          id: "thread-1",
          interaction: {
            context: "Test prompt context.",
            fields: [
              {
                label: "Suggested answers",
                name: "choice",
                options: [
                  {
                    description:
                      "Games can trust the roster for the whole round.",
                    name: "Immutable once round starts",
                    value: "immutable",
                  },
                  {
                    description:
                      "Changes remain possible until scoring begins.",
                    name: "Editable until first score",
                    value: "editable",
                  },
                ],
                required: false,
                type: "select",
              },
              {
                description: "Add context for the selected suggestion.",
                label: "Custom response",
                name: "other",
                required: false,
                type: "text",
              },
            ],
            id: "ask-1",
            kind: "elicitation",
            message: "Can Team membership change after a round starts?",
          },
          items: [],
          name: "Elicitation",
          status: "waiting",
          steering: [],
          streaming: false,
        },
        threads: [],
        workspace: "/workspace",
      },
      type: "state",
    };
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });

    const choices = [
      ...document.querySelectorAll<HTMLInputElement>(
        '#interaction input[type="radio"]'
      ),
    ];
    const custom = document.querySelector<HTMLTextAreaElement>(
      '#interaction textarea[name="other"]'
    );
    const submit = document.querySelector<HTMLButtonElement>(
      '#interaction button[type="submit"]'
    );
    if (!custom || !submit || choices.length !== 2) {
      throw new Error("Missing elicitation controls");
    }

    expect({
      context: document.querySelector(".interaction-context")?.textContent,
      descriptions: [...document.querySelectorAll(".interaction-choice")].map(
        (choice) => choice.textContent
      ),
      icon: document.querySelector(".interaction-question .lucide"),
      question: document.querySelector(".interaction-question")?.textContent,
      tooltips: [
        ...document.querySelectorAll<HTMLButtonElement>("#interaction button"),
      ].map((button) => button.title),
    }).toStrictEqual({
      context: "Context:Test prompt context.",
      descriptions: [
        "Immutable once round startsGames can trust the roster for the whole round.",
        "Editable until first scoreChanges remain possible until scoring begins.",
      ],
      icon: testValue<unknown>(expect.any(SVGElement)),
      question: "Can Team membership change after a round starts?",
      tooltips: ["Submit", "Cancel"],
    });

    postMessage.mockClear();
    act(() => {
      choices[0]?.click();
      custom.value = "Allow admins to correct mistakes.";
      submit.click();
    });

    expect(postMessage).toHaveBeenCalledWith({
      id: "ask-1",
      response: {
        action: "accept",
        values: {
          choice: "immutable",
          other: "Allow admins to correct mistakes.",
        },
      },
      type: "respond",
    });
    await unmount();
  });
});
