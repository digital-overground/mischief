// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RenderedThreadDetail } from "../../../../protocol";

const action = vi.fn<() => void>();
const postMessage = vi.fn<(message: unknown) => void>();
vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage }));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
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
    <FooterControls
      onNewThread={action}
      onSend={action}
      selected={selected(overrides)}
      workspace="/workspace"
    />
  );
};

describe("Footer controls", () => {
  beforeEach(() => {
    action.mockClear();
    postMessage.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(
      document.querySelector<HTMLElement>("#root") as HTMLElement
    );
  });

  afterEach(async () => {
    await act(() => root.unmount());
    document.body.innerHTML = "";
  });

  test("closes context usage when usage disappears", async () => {
    await act(() => renderFooter({ usage: { size: 100, used: 50 } }));
    const usageButton = document.querySelector<HTMLButtonElement>("#usage");
    if (!usageButton) {
      throw new Error("Missing usage control");
    }
    await act(() => usageButton.click());
    expect(
      document.querySelector<HTMLElement>("#usage-menu")?.hidden
    ).toBeFalsy();

    await act(() => renderFooter());
    await act(() => renderFooter({ usage: { size: 100, used: 60 } }));

    expect(
      document.querySelector<HTMLElement>("#usage-menu")?.hidden
    ).toBeTruthy();
  });

  test("opens user messages in order at the pointer and closes with Escape", async () => {
    await act(() =>
      renderFooter({
        items: [
          { id: "user-1", kind: "user", text: "First request" },
          { id: "assistant", kind: "assistant", text: "Response" },
          { id: "user-2", kind: "user", text: "Most recent request" },
        ],
      })
    );
    const history = document.querySelector<HTMLButtonElement>("#history");
    if (!history) {
      throw new Error("Missing history button");
    }

    await act(() =>
      history.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 200 })
      )
    );

    const list = document.querySelector<HTMLElement>("#history-list");
    expect(
      [...document.querySelectorAll(".history-message")].map(
        (message) => message.textContent
      )
    ).toStrictEqual(["First request", "Most recent request"]);
    expect({
      active: document.activeElement === list,
      left: list?.style.left,
      width: list?.style.width,
    }).toStrictEqual({ active: true, left: "200px", width: "814px" });

    await act(() =>
      document.querySelector<HTMLButtonElement>(".history-message")?.click()
    );
    const fork = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Fork");
    await act(() => fork?.click());
    expect(postMessage).toHaveBeenCalledWith({
      id: "user-1",
      type: "forkThread",
    });

    await act(() =>
      history.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 200 })
      )
    );
    await act(() =>
      document
        .querySelectorAll<HTMLButtonElement>(".history-message")[1]
        ?.click()
    );
    const rollback = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Rollback");
    await act(() => rollback?.click());
    expect(postMessage).toHaveBeenCalledWith({
      id: "user-2",
      type: "rollbackThread",
    });

    await act(() =>
      history.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 200 })
      )
    );
    await act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    );
    expect(document.querySelector("#history-list")).toBeNull();
  });

  test("moves a minimum-width history list left near the right edge", async () => {
    await act(() =>
      renderFooter({
        items: [{ id: "user", kind: "user", text: "Request" }],
      })
    );
    const history = document.querySelector<HTMLButtonElement>("#history");
    if (!history) {
      throw new Error("Missing history button");
    }

    await act(() =>
      history.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: 900 })
      )
    );

    const list = document.querySelector<HTMLElement>("#history-list");
    expect({ left: list?.style.left, width: list?.style.width }).toStrictEqual({
      left: "514px",
      width: "500px",
    });
  });

  test("preserves the Agent's model option order", async () => {
    await act(() =>
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
      })
    );
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
