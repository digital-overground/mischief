// @vitest-environment jsdom

import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.stubGlobal("acquireVsCodeApi", () => ({
  postMessage: vi.fn<(message: unknown) => void>(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { ThreadsPane } = await import("./threads-pane");

describe("Threads pane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("does not rerender an idle Thread list for animation frames", async () => {
    const container = document.querySelector("#root");
    if (!(container instanceof HTMLElement)) {
      throw new Error("Missing test root");
    }
    const root = createRoot(container);
    let commits = 0;
    await act(() => {
      root.render(
        <Profiler id="threads" onRender={() => (commits += 1)}>
          <ThreadsPane
            snapshot={{
              attentionCount: 0,
              threads: [
                {
                  createdAt: "2026-01-01T00:00:00.000Z",
                  id: "idle",
                  indicator: "idle",
                  name: "Idle Thread",
                  needsAttention: false,
                  status: "idle",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
            }}
          />
        </Profiler>
      );
    });
    const initialCommits = commits;

    await act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(commits).toBe(initialCommits);
    await act(() => {
      root.unmount();
    });
  });
});
