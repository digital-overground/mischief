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

  test("uses each Agent's config icons", () => {
    const options = [
      { id: "mode", name: "Mode" },
      { id: "collaboration_mode", name: "Collaboration" },
      { id: "model", name: "Model" },
      { id: "reasoning_effort", name: "Reasoning effort" },
      { id: "fast-mode", name: "Fast mode" },
    ].map(({ id, name }) => ({
      currentValue: "off",
      id,
      name,
      options: [{ name: "Off", value: "off" }],
      type: "select" as const,
    }));
    act(() => {
      renderFooter({ agentId: "codex-acp", configOptions: options });
    });
    expect(
      [...document.querySelectorAll("#configs .config-trigger")].map((button) =>
        button.getAttribute("aria-label")
      )
    ).toStrictEqual(options.map(({ name }) => name));
    expect(
      [...document.querySelectorAll("#configs .config-icon")].map((icon) =>
        icon.getAttribute("aria-label")
      )
    ).toStrictEqual([
      "Mode",
      "Collaboration",
      "Model",
      "Reasoning effort",
      "Fast mode",
    ]);
    expect(
      ["Mode", "Fast mode"].map((name) =>
        document
          .querySelector(`[aria-label="${name}"] svg path`)
          ?.getAttribute("d")
          ?.slice(0, 6)
      )
    ).toStrictEqual(["M12 22", "M4 14 "]);
    act(() => {
      renderFooter({
        agentId: "magpi-acp",
        configOptions: [
          { ...options[2], id: "model" },
          { ...options[2], id: "role", name: "Role" },
          { ...options[2], id: "thought_level", name: "Thinking" },
          { ...options[2], id: "fast-mode", name: "Other" },
        ],
      });
    });
    expect(
      [...document.querySelectorAll("#configs .config-icon")].map((icon) =>
        icon.getAttribute("aria-label")
      )
    ).toStrictEqual(["Model", "Role", "Thinking"]);
    act(() => {
      renderFooter({ agentId: "claude-agent-acp", configOptions: options });
    });
    expect(
      [...document.querySelectorAll("#configs .config-icon")].map((icon) =>
        icon.getAttribute("aria-label")
      )
    ).toStrictEqual(["Mode", "Model"]);
  });

  test("labels and bounds Claude's scrollable menu and routes choices", () => {
    act(() => {
      renderFooter({
        agentId: "claude-agent-acp",
        configOptions: ["agent", "mode", "model", "effort", "fast"].map(
          (id) => ({
            currentValue: "first",
            id,
            name: id,
            options: Array.from({ length: 40 }, (_, index) => ({
              name: `Choice ${index}`,
              value: index === 0 ? "first" : `choice-${index}`,
            })),
            type: "select" as const,
          })
        ),
      });
    });
    expect(document.querySelectorAll("#configs .config-icon")).toHaveLength(5);
    const button = document.querySelector<HTMLButtonElement>(
      '.config-trigger[aria-label="agent"]'
    );
    act(() => button?.click());
    const menu = document.querySelector<HTMLElement>(
      '.config-menu[aria-label="agent"]'
    );
    expect({
      count: menu?.querySelectorAll('[role="option"]').length,
      heading: menu?.querySelector(".config-menu-title")?.textContent,
      height: menu?.style.maxHeight,
    }).toStrictEqual({ count: 40, heading: "agent", height: "320px" });
    act(() => {
      menu?.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]?.click();
    });
    expect(postMessage).toHaveBeenCalledWith({
      id: "agent",
      type: "setConfig",
      value: "choice-1",
    });
  });

  test("opens from the caret while keeping the full title in the popup", () => {
    act(() => {
      renderFooter({
        agentId: "codex-acp",
        configOptions: [
          {
            currentValue: "default",
            id: "collaboration_mode",
            name: "Collaboration mode",
            options: [
              { name: "Default", value: "default" },
              { name: "Plan", value: "plan" },
            ],
            type: "select",
          },
        ],
      });
    });
    const button = document.querySelector<HTMLButtonElement>(".config-trigger");
    expect(button?.querySelector(".config-trigger-label")?.textContent).toBe(
      "Default"
    );
    act(() => {
      button?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: button.getBoundingClientRect().right,
        })
      );
    });
    expect(document.querySelector(".config-menu-title")?.textContent).toBe(
      "Collaboration mode"
    );
    expect(button?.getAttribute("aria-expanded")).toBe("true");
  });

  test("supports keyboard navigation and closes on Escape", () => {
    act(() => {
      renderFooter({
        configOptions: [
          {
            currentValue: "low",
            id: "thought_level",
            name: "Thinking",
            options: [
              { name: "Low", value: "low" },
              { name: "High", value: "high" },
            ],
            type: "select",
          },
        ],
      });
    });
    const button = document.querySelector<HTMLButtonElement>(
      '.config-trigger[aria-label="Thinking"]'
    );
    act(() => button?.click());
    expect(document.activeElement?.textContent).toContain("Low");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    expect(document.activeElement?.textContent).toContain("High");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      );
    });
    expect(postMessage).toHaveBeenCalledWith({
      id: "thought_level",
      type: "setConfig",
      value: "high",
    });
    act(() => button?.click());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(button?.getAttribute("aria-expanded")).toBe("false");
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
    act(() => {
      document
        .querySelector<HTMLButtonElement>('.config-trigger[aria-label="Model"]')
        ?.click();
    });
    expect(
      [...document.querySelectorAll(".config-menu-group")].map((group) => [
        group.querySelector(".config-menu-group-label")?.textContent ?? "",
        [...group.querySelectorAll('[role="option"]')].map((option) =>
          option.textContent?.trim()
        ),
      ])
    ).toStrictEqual([
      ["provider", ["✓one", "two"]],
      ["Recommended", ["Curated"]],
      ["", ["Standalone"]],
    ]);
  });
});
