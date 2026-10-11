import { act } from "react";
// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentId } from "../agents/update";
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

const threadState = (
  id: string,
  drafts: string[],
  agentId: AgentId | null = "magpi-acp"
): HostToWebviewMessage => ({
  font: "Test Mono",
  projects: { projects: [], ungrouped: [] },
  threads: {
    selected: {
      ...(agentId === null ? {} : { agentId }),
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

const workspaceSummary = (name: string, current = false) => ({
  ahead: 0,
  behind: 0,
  changes: 0,
  current,
  linked: false,
  name,
  path: `/${name}`,
});

const threadSummary = (id: string, name: string, workspace: string) => ({
  id,
  indicator: "idle" as const,
  name,
  needsAttention: false,
  updatedAt: "2025-01-01T00:00:00.000Z",
  workspace,
});

const toggleProjectsMenu = (): void => {
  const button = document.querySelector<HTMLButtonElement>(
    "#workspace-header-trigger"
  );
  if (!button) {
    throw new Error("Missing Workspace header trigger");
  }
  act(() => {
    button.click();
  });
};

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

  test.each([
    [null, "Choose an Agent to start a Thread"],
    ["magpi-acp", "MagPi"],
    ["claude-agent-acp", "Claude Agent"],
    ["codex-acp", "Codex"],
  ] as const)("names %s in the composer hint", async (agentId, name) => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: threadState("selected", [], agentId),
        })
      );
    });
    expect(
      document.querySelector<HTMLTextAreaElement>("#composer")?.placeholder
    ).toBe(
      name === "Choose an Agent to start a Thread"
        ? name
        : `Message ${name} — @ to include context, / for commands`
    );
    await unmount();
  });

  test("auto-grows and shrinks the composer as its text changes", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("selected", []) })
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
    Object.defineProperty(composer, "scrollHeight", {
      configurable: true,
      get: () => (composer.value ? 160 : 86),
    });
    act(() => {
      valueDescriptor.set?.call(composer, "A longer draft");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(composer.style.height).toBe("160px");

    act(() => {
      valueDescriptor.set?.call(composer, "");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(composer.style.height).toBe("86px");
    await unmount();
  });

  test("Workspace expansion still works without a Thread title-bar toggle", async () => {
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
    const toggle = document.querySelector<HTMLButtonElement>(
      ".workspace-node.current .workspace-toggle"
    );
    if (!toggle) {
      throw new Error("Missing Workspace toggle");
    }
    expect(document.querySelector("#maximize-thread")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { expanded: false, type: "setAllExpanded" },
        })
      );
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await unmount();
  });

  test("does not tint the Thread header with the Workspace window color", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [],
              ungrouped: [
                { ...workspaceSummary("workspace", true), color: "#123abc" },
              ],
            },
            threads: { threads: [], workspace: "/workspace" },
            type: "state",
          },
        })
      );
    });
    expect(
      document.querySelector<HTMLElement>("#thread-header")?.style
        .backgroundColor
    ).toBe("");
    await unmount();
  });

  test("puts the Agent on the left and makes the full title Rename", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("selected", []) })
      );
    });
    const header = document.querySelector("#thread-header");
    const rename = document.querySelector<HTMLButtonElement>("#rename-thread");
    const title = document.querySelector<HTMLElement>("#thread-title");
    const close = document.querySelector<HTMLButtonElement>("#close-thread");
    if (!header || !rename || !title || !close) {
      throw new Error("Missing Thread title actions");
    }
    expect({
      actions: [
        ...(header.querySelector(".thread-header-actions")?.children ?? []),
      ].map((child) => child.id),
      agent: [
        ...(header.querySelector(".thread-header-agent")?.children ?? []),
      ].map((child) => child.className),
      header: [...header.children].map((child) => child.className),
      titleClickable: rename.contains(title),
      titleContents: [...rename.children].map(
        (child) => child.id || child.getAttribute("class")
      ),
    }).toStrictEqual({
      actions: ["close-thread"],
      agent: ["thread-agent"],
      header: [
        "thread-header-agent",
        "thread-title-group",
        "thread-header-actions",
      ],
      titleClickable: true,
      titleContents: ["thread-title", "lucide thread-action-icon"],
    });
    postMessage.mockClear();
    act(() => {
      title.click();
      close.click();
    });
    expect(postMessage.mock.calls).toStrictEqual([
      [{ id: "selected", type: "renameThread" }],
      [{ id: "selected", type: "removeThread" }],
    ]);
    await unmount();
  });

  test("shows a button tooltip after a short hover delay", async () => {
    vi.useFakeTimers();
    const unmount = await renderApp();
    try {
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data: threadState("selected", []) })
        );
      });
      const close = document.querySelector<HTMLButtonElement>("#close-thread");
      if (!close) {
        throw new Error("Missing Close Thread button");
      }

      void act(() =>
        close.dispatchEvent(
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
        "Close Thread"
      );
      void act(() =>
        close.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }))
      );
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        close.focus();
      });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      void act(() => vi.advanceTimersByTime(350));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        "Close Thread"
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
    const defaultAgent =
      dialog?.querySelector<HTMLSelectElement>("#default-agent");
    const close = dialog?.querySelector<HTMLButtonElement>(
      '[aria-label="Close Settings"]'
    );
    if (!dialog || !checkbox || !defaultAgent || !close) {
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
            agents: [
              {
                id: "magpi-acp",
                installedVersion: "0.3.0",
                latestVersion: "0.3.0",
                name: "MagPi",
                state: "current",
              },
            ],
            assignWorkspaceColors: false,
            defaultAgent: "",
            type: "showSettings",
          } satisfies HostToWebviewMessage,
        })
      );
    });

    expect({
      agent: dialog.querySelector(".settings-agent")?.textContent,
      checked: checkbox.checked,
      defaultAgent: defaultAgent.value,
      defaultChecked,
      description: dialog.querySelector(".settings-description")?.textContent,
      open: dialog.open,
      title: dialog.querySelector(".settings-name")?.textContent,
    }).toStrictEqual({
      agent: "MagPiInstalled 0.3.0 · Latest 0.3.0 · Up to dateInstall managed",
      checked: false,
      defaultAgent: "",
      defaultChecked: true,
      description:
        "Automatically assigns colors from the active theme to Workspace windows that do not already define them.",
      open: true,
      title: "Assign Workspace window colors",
    });

    postMessage.mockClear();
    act(() => {
      defaultAgent.value = "magpi-acp";
      defaultAgent.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      id: "magpi-acp",
      type: "setDefaultAgent",
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

  test("routes approved Agent install and update controls to the host", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            agents: [
              {
                id: "claude-agent-acp",
                name: "Claude Agent",
                state: "missing",
              },
              {
                id: "codex-acp",
                installedVersion: "2.1.1",
                latestVersion: "2.2.1",
                managed: true,
                name: "Codex",
                state: "updateAvailable",
              },
            ],
            type: "agents",
          } satisfies HostToWebviewMessage,
        })
      );
    });
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      ".settings-agent button"
    );
    expect(
      [...buttons].map((button) => ({
        icon: button.querySelector("svg path")?.getAttribute("d"),
        label: button.getAttribute("aria-label"),
        style: button.className,
      }))
    ).toStrictEqual([
      {
        icon: "M12 3v12",
        label: "Install Claude Agent managed",
        style: "action primary",
      },
      { icon: undefined, label: "Check Codex for updates", style: "action" },
    ]);
    postMessage.mockClear();
    act(() => {
      buttons[0]?.click();
      buttons[1]?.click();
    });
    expect(postMessage.mock.calls).toStrictEqual([
      [{ id: "claude-agent-acp", type: "installAgent" }],
      [{ id: "codex-acp", type: "checkAgent" }],
    ]);
    await unmount();
  });

  test("routes Project actions from the current Workspace row", async () => {
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
              ],
              ungrouped: [],
            },
            threads: { threads: [] },
            type: "state",
          } satisfies HostToWebviewMessage,
        })
      );
    });
    const trigger = document.querySelector<HTMLButtonElement>(
      '.workspace-node.current [aria-label="Workspace actions"]'
    );
    if (!trigger) {
      throw new Error("Missing Workspace actions control");
    }
    act(() => {
      trigger.click();
    });
    const openIssues = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Start work on issue"));
    const icon = openIssues?.querySelector("svg");
    if (!openIssues || !icon) {
      throw new Error("Missing Start work on issue control");
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
      className: "lucide",
      message: [[{ path: "/project", type: "openIssues" }]],
      paths: 2,
    });
    act(() => {
      trigger.click();
    });
    const newWorkspace = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Add Workspace"));
    if (!newWorkspace) {
      throw new Error("Missing New Workspace control");
    }
    postMessage.mockClear();
    act(() => {
      newWorkspace.click();
    });
    expect(postMessage.mock.calls).toStrictEqual([
      [{ path: "/project", type: "newWorkspace" }],
    ]);
    const row = document.querySelector<HTMLElement>(
      ".workspace-node.current .workspace-row"
    );
    if (!row) {
      throw new Error("Missing current Workspace row");
    }
    act(() => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 60,
          clientY: 80,
        })
      );
    });
    expect(
      [...document.querySelectorAll('.workspace-menu [role="menuitem"]')].map(
        (button) => button.textContent?.trim()
      )
    ).toStrictEqual([
      "Start work on issue",
      "Add Workspace",
      "Thread History",
      "Close Workspace",
    ]);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    expect(document.activeElement?.textContent?.trim()).toBe("Add Workspace");
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    act(() => {
      trigger.click();
    });
    const close = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Close Workspace"));
    postMessage.mockClear();
    act(() => {
      close?.click();
    });
    expect({
      message: postMessage.mock.calls,
      spinner: row
        .querySelector(".workspace-close-spinner")
        ?.getAttribute("aria-label"),
    }).toStrictEqual({
      message: [[{ path: "/workspace", type: "closeWorkspace" }]],
      spinner: "Closing Workspace",
    });
    await unmount();
  });

  test("shows only the exact current Workspace outside the folder flyout", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [
                {
                  name: "current-project",
                  root: "/current-project",
                  workspaces: [
                    workspaceSummary("current", true),
                    workspaceSummary("current-linked"),
                  ],
                },
                {
                  name: "other-project",
                  root: "/other-project",
                  workspaces: [workspaceSummary("other")],
                },
              ],
              ungrouped: [workspaceSummary("loose")],
            },
            threads: { threads: [] },
            type: "state",
          },
        })
      );
    });
    expect(document.querySelector("#workspace-title")?.textContent).toBe(
      "Workspaces"
    );
    expect(
      [...document.querySelectorAll(".workspace-open .name")].map(
        (name) => name.textContent
      )
    ).toStrictEqual(["current"]);
    expect(
      document.querySelectorAll("#navigator-list > .project-divider")
    ).toHaveLength(0);
    toggleProjectsMenu();
    expect(
      [
        ...document.querySelectorAll(
          "#navigator-flyout-list .workspace-open .name"
        ),
      ].map((name) => name.textContent)
    ).toStrictEqual(["current", "current-linked", "other", "loose"]);
    await unmount();
  });

  test("groups Workspaces by Project with dividers and no headings", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [
                {
                  name: "z-project",
                  root: "/z-project",
                  workspaces: [
                    workspaceSummary("Zulu", true),
                    workspaceSummary("Alpha"),
                  ],
                },
                {
                  name: "a-project",
                  root: "/a-project",
                  workspaces: [workspaceSummary("Bravo")],
                },
              ],
              ungrouped: [workspaceSummary("Charlie")],
            },
            threads: { threads: [] },
            type: "state",
          },
        })
      );
    });
    toggleProjectsMenu();
    expect({
      expandableRows: document.querySelectorAll(".workspace-toggle").length,
      main: document.querySelector("#navigator-list .workspace-open .name")
        ?.textContent,
      projectHeadings: document.querySelectorAll(".navigator-group").length,
      rows: [
        ...(document.querySelector("#navigator-flyout-list")?.children ?? []),
      ].map((child) =>
        child.matches(".project-divider")
          ? "divider"
          : child.querySelector(".workspace-open .name")?.textContent
      ),
    }).toStrictEqual({
      expandableRows: 1,
      main: "Zulu",
      projectHeadings: 0,
      rows: ["Bravo", "divider", "Alpha", "Zulu", "divider", "Charlie"],
    });
    await unmount();
  });

  test("does not show other Workspaces or offer their actions in the main list", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [],
              ungrouped: [workspaceSummary("Alpha"), workspaceSummary("Bravo")],
            },
            threads: { threads: [] },
            type: "state",
          },
        })
      );
    });
    expect(
      document.querySelectorAll("#navigator-list .workspace-node")
    ).toHaveLength(0);
    toggleProjectsMenu();
    const alpha = document.querySelector<HTMLElement>(
      "#navigator-flyout-list .workspace-row"
    );
    if (!alpha) {
      throw new Error("Missing Workspace row");
    }
    const rightClick = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      alpha.dispatchEvent(rightClick);
    });
    expect({
      menus: document.querySelectorAll(
        "#navigator-flyout-list .workspace-node .workspace-menu"
      ).length,
      prevented: rightClick.defaultPrevented,
      triggers: document.querySelectorAll(
        '.workspace-node [aria-label="Workspace actions"]'
      ).length,
    }).toStrictEqual({ menus: 0, prevented: false, triggers: 0 });
    await unmount();
  });

  test("combines Workspace actions and the list under the header", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [],
              ungrouped: [workspaceSummary("Alpha", true)],
            },
            threads: { threads: [] },
            type: "state",
          },
        })
      );
    });
    const workspaceTrigger = document.querySelector<HTMLButtonElement>(
      '.workspace-row [aria-label="Workspace actions"]'
    );
    if (!workspaceTrigger) {
      throw new Error("Missing Workspace action trigger");
    }
    postMessage.mockClear();
    act(() => {
      workspaceTrigger.click();
    });
    toggleProjectsMenu();
    expect({
      header: document.querySelector("#workspace-title")?.textContent,
      menu:
        document.querySelector(
          '.projects-menu[aria-label="Workspaces and Threads"]'
        ) !== null,
      menus: document.querySelectorAll(".workspace-menu").length,
    }).toStrictEqual({
      header: "Workspaces",
      menu: true,
      menus: 1,
    });
    toggleProjectsMenu();
    expect(document.querySelector(".projects-menu")).toBeNull();
    const actions = [
      ["Add Workspace…", "addWorkspace"],
      ["Refresh", "refresh"],
    ] as const;
    for (const [label, type] of actions) {
      toggleProjectsMenu();
      const action = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".projects-menu-actions button"
        ),
      ].find((item) => item.textContent?.trim() === label);
      if (!action) {
        throw new Error(`Missing ${label} action`);
      }
      act(() => {
        action.click();
      });
      expect(document.querySelector(".projects-menu")).toBeNull();
      expect(postMessage).toHaveBeenLastCalledWith({ type });
    }
    toggleProjectsMenu();
    act(() => {
      document.body.click();
    });
    expect(document.querySelector(".projects-menu")).toBeNull();
    await unmount();
  });

  test("browses Projects and focuses a selected Project or Thread", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent<HostToWebviewMessage>("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [
                {
                  name: "Alpha Project",
                  root: "/alpha",
                  workspaces: [
                    workspaceSummary("alpha", true),
                    workspaceSummary("linked"),
                  ],
                },
                {
                  name: "Beta Project",
                  root: "/beta",
                  workspaces: [workspaceSummary("beta")],
                },
              ],
              ungrouped: [workspaceSummary("loose")],
            },
            threads: {
              threads: [
                threadSummary("alpha-thread", "Alpha Thread", "/alpha"),
                threadSummary("linked-thread", "Linked Thread", "/linked"),
                threadSummary("beta-thread", "Beta Thread", "/beta"),
                threadSummary("loose-thread", "Loose Thread", "/loose"),
              ],
            },
            type: "state",
          },
        })
      );
    });
    toggleProjectsMenu();
    expect({
      dividers: document.querySelectorAll(
        "#navigator-flyout-list > .project-divider"
      ).length,
      flyout: [
        ...document.querySelectorAll(
          "#navigator-flyout-list .workspace-open .name"
        ),
      ].map((name) => name.textContent),
      main: [
        ...document.querySelectorAll("#navigator-list .workspace-open .name"),
      ].map((name) => name.textContent),
      menu: document
        .querySelector(".projects-menu")
        ?.getAttribute("aria-label"),
      menuSections: [
        ...(document.querySelector(".projects-menu")?.children ?? []),
      ].map((child) => child.className || child.tagName),
      remoteMenus: document.querySelectorAll(
        '#navigator-flyout-list .workspace-node:not(.current) [aria-label="Workspace actions"]'
      ).length,
      sameListControl:
        document.querySelector("#navigator-list")?.className ===
        document.querySelector("#navigator-flyout-list")?.className,
      statusIcons: document.querySelectorAll(
        "#navigator-flyout-list .thread-row .thread-status"
      ).length,
      threadRows: [
        ...document.querySelectorAll(
          "#navigator-flyout-list .thread-row .name"
        ),
      ].map((name) => name.textContent),
      toggles: document.querySelectorAll(
        "#navigator-flyout-list .workspace-toggle"
      ).length,
    }).toStrictEqual({
      dividers: 2,
      flyout: ["alpha", "linked", "beta", "loose"],
      main: ["alpha"],
      menu: "Workspaces and Threads",
      menuSections: ["projects-menu-actions", "HR", "content workspace-list"],
      remoteMenus: 0,
      sameListControl: true,
      statusIcons: 4,
      threadRows: [
        "Alpha Thread",
        "Linked Thread",
        "Beta Thread",
        "Loose Thread",
      ],
      toggles: 0,
    });
    postMessage.mockClear();
    const thread = document.querySelector<HTMLButtonElement>(
      '#navigator-flyout-list .thread-row .row-open[title="Open Thread"]'
    );
    if (!thread) {
      throw new Error("Missing Project Thread item");
    }
    act(() => {
      thread.click();
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: "alpha-thread",
      type: "selectThread",
    });
    toggleProjectsMenu();
    const remoteThread = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "#navigator-flyout-list .thread-row .row-open"
      ),
    ].find((item) => item.textContent?.includes("Beta Thread"));
    if (!remoteThread) {
      throw new Error("Missing remote Thread item");
    }
    act(() => {
      remoteThread.click();
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      id: "beta-thread",
      type: "selectThread",
    });
    toggleProjectsMenu();
    const workspace = document.querySelector<HTMLButtonElement>(
      '#navigator-flyout-list .workspace-node:not(.current) .workspace-open[aria-label="Open beta in Mischief"]'
    );
    if (!workspace) {
      throw new Error("Missing Workspace item");
    }
    act(() => {
      workspace.click();
    });
    expect(postMessage).toHaveBeenLastCalledWith({
      path: "/beta",
      type: "focusWorkspace",
    });
    toggleProjectsMenu();
    const actions = document.querySelector<HTMLButtonElement>(
      '#navigator-flyout-list .workspace-node.current [aria-label="Workspace actions"]'
    );
    if (!actions) {
      throw new Error("Missing Workspace actions in the flyout");
    }
    act(() => {
      actions.click();
    });
    const menu = document.querySelector<HTMLElement>(
      '.projects-menu .workspace-menu[aria-label="Workspace actions"]'
    );
    if (!menu) {
      throw new Error("Missing Workspace actions menu");
    }
    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    expect(document.activeElement?.textContent).toContain("Add Workspace");
    await unmount();
  });

  test("opens the combined menu at the header click and dismisses it", async () => {
    const unmount = await renderApp();
    const trigger = document.querySelector<HTMLButtonElement>(
      "#workspace-header-trigger"
    );
    if (!trigger) {
      throw new Error("Missing Workspace header trigger");
    }
    expect(document.querySelectorAll("#workspace-header button")).toHaveLength(
      1
    );
    act(() => {
      trigger.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: 120,
          clientY: 20,
          detail: 1,
        })
      );
    });
    const menu = document.querySelector<HTMLElement>(".projects-menu");
    expect({
      expanded: trigger.getAttribute("aria-expanded"),
      left: menu?.style.left,
      top: menu?.style.top,
    }).toStrictEqual({ expanded: "true", left: "120px", top: "20px" });
    act(() => {
      trigger.click();
    });
    expect(document.querySelector(".projects-menu")).toBeNull();
    const dots = document.querySelector<SVGSVGElement>(
      "#workspace-header-trigger .workspace-header-more"
    );
    if (!dots) {
      throw new Error("Missing Workspace header dots");
    }
    act(() => {
      dots.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: 180,
          clientY: 20,
          detail: 1,
        })
      );
    });
    expect({
      focused:
        document.activeElement === document.querySelector(".projects-menu"),
      left: document.querySelector<HTMLElement>(".projects-menu")?.style.left,
    }).toStrictEqual({ focused: true, left: "180px" });
    act(() => {
      document.body.click();
    });
    expect(document.querySelector(".projects-menu")).toBeNull();
    await unmount();
  });

  test("opens Workspace actions without preselecting a menu item", async () => {
    const unmount = await renderApp();
    toggleProjectsMenu();
    const menu = document.querySelector<HTMLElement>(".projects-menu");
    if (!menu) {
      throw new Error("Missing Workspace menu");
    }
    expect(document.activeElement).toBe(menu);
    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    expect(document.activeElement?.textContent).toContain("Add Workspace");
    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })
      );
    });
    expect(document.activeElement?.textContent).toContain("Refresh");
    await unmount();
  });

  test("shows current Workspace Threads without decorations on Workspace rows", async () => {
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
        decorations: node.querySelectorAll(
          ".workspace-color, .workspace-statuses, .workspace-thread-count"
        ).length,
        expandable: Boolean(node.querySelector(".workspace-toggle")),
        expanded: node
          .querySelector(".workspace-toggle")
          ?.getAttribute("aria-expanded"),
        selected: node
          .querySelector(".workspace-row")
          ?.classList.contains("selected"),
        threads: [...node.querySelectorAll(".thread-row")].map((thread) => ({
          activity: thread.querySelector(".thread-activity")?.textContent,
          name: thread.querySelector(".name")?.textContent,
          selected: thread.classList.contains("selected"),
          status: thread
            .querySelector(".thread-status")
            ?.getAttribute("aria-label"),
        })),
      }))
    ).toStrictEqual([
      {
        branch: "feature/ui",
        current: true,
        decorations: 0,
        expandable: true,
        expanded: "true",
        selected: false,
        threads: [
          {
            activity: testValue<unknown>(
              expect.stringMatching(/^(?:now|\d+(?:min|h|d))$/u)
            ),
            name: "Current",
            selected: true,
            status: "Waiting for user input",
          },
          {
            activity: testValue<unknown>(
              expect.stringMatching(/^(?:now|\d+(?:min|h|d))$/u)
            ),
            name: "Error",
            selected: false,
            status: "Agent error — needs attention",
          },
        ],
      },
    ]);
    expect({
      expandableRows: document.querySelectorAll(".workspace-toggle").length,
      menuTriggers: document.querySelectorAll(
        '.workspace-node.current [aria-label="Workspace actions"]'
      ).length,
      newThread: document.querySelectorAll(
        '.workspace-node.current [aria-label="New Thread"]'
      ).length,
      openWorkspaceRow: document.querySelectorAll(
        '.workspace-node:not(.current) .workspace-open[aria-label="Open remote Window"]'
      ).length,
      projectRows: document.querySelectorAll(".group-row").length,
      remoteMenuTriggers: document.querySelectorAll(
        '.workspace-node:not(.current) [aria-label="Workspace actions"]'
      ).length,
      remoteThreads: document.querySelectorAll(
        ".workspace-node:not(.current) .thread-row"
      ).length,
      threadActions: document.querySelectorAll(
        '.workspace-node.current .thread-row [aria-label="Thread actions"]'
      ).length,
      untitledButtons: document.querySelectorAll("button:not([title])").length,
    }).toStrictEqual({
      expandableRows: 1,
      menuTriggers: 1,
      newThread: 1,
      openWorkspaceRow: 0,
      projectRows: 0,
      remoteMenuTriggers: 0,
      remoteThreads: 0,
      threadActions: 2,
      untitledButtons: 0,
    });

    const trigger = document.querySelector<HTMLButtonElement>(
      '.workspace-node.current [aria-label="Workspace actions"]'
    );
    const [firstThread, errorThread] = document.querySelectorAll<HTMLElement>(
      ".workspace-node.current .thread-row"
    );
    const currentToggle = document.querySelector<HTMLButtonElement>(
      ".workspace-node.current .workspace-toggle"
    );
    const currentWorkspaceRow = document.querySelector<HTMLButtonElement>(
      ".workspace-node.current .workspace-open"
    );
    if (
      !trigger ||
      !isDefined(firstThread) ||
      !isDefined(errorThread) ||
      !currentToggle ||
      !currentWorkspaceRow
    ) {
      throw new Error("Missing Workspace controls");
    }
    postMessage.mockClear();
    act(() => {
      trigger.click();
    });
    const history = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Thread History"));
    if (!history) {
      throw new Error("Missing Thread History menu item");
    }
    act(() => {
      history.click();
    });
    const historyMessages = postMessage.mock.calls;

    const contextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 100,
    });
    act(() => {
      errorThread.dispatchEvent(contextMenu);
    });
    const threadOptions = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '.workspace-menu[aria-label="Thread actions"] [role="menuitem"]'
      ),
    ];
    postMessage.mockClear();
    act(() => {
      threadOptions[0]?.click();
    });
    const renameMessages = [...postMessage.mock.calls];
    const more = firstThread.querySelector<HTMLButtonElement>(
      '[aria-label="Thread actions"]'
    );
    if (!more) {
      throw new Error("Missing Thread actions button");
    }
    act(() => {
      more.click();
    });
    const closeThread = document.querySelector<HTMLButtonElement>(
      '.workspace-menu[aria-label="Thread actions"] [role="menuitem"]:last-child'
    );
    postMessage.mockClear();
    act(() => {
      closeThread?.click();
    });
    const closeMessages = [...postMessage.mock.calls];
    expect({
      closeMessages,
      contextPrevented: contextMenu.defaultPrevented,
      historyMessages,
      renameMessages,
      threadOptions: threadOptions.map((option) => option.textContent?.trim()),
    }).toStrictEqual({
      closeMessages: [[{ id: "current-thread", type: "removeThread" }]],
      contextPrevented: true,
      historyMessages: [[{ type: "threadHistory" }]],
      renameMessages: [[{ id: "error-thread", type: "renameThread" }]],
      threadOptions: ["Rename Thread", "Close Thread"],
    });

    postMessage.mockClear();
    act(() => {
      currentWorkspaceRow.click();
    });
    const collapsed = {
      expanded: currentToggle.getAttribute("aria-expanded"),
      messages: postMessage.mock.calls,
      selected: document
        .querySelector(".workspace-node.current .workspace-row")
        ?.classList.contains("selected"),
      selectedThread: document.querySelector(
        ".workspace-node.current .thread-row.selected"
      ),
    };
    postMessage.mockClear();
    act(() => {
      currentToggle.click();
    });
    const reexpanded = {
      expanded: currentToggle.getAttribute("aria-expanded"),
      messages: postMessage.mock.calls,
      selectedThread: document.querySelector(
        ".workspace-node.current .thread-row.selected .name"
      )?.textContent,
    };
    expect({ collapsed, reexpanded }).toStrictEqual({
      collapsed: {
        expanded: "false",
        messages: [],
        selected: true,
        selectedThread: null,
      },
      reexpanded: {
        expanded: "true",
        messages: [],
        selectedThread: "Current",
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
        html: '<p><a href="src/view.ts#L3"><code>src/view.ts:3</code></a></p>',
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
      href: "src/view.ts#L3",
      type: "openTranscriptLink",
    });
    await unmount();
  });

  test("renders recent history first and loads older entries on scroll", async () => {
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
                id: "long",
                items: Array.from({ length: 210 }, (_, index) => ({
                  id: `item-${index}`,
                  kind: "assistant" as const,
                  text: `Message ${index}`,
                })),
                name: "Long",
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
    expect(document.querySelectorAll("#transcript .entry")).toHaveLength(100);
    expect(document.querySelector("#transcript")?.textContent).not.toContain(
      "Message 0"
    );
    const chat = document.querySelector<HTMLDivElement>("#chat");
    if (!chat) {
      throw new Error("Missing chat");
    }
    act(() => {
      chat.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(document.querySelectorAll("#transcript .entry")).toHaveLength(200);
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

  test("sticks through streamed thinking and tool-call layout growth", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver"
    );
    let resizeCallback: ResizeObserverCallback | undefined;
    let observed: Element | undefined;
    const observer: ResizeObserver = {
      disconnect: () => {},
      observe: () => {},
      unobserve: () => {},
    };
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class implements ResizeObserver {
        private target: Element | undefined;
        // oxlint-disable-next-line promise/prefer-await-to-callbacks -- ResizeObserver is callback-based
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe(target: Element): void {
          this.target = target;
          observed = this.target;
        }
        unobserve(target: Element): void {
          this.target = target;
        }
        disconnect(): void {
          this.target = undefined;
        }
      },
    });
    let unmount: (() => Promise<void>) | undefined;
    try {
      unmount = await renderApp();
      const threadId = "selected";
      const initial = threadState(threadId, []);
      if (initial.type !== "state" || !initial.threads.selected) {
        throw new Error("Missing selected Thread");
      }
      initial.threads.selected.status = "running";
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data: initial }));
      });
      const chat = document.querySelector<HTMLDivElement>("#chat");
      if (!chat || !resizeCallback) {
        throw new Error("Missing scroll observer");
      }
      let scrollHeight = 1000;
      let scrollTop = 900;
      const setScrollTop = vi.fn<(value: number) => void>((value) => {
        scrollTop = value;
      });
      Object.defineProperties(chat, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, get: () => scrollHeight },
        scrollTop: {
          configurable: true,
          get: () => scrollTop,
          set: setScrollTop,
        },
      });
      chat.dispatchEvent(new Event("scroll"));
      if (observed?.id !== "chat-content") {
        throw new Error("Resize observer is not watching transcript content");
      }
      const send = (
        item: Extract<HostToWebviewMessage, { type: "transcript" }>["item"]
      ): void => {
        act(() => {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: {
                item,
                streaming: true,
                threadId,
                type: "transcript",
              } satisfies HostToWebviewMessage,
            })
          );
        });
      };
      send({
        id: "thought",
        kind: "thought",
        text: "Thinking through the change",
      });
      expect(document.querySelector(".thinking-group")?.textContent).toContain(
        "Thinking through the change"
      );
      scrollHeight += 250;
      act(() => resizeCallback?.([], observer));
      expect(setScrollTop).toHaveBeenLastCalledWith(scrollHeight);

      send({ id: "tool", kind: "tool", title: "Read source" });
      expect(document.querySelector("#transcript")?.textContent).toContain(
        "Read source"
      );
      scrollHeight += 120;
      act(() => resizeCallback?.([], observer));
      expect(setScrollTop).toHaveBeenLastCalledWith(scrollHeight);

      scrollTop = 300;
      chat.dispatchEvent(new Event("scroll"));
      setScrollTop.mockClear();
      scrollHeight += 80;
      act(() => resizeCallback?.([], observer));
      expect(setScrollTop).not.toHaveBeenCalled();
    } finally {
      await unmount?.();
      if (descriptor) {
        Object.defineProperty(globalThis, "ResizeObserver", descriptor);
      } else {
        Reflect.deleteProperty(globalThis, "ResizeObserver");
      }
    }
  });

  test("keeps the working-indicator slot while its spinner toggles", async () => {
    const unmount = await renderApp();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("selected", []) })
      );
    });
    const spinner = document.querySelector<HTMLDivElement>("#processing");
    if (!spinner) {
      throw new Error("Missing reserved working-indicator slot");
    }
    expect(spinner.hidden).toBeTruthy();

    const running = threadState("selected", []);
    if (running.type !== "state" || !running.threads.selected) {
      throw new Error("Missing selected Thread");
    }
    running.threads.selected.status = "running";
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: running }));
    });
    expect(document.querySelector("#processing")).toBe(spinner);
    expect(spinner.hidden).toBeFalsy();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("selected", []) })
      );
    });
    expect(document.querySelector("#processing")).toBe(spinner);
    expect(spinner.hidden).toBeTruthy();
    await unmount();
  });

  test("history follows streamed messages and a jump stays put during later updates", async () => {
    const unmount = await renderApp();
    const state = threadState("selected", []);
    if (state.type !== "state" || !state.threads.selected) {
      throw new Error("Missing selected Thread");
    }
    state.threads.selected.items = [
      { id: "prompt", kind: "user", text: "Prompt" },
      { id: "response", kind: "assistant", text: "Partial" },
      { id: "tool", kind: "tool", title: "Read" },
    ];
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            item: { id: "response", kind: "assistant", text: "Updated" },
            streaming: true,
            threadId: "selected",
            type: "transcript",
          } satisfies HostToWebviewMessage,
        })
      );
    });
    const chat = document.querySelector<HTMLElement>("#chat");
    const target = document.querySelector<HTMLElement>(
      '[data-message-id="prompt"]'
    );
    if (!chat || !target) {
      throw new Error("Missing transcript scroll target");
    }
    const scrollIntoView = vi.fn<(options: ScrollIntoViewOptions) => void>(
      () => {
        chat.scrollLeft = 48;
      }
    );
    target.scrollIntoView = scrollIntoView;
    chat.scrollLeft = 12;
    chat.getBoundingClientRect = () => testValue<DOMRect>({ top: 20 });
    target.getBoundingClientRect = () => testValue<DOMRect>({ top: 220 });
    let scrollTop = 40;
    const scroll = vi.fn<(value: number) => void>();
    Object.defineProperty(chat, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
        scroll(value);
      },
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Message history"]')
        ?.click();
    });
    expect(
      [...document.querySelectorAll("#history-list .history-entry")].map(
        (row) => row.textContent
      )
    ).toStrictEqual(["Prompt", "Updated"]);
    act(() => {
      document
        .querySelector<HTMLButtonElement>("#history-list .history-jump")
        ?.click();
    });
    expect({
      scrollIntoView: scrollIntoView.mock.calls,
      scrollLeft: chat.scrollLeft,
      scrollTop,
    }).toStrictEqual({ scrollIntoView: [], scrollLeft: 12, scrollTop: 240 });
    scroll.mockClear();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            item: { id: "later", kind: "assistant", text: "Later" },
            streaming: true,
            threadId: "selected",
            type: "transcript",
          } satisfies HostToWebviewMessage,
        })
      );
    });
    expect(scroll).not.toHaveBeenCalled();
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
    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(composer.value.length);
    expect(postMessage).toHaveBeenCalledWith({ type: "draftsConsumed" });
    await unmount();
  });

  test("prepends a selected skill to the existing draft", async () => {
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
                    name: "skill:ponytail-review",
                  },
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
    const value = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    );
    if (!composer || !value?.set) {
      throw new Error("Missing composer");
    }
    act(() => {
      value.set?.call(composer, "Review my current branch");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      document
        .querySelector<HTMLButtonElement>("#skill-picker-button")
        ?.click();
    });
    act(() => {
      document.querySelector<HTMLButtonElement>(".skill-picker-entry")?.click();
    });
    expect(composer.value).toBe(
      "/skill:ponytail-review Review my current branch"
    );
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
          agentId: "magpi-acp",
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
    const button = document.querySelector<HTMLButtonElement>(
      '.config-trigger[aria-label="Model"]'
    );
    if (!button) {
      throw new Error("Missing model dropdown");
    }
    act(() => {
      button.click();
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent?.includes("one"));

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
      expanded: button.getAttribute("aria-expanded"),
      selected: option?.getAttribute("aria-selected"),
    }).toStrictEqual({
      active: option,
      expanded: "true",
      selected: "true",
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

  test("renders themed elicitation choices and submits a multi-select with custom context", async () => {
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
                label: "Allowed tools",
                name: "tools",
                options: [
                  { name: "Read", value: "read" },
                  { name: "Search", value: "search" },
                ],
                required: false,
                type: "multiselect",
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
    const multipleChoices = [
      ...document.querySelectorAll<HTMLInputElement>(
        '#interaction input[type="checkbox"][name="tools"]'
      ),
    ];
    if (
      !custom ||
      !submit ||
      choices.length !== 2 ||
      multipleChoices.length !== 2
    ) {
      throw new Error("Missing elicitation controls");
    }

    expect({
      actionIcons: document.querySelectorAll(
        ".interaction-actions .interaction-action-icon"
      ).length,
      blocked: document.querySelector("#thread-content")?.hasAttribute("inert"),
      cancelIsDanger:
        document.querySelector(".interaction-actions .action.danger") !== null,
      context: document.querySelector(".interaction-context")?.textContent,
      customDescription: document.querySelector(
        ".interaction-custom-response .interaction-field-description"
      )?.textContent,
      descriptions: [...document.querySelectorAll(".interaction-choice")].map(
        (choice) => choice.textContent
      ),
      icon: document.querySelector(".interaction-heading .lucide"),
      question: document.querySelector(".interaction-question")?.textContent,
      tooltips: [
        ...document.querySelectorAll<HTMLButtonElement>("#interaction button"),
      ].map((button) => button.title),
    }).toStrictEqual({
      actionIcons: 2,
      blocked: true,
      cancelIsDanger: true,
      context: "ContextTest prompt context.",
      customDescription: "Optional additional info or options",
      descriptions: [
        "Immutable once round startsGames can trust the roster for the whole round.",
        "Editable until first scoreChanges remain possible until scoring begins.",
        "Read",
        "Search",
      ],
      icon: testValue<unknown>(expect.any(SVGElement)),
      question: "Can Team membership change after a round starts?",
      tooltips: ["Submit", "Cancel"],
    });

    postMessage.mockClear();
    act(() => {
      choices[0]?.click();
      multipleChoices[0]?.click();
      multipleChoices[1]?.click();
    });
    act(() => {
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
          tools: ["read", "search"],
        },
      },
      type: "respond",
    });
    await unmount();
  });

  test("turns numbered ask-user options into selectable choices", async () => {
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
            fields: [
              {
                description: "Type your selection(s)...",
                label: "Answer",
                name: "answer",
                required: true,
                type: "text",
              },
            ],
            id: "ask-2",
            kind: "elicitation",
            message: [
              "Which detail should I polish next? Select any that apply.",
              "",
              "Options (select one or more):",
              "1. Typography — Theme the text.",
              "2. Spacing — Fit more choices.",
              "3. Buttons — Move actions right.",
            ].join("\n"),
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
        '#interaction input[type="checkbox"][name="__mischief_options"]'
      ),
    ];
    const custom = document.querySelector<HTMLTextAreaElement>(
      '#interaction textarea[name="answer"]'
    );
    const submit = document.querySelector<HTMLButtonElement>(
      '#interaction button[type="submit"]'
    );
    if (choices.length !== 3 || !custom || !submit) {
      throw new Error("Missing selectable ask-user options");
    }
    expect({
      choices: [...document.querySelectorAll(".interaction-choice-title")].map(
        (choice) => choice.textContent
      ),
      customDescription: document.querySelector(
        ".interaction-custom-response .interaction-field-description"
      )?.textContent,
      question: document.querySelector(".interaction-question")?.textContent,
    }).toStrictEqual({
      choices: ["Typography", "Spacing", "Buttons"],
      customDescription: "Optional additional info or options",
      question: "Which detail should I polish next? Select any that apply.",
    });

    postMessage.mockClear();
    act(() => {
      choices[0]?.click();
      choices[2]?.click();
      custom.value = "More contrast";
      submit.click();
    });
    expect(postMessage).toHaveBeenCalledWith({
      id: "ask-2",
      response: {
        action: "accept",
        values: { answer: "Typography, Buttons, More contrast" },
      },
      type: "respond",
    });
    await unmount();
  });
});
