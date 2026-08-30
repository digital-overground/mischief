// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { HostToWebviewMessage } from "./protocol";

const postMessage = vi.fn<(message: unknown) => void>();
vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { App } = await import("./app");

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
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
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
        '.plan-task-spinner[aria-label="In progress"]'
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
});
