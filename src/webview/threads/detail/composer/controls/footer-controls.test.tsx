import { act } from "react";
// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { testValue } from "../../../../../test-value";
import type { RenderedThreadDetail } from "../../../../protocol";

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

  test("shows id-free Thread operation actions only when supported", async () => {
    await Promise.resolve();
    act(() => {
      renderFooter();
    });
    expect({
      fork: document.querySelector("#footer-fork-thread"),
      tree: document.querySelector("#footer-navigate-tree"),
    }).toStrictEqual({ fork: null, tree: null });

    act(() => {
      renderFooter({ forkSupported: true, treeNavigationSupported: true });
    });
    const fork = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Fork Thread"]'
    );
    const tree = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Navigate Thread Tree"]'
    );
    expect({
      fork: { disabled: fork?.disabled, title: fork?.title },
      tree: { disabled: tree?.disabled, title: tree?.title },
    }).toStrictEqual({
      fork: { disabled: false, title: "Fork Thread" },
      tree: { disabled: false, title: "Navigate Thread Tree" },
    });

    act(() => fork?.click());
    act(() => tree?.click());
    expect(postMessage.mock.calls).toStrictEqual([
      [{ type: "forkThread" }],
      [{ type: "navigateThreadTree" }],
    ]);
  });

  test("disables Thread operations and Send during a Thread operation", async () => {
    await Promise.resolve();
    act(() => {
      renderFooter({
        forkSupported: true,
        sessionOperation: true,
        treeNavigationSupported: true,
      });
    });

    expect({
      fork: document.querySelector<HTMLButtonElement>("#footer-fork-thread")
        ?.disabled,
      send: document.querySelector<HTMLButtonElement>("#send")?.disabled,
      tree: document.querySelector<HTMLButtonElement>("#footer-navigate-tree")
        ?.disabled,
    }).toStrictEqual({ fork: true, send: true, tree: true });

    act(() => {
      renderFooter({
        forkSupported: true,
        status: "running",
        treeNavigationSupported: true,
      });
    });
    expect({
      fork: document.querySelector<HTMLButtonElement>("#footer-fork-thread")
        ?.disabled,
      tree: document.querySelector<HTMLButtonElement>("#footer-navigate-tree")
        ?.disabled,
    }).toStrictEqual({ fork: true, tree: true });
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
