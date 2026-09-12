// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { HostToWebviewMessage } from "./protocol";

const postMessage = vi.fn<(message: unknown) => void>();
const writeText = vi.fn<(text: string) => Promise<void>>(() =>
  Promise.resolve()
);
vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }));
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText },
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { App } = await import("./app");

const threadState = (id: string, drafts: string[]): HostToWebviewMessage => ({
  font: "Test Mono",
  projects: { projects: [], ungrouped: [] },
  threads: {
    attentionCount: 0,
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
  workspaceActivity: {},
});

const renderApp = async (): Promise<() => Promise<void>> => {
  const container = document.querySelector("#root");
  if (!(container instanceof HTMLElement)) {
    throw new Error("Missing test root");
  }
  const root = createRoot(container);
  await act(() => root.render(<App />));
  return async () => {
    await act(() => root.unmount());
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
    await act(() => {
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
              attentionCount: 0,
              threads: [],
              workspace: "/workspace",
            },
            type: "state",
            workspaceActivity: {},
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
    if (!composer || !options[0]) {
      throw new Error("Missing setup controls");
    }
    expect(options.map(({ checked }) => checked)).toStrictEqual([true, true]);
    await act(() => options[0]?.click());

    await act(() => {
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

  test("maximizes the current Thread and restores the pane layout", async () => {
    const unmount = await renderApp();
    const projects = document.querySelector<HTMLElement>("#projects");
    const threads = document.querySelector<HTMLElement>("#threads");
    const thread = document.querySelector<HTMLElement>("#thread");
    const maximize =
      document.querySelector<HTMLButtonElement>("#maximize-thread");
    if (!projects || !threads || !thread || !maximize) {
      throw new Error("Missing pane controls");
    }
    projects.style.flexBasis = "140px";
    threads.style.flexBasis = "90px";
    const maximizeIcon = maximize.innerHTML;

    await act(() => maximize.click());

    expect(maximize.innerHTML).not.toBe(maximizeIcon);
    expect({
      maximized: maximize.getAttribute("aria-pressed"),
      projects: projects.classList.contains("collapsed"),
      thread: thread.classList.contains("collapsed"),
      threads: threads.classList.contains("collapsed"),
    }).toStrictEqual({
      maximized: "true",
      projects: true,
      thread: false,
      threads: true,
    });

    await act(() => maximize.click());

    expect(maximize.innerHTML).toBe(maximizeIcon);
    expect({
      maximized: maximize.getAttribute("aria-pressed"),
      projects: [
        projects.classList.contains("collapsed"),
        projects.style.flexBasis,
      ],
      threads: [
        threads.classList.contains("collapsed"),
        threads.style.flexBasis,
      ],
    }).toStrictEqual({
      maximized: "false",
      projects: [false, "140px"],
      threads: [false, "90px"],
    });
    await unmount();
  });

  test.each(["projects", "threads"])(
    "exits Thread maximize when the %s pane is expanded",
    async (paneId) => {
      const unmount = await renderApp();
      const projects = document.querySelector<HTMLElement>("#projects");
      const threads = document.querySelector<HTMLElement>("#threads");
      const heading = document.querySelector<HTMLElement>(
        `#${paneId} > header > .heading`
      );
      const maximize =
        document.querySelector<HTMLButtonElement>("#maximize-thread");
      if (!projects || !threads || !heading || !maximize) {
        throw new Error("Missing pane controls");
      }

      await act(() => maximize.click());
      await act(() => heading.click());

      expect(maximize.getAttribute("aria-pressed")).toBe("false");
      expect(document.querySelector(`#${paneId}`)?.classList).not.toContain(
        "collapsed"
      );

      await act(() => maximize.click());

      expect({
        maximized: maximize.getAttribute("aria-pressed"),
        projects: projects.classList.contains("collapsed"),
        threads: threads.classList.contains("collapsed"),
      }).toStrictEqual({ maximized: "true", projects: true, threads: true });
      await unmount();
    }
  );

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
      close: { value: () => dialog.removeAttribute("open") },
      showModal: { value: () => dialog.setAttribute("open", "") },
    });
    const defaultChecked = checkbox.checked;

    await act(() => {
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
    await act(() => checkbox.click());
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "setAssignWorkspaceColors",
      value: true,
    });

    await act(() => close.click());
    expect(dialog.open).toBeFalsy();
    await unmount();
  });

  test("routes open GitHub issues from a Project", async () => {
    const unmount = await renderApp();
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: {
              projects: [{ name: "project", root: "/project", workspaces: [] }],
              ungrouped: [],
            },
            threads: { attentionCount: 0, threads: [] },
            type: "state",
            workspaceActivity: {},
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

    await act(() => openIssues.click());

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

  test("shows each Workspace color and synchronized activity, then routes actions", async () => {
    const unmount = await renderApp();
    await act(() => {
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
                      name: "project-feature",
                      path: "/worktrees/project-feature",
                    },
                  ],
                },
              ],
              ungrouped: [],
            },
            threads: { attentionCount: 0, threads: [] },
            type: "state",
            workspaceActivity: {
              "/worktrees/project-feature": {
                active: 1,
                attention: 8,
                completed: 2,
                idle: 4,
              },
            },
          } satisfies HostToWebviewMessage,
        })
      );
    });
    const dot = document.querySelector<HTMLElement>(".workspace-color");
    const create = document.querySelector<HTMLButtonElement>(
      '[aria-label="New Workspace"]'
    );
    const close = document.querySelector<HTMLButtonElement>(
      '[aria-label="Close Workspace"]'
    );
    const spool = document.querySelector<HTMLElement>(".workspace-spool");
    const statuses = [
      ...document.querySelectorAll<HTMLElement>(".workspace-status-count"),
    ].map((status) => status.getAttribute("aria-label"));
    if (!dot || !create || !close || !spool) {
      throw new Error("Missing Workspace controls");
    }
    postMessage.mockClear();

    await act(() => {
      create.click();
      close.click();
    });

    expect({
      fill: dot.style.backgroundColor,
      message: postMessage.mock.calls,
      meta: document.querySelector("#project-list .meta")?.textContent,
      newThread: document.querySelector(
        '#project-list [aria-label="New Thread"]'
      ),
      project: document.querySelector("#project-list .group-row .name")
        ?.textContent,
      ring: dot.style.boxShadow,
      statuses,
      workspace: document.querySelector(".workspace-label .name")?.textContent,
    }).toStrictEqual({
      fill: "rgb(14, 28, 20)",
      message: [
        [{ path: "/project", type: "newWorkspace" }],
        [
          {
            path: "/worktrees/project-feature",
            type: "deactivateWorkspace",
          },
        ],
      ],
      meta: "feature/ui  worktree  ✎2  ↑1  ↓3",
      newThread: null,
      project: "project",
      ring: "0 0 0 1px #50a072",
      statuses: [
        "Idle Threads: 4",
        "Completed Threads: 2",
        "Running Threads: 1",
        "Waiting or error Threads: 8",
      ],
      workspace: "project-feature",
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
        attentionCount: 0,
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
      workspaceActivity: {},
    };
    await act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });
    expect(
      postMessage.mock.calls.filter(
        ([message]) => (message as { type?: string }).type === "contextItems"
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

    await act(() => {
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
    await act(() => {
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
    await act(() => vi.advanceTimersByTime(1));
    expect(selection.toString()).toBe("");
    await unmount();
  });

  test("defers worst-case context matching outside the input event", async () => {
    const unmount = await renderApp();
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: { projects: [], ungrouped: [] },
            threads: {
              attentionCount: 0,
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
            workspaceActivity: {},
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
          return Reflect.get(target, property, receiver);
        },
      }
    );
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { items: candidates, type: "contextItems" },
        })
      );
    });
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (!composer || !valueSetter) {
      throw new Error("Missing composer");
    }
    postMessage.mockClear();
    let synchronousReads = -1;
    await act(() => {
      valueSetter.call(composer, "@missing");
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

    await act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("original", []) })
      )
    );
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    if (!composer) {
      throw new Error("Missing composer");
    }
    composer.value = "Original draft";

    await act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: threadState("fork", ["Fork from here"]),
        })
      )
    );
    expect(composer.value).toBe("Fork from here");

    await act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("original", []) })
      )
    );
    expect(composer.value).toBe("Original draft");

    await act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data: threadState("fork", []) })
      )
    );
    expect(composer.value).toBe("Fork from here");
    await unmount();
  });

  test("autocompletes advertised slash commands and sends unknown slash text", async () => {
    const unmount = await renderApp();
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: { projects: [], ungrouped: [] },
            threads: {
              attentionCount: 0,
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
            workspaceActivity: {},
          } satisfies HostToWebviewMessage,
        })
      );
    });
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    if (!composer || !valueSetter) {
      throw new Error("Missing composer");
    }
    const input = async (value: string): Promise<void> => {
      await act(() => {
        valueSetter.call(composer, value);
        composer.setSelectionRange(value.length, value.length);
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await input("/");
    expect(
      [...document.querySelectorAll("#context-suggestions button")].map(
        (button) => button.textContent
      )
    ).toStrictEqual(["/review [branch]Review changes", "/resumeResume work"]);

    const [, resume] = document.querySelectorAll<HTMLButtonElement>(
      "#context-suggestions button"
    );
    const scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>();
    if (!resume) {
      throw new Error("Missing second command suggestion");
    }
    resume.scrollIntoView = scrollIntoView;
    await act(() => {
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    await act(() => {
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
    await act(() => {
      review.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(composer.value).toBe("/review ");

    postMessage.mockClear();
    await input("/new");
    await act(() => {
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
        attentionCount: 0,
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
      workspaceActivity: {},
    };
    await act(() => {
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

    await act(() => {
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
        attentionCount: 0,
        selected: {
          commands: [],
          configOptions: [],
          drafts: [],
          id: "thread-1",
          items: [
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
      workspaceActivity: {},
    };
    await act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: state }));
    });

    expect({
      completedIcon: document.querySelector<HTMLElement>(
        ".plan-task.completed .plan-task-icon"
      )?.title,
      font: document.documentElement.style.getPropertyValue(
        "--mischief-mono-font"
      ),
      plan: document.querySelector("#plan-body")?.textContent,
      processing: document.querySelector(
        '.plan-task-indicator[aria-label="In progress"]'
      ),
      steering: document
        .querySelector("#steering")
        ?.textContent?.includes("Keep the controls small"),
      title: document.querySelector("#thread-title")?.textContent,
    }).toStrictEqual({
      completedIcon: "Completed",
      font: "Test Mono",
      plan: "Inspect the viewRefactor the viewTest the view",
      processing: expect.any(HTMLElement),
      steering: true,
      title: "React refactor",
    });

    const sendSteering = document.querySelector<HTMLButtonElement>(
      '[aria-label="Send steering message immediately"]'
    );
    const clearPlan = document.querySelector<HTMLButtonElement>("#clear-plan");
    if (!sendSteering || !clearPlan) {
      throw new Error("Missing Thread controls");
    }
    await act(() => {
      sendSteering.click();
    });
    await act(() => {
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
        attentionCount: 1,
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
      workspaceActivity: {},
    };
    await act(() => {
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
    }).toStrictEqual({
      context: "Context:Test prompt context.",
      descriptions: [
        "Immutable once round startsGames can trust the roster for the whole round.",
        "Editable until first scoreChanges remain possible until scoring begins.",
      ],
      icon: expect.any(SVGElement),
      question: "Can Team membership change after a round starts?",
    });

    postMessage.mockClear();
    await act(() => {
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
