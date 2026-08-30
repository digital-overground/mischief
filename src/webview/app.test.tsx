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

describe("React webview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMessage.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("preserves in-progress composer text across streaming snapshots", async () => {
    const container = document.querySelector("#root");
    if (!(container instanceof HTMLElement)) {
      throw new Error("Missing test root");
    }
    const root = createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    const state: HostToWebviewMessage = {
      font: "Test Mono",
      projects: { projects: [], ungrouped: [] },
      threads: {
        attentionCount: 0,
        selected: {
          configOptions: [],
          drafts: [],
          id: "selected",
          items: [{ id: "assistant", kind: "assistant", text: "First" }],
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
    const composer = document.querySelector<HTMLTextAreaElement>("#composer");
    if (!composer) {
      throw new Error("Missing composer");
    }
    composer.value = "unfinished draft";

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
                    configOptions: [...state.threads.selected.configOptions],
                    drafts: [...state.threads.selected.drafts],
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

    expect(composer.value).toBe("unfinished draft");
    await act(() => {
      root.unmount();
    });
  });

  test("bounds context suggestions without blocking composer input", async () => {
    const container = document.querySelector("#root");
    if (!(container instanceof HTMLElement)) {
      throw new Error("Missing test root");
    }
    const root = createRoot(container);
    await act(() => {
      root.render(<App />);
    });
    await act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            font: "Test Mono",
            projects: { projects: [], ungrouped: [] },
            threads: {
              attentionCount: 0,
              selected: {
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
      Array.from({ length: 200 }, (_, index) => `file-${index}.ts`),
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
    await act(() => {
      valueSetter.call(composer, "@file");
      composer.setSelectionRange(5, 5);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect({
      reads,
      suggestions: document.querySelectorAll("#context-suggestions button")
        .length,
    }).toStrictEqual({ reads: 50, suggestions: 50 });
    await act(() => {
      root.unmount();
    });
  });

  test("keeps an in-progress model choice open across streaming snapshots", async () => {
    const container = document.querySelector("#root");
    if (!(container instanceof HTMLElement)) {
      throw new Error("Missing test root");
    }
    const root = createRoot(container);
    await act(() => {
      root.render(<App />);
    });
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
    await act(() => {
      root.unmount();
    });
  });

  test("renders snapshots and routes steering and plan actions", async () => {
    const container = document.querySelector("#root");
    if (!(container instanceof HTMLElement)) {
      throw new Error("Missing test root");
    }
    const root = createRoot(container);
    await act(() => {
      root.render(<App />);
    });

    const state: HostToWebviewMessage = {
      font: "Test Mono",
      projects: { projects: [], ungrouped: [] },
      threads: {
        attentionCount: 0,
        selected: {
          configOptions: [],
          drafts: [],
          id: "thread-1",
          items: [
            {
              id: "plan-1",
              kind: "plan",
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
      font: document.documentElement.style.getPropertyValue(
        "--mischief-mono-font"
      ),
      plan: document.querySelector("#plan-body")?.textContent,
      steering: document
        .querySelector("#steering")
        ?.textContent?.includes("Keep the controls small"),
      title: document.querySelector("#thread-title")?.textContent,
    }).toStrictEqual({
      font: "Test Mono",
      plan: "1. Refactor the view",
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

    await act(() => {
      root.unmount();
    });
  });
});
