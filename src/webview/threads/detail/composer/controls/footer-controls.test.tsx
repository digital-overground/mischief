import { act } from "react";
// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { testValue } from "../../../../../test-value";
import type {
  RenderedThreadDetail,
  RenderedTranscriptItem,
} from "../../../../protocol";

const action = vi.fn<() => void>();
const postMessage = vi.fn<(message: unknown) => void>();
vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }));
testValue<{ IS_REACT_ACT_ENVIRONMENT?: boolean }>(
  globalThis
).IS_REACT_ACT_ENVIRONMENT = true;

const { FooterControls } = await import("./footer-controls");

const selected = (
  overrides: Partial<RenderedThreadDetail> = {}
): RenderedThreadDetail => ({
  commands: [],
  configOptions: [],
  drafts: [],
  id: "thread",
  items: [],
  name: "Thread",
  status: "idle",
  steering: [],
  streaming: false,
  ...overrides,
});

let root: Root;
const renderFooter = (overrides: Partial<RenderedThreadDetail> = {}): void => {
  root.render(
    <FooterControls onSend={action} selected={selected(overrides)} />
  );
};

describe("Footer controls", () => {
  beforeEach(() => {
    action.mockClear();
    postMessage.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
    const container = document.querySelector<HTMLElement>("#root");
    if (!container) {
      throw new Error("Missing test root");
    }
    root = createRoot(container);
  });

  afterEach(async () => {
    await Promise.resolve();
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  test("shows browse-only message history and closes it on Thread change", () => {
    const items: RenderedTranscriptItem[] = [
      { id: "u", kind: "user", text: "Prompt" },
      { id: "tool", kind: "tool", title: "Read" },
      { id: "a", kind: "assistant", text: "Response" },
      {
        id: "image",
        images: [{ data: "abc", mimeType: "image/png" }],
        kind: "user",
      },
    ];
    const jump = vi.fn<(id: string) => void>();
    act(() => {
      root.render(
        <FooterControls
          historyItems={items.filter(
            (item) => item.kind === "user" || item.kind === "assistant"
          )}
          onJumpMessage={jump}
          onSend={action}
          selected={selected()}
        />
      );
    });
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="Message history"]'
    );
    act(() => button?.click());
    expect(
      [...document.querySelectorAll("#history-list .history-entry")].map(
        (row) => row.textContent
      )
    ).toStrictEqual(["Prompt", "Response", "Image prompt"]);
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          "#history-list .history-entry:last-child .history-jump"
        )
        ?.click();
    });
    expect(jump).toHaveBeenCalledWith("image");
    expect(document.querySelector("#history-list")).toBeNull();
    act(() => button?.click());
    act(() => {
      root.render(
        <FooterControls
          historyItems={items}
          onJumpMessage={jump}
          onSend={action}
          selected={selected({ id: "other" })}
        />
      );
    });
    expect(document.querySelector("#history-list")).toBeNull();
  });

  test("sends transcript IDs for idle row actions, not for busy rows", () => {
    const items: RenderedTranscriptItem[] = [
      { id: "user:one", kind: "user", text: "Same" },
      { id: "assistant:two", kind: "assistant", text: "Answer" },
      { id: "user:three", kind: "user", text: "Same" },
      { id: "local", kind: "user", text: "Old" },
    ];
    act(() => {
      root.render(
        <FooterControls
          historyItems={items}
          onSend={action}
          selected={selected({
            forkSupported: true,
            treeNavigationSupported: true,
          })}
        />
      );
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Message history"]')
        ?.click()
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Fork at Same"]')
        ?.click()
    );
    expect(postMessage).toHaveBeenCalledWith({
      messageId: "user:one",
      threadId: "thread",
      type: "forkThread",
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Message history"]')
        ?.click()
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Navigate to Answer"]')
        ?.click()
    );
    expect(postMessage).toHaveBeenCalledWith({
      messageId: "assistant:two",
      threadId: "thread",
      type: "navigateThreadTree",
    });
    act(() => {
      root.render(
        <FooterControls
          historyItems={items}
          onSend={action}
          selected={selected({
            forkSupported: true,
            status: "running",
            treeNavigationSupported: true,
          })}
        />
      );
    });
    expect(document.querySelector('[aria-label="Fork at Same"]')).toBeNull();
    expect(
      document.querySelector('[aria-label="Navigate to Answer"]')
    ).toBeNull();
  });

  test("keeps history on-screen in a narrow footer and focuses newest entries", () => {
    act(() => {
      root.render(
        <FooterControls
          historyItems={[{ id: "u", kind: "user", text: "Prompt" }]}
          onSend={action}
          selected={selected()}
        />
      );
    });
    const footer = document.querySelector<HTMLElement>("#root");
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="Message history"]'
    );
    if (!footer || !button) {
      throw new Error("Missing history control");
    }
    vi.spyOn(button, "closest").mockReturnValue(footer);
    vi.spyOn(footer, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 30,
      left: 0,
      right: 180,
      toJSON: () => ({}),
      top: 470,
      width: 180,
      x: 0,
      y: 470,
    });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 22,
      left: 12,
      right: 34,
      toJSON: () => ({}),
      top: 478,
      width: 22,
      x: 12,
      y: 478,
    });
    act(() => {
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 179 })
      );
    });
    const list = document.querySelector<HTMLElement>("#history-list");
    expect({
      bottom: list?.style.bottom,
      left: list?.style.left,
      maxHeight: list?.style.maxHeight,
    }).toStrictEqual({ bottom: "22px", left: "8px", maxHeight: "470px" });
    expect(document.activeElement).toBe(list);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });

  test("closes message history on Escape and outside pointerdown", () => {
    act(() => {
      root.render(
        <FooterControls
          historyItems={[{ id: "u", kind: "user", text: "Prompt" }]}
          onSend={action}
          selected={selected()}
        />
      );
    });
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="Message history"]'
    );
    act(() => button?.click());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(document.querySelector("#history-list")).toBeNull();
    expect(document.activeElement).toBe(button);
    act(() => button?.click());
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector("#history-list")).toBeNull();
  });

  test("closes context usage when usage disappears", async () => {
    await Promise.resolve();
    act(() => {
      renderFooter({ usage: { size: 100, used: 50 } });
    });
    const usageButton = document.querySelector<HTMLButtonElement>("#usage");
    if (!usageButton) {
      throw new Error("Missing usage control");
    }
    act(() => {
      usageButton.click();
    });
    expect(
      document.querySelector<HTMLElement>("#usage-menu")?.hidden
    ).toBeFalsy();

    act(() => {
      renderFooter();
    });
    act(() => {
      renderFooter({ usage: { size: 100, used: 60 } });
    });

    expect(
      document.querySelector<HTMLElement>("#usage-menu")?.hidden
    ).toBeTruthy();
  });

  test("keeps Fork and Tree actions in history rather than the footer", () => {
    act(() => {
      renderFooter({ forkSupported: true, treeNavigationSupported: true });
    });
    expect({
      fork: document.querySelector("#footer-fork-thread"),
      tree: document.querySelector("#footer-navigate-tree"),
    }).toStrictEqual({ fork: null, tree: null });
  });

  test("disables Send during a Thread operation", () => {
    act(() => {
      renderFooter({ sessionOperation: "navigateTree" });
    });
    expect(
      document.querySelector<HTMLButtonElement>("#send")?.disabled
    ).toBeTruthy();
  });

  test("preserves the Agent's model option order", async () => {
    await Promise.resolve();
    act(() => {
      renderFooter({
        configOptions: [
          {
            currentValue: "provider/one",
            id: "model",
            name: "Model",
            options: [
              { name: "provider/one", value: "provider/one" },
              {
                name: "Recommended",
                options: [{ name: "Curated", value: "curated" }],
              },
              { name: "provider/two", value: "provider/two" },
              { name: "Standalone", value: "standalone" },
            ],
            type: "select",
          },
        ],
      });
    });
    const model = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Model"]'
    );
    if (!model) {
      throw new Error("Missing model select");
    }

    expect(
      [...model.children].map(
        (item) => item.getAttribute("label") ?? item.textContent
      )
    ).toStrictEqual(["provider", "Recommended", "Standalone"]);
  });
});
