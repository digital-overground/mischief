// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RenderedThreadDetail } from "./protocol";

const action = vi.fn<() => void>();
vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: vi.fn<(message: unknown) => void>(),
}));
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
