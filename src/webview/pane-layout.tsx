import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

const MIN_PANE_HEIGHT = 72;
const COLLAPSED_PANE_HEIGHT = 26;

export const PaneLayout = ({
  projects,
  thread,
  threads,
}: {
  projects: ReactNode;
  thread: ReactNode;
  threads: ReactNode;
}): React.JSX.Element => {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const main = root.current;
    if (!main) {
      return;
    }
    const controller = new AbortController();
    const panes = [...main.querySelectorAll<HTMLElement>(":scope > section")];
    const rebalancePanes = (): void => {
      const expanded = panes.filter(
        (pane) => !pane.classList.contains("collapsed")
      );
      for (const pane of panes) {
        pane.style.flexGrow = "0";
      }
      const last = expanded.at(-1);
      if (last) {
        last.style.flexGrow = "1";
      }
    };
    const togglePane = (pane: HTMLElement): void => {
      const collapsed = !pane.classList.contains("collapsed");
      const toggle = pane.querySelector<HTMLElement>(
        ":scope > header > .heading"
      );
      if (collapsed) {
        pane.dataset.expandedHeight = String(
          pane.getBoundingClientRect().height
        );
      }
      pane.classList.toggle("collapsed", collapsed);
      pane.style.flexBasis = `${
        collapsed
          ? COLLAPSED_PANE_HEIGHT
          : Number(pane.dataset.expandedHeight) || MIN_PANE_HEIGHT
      }px`;
      toggle?.setAttribute("aria-expanded", String(!collapsed));
      rebalancePanes();
    };
    const resizePanes = (resizer: HTMLElement, delta: number): boolean => {
      const before = document.querySelector<HTMLElement>(
        `#${resizer.dataset.before}`
      );
      const after = document.querySelector<HTMLElement>(
        `#${resizer.dataset.after}`
      );
      if (
        !before ||
        !after ||
        before.classList.contains("collapsed") ||
        after.classList.contains("collapsed")
      ) {
        return false;
      }
      const beforeHeight = before.getBoundingClientRect().height;
      const afterHeight = after.getBoundingClientRect().height;
      const total = beforeHeight + afterHeight;
      if (total < MIN_PANE_HEIGHT * 2) {
        return false;
      }
      const nextBefore = Math.max(
        MIN_PANE_HEIGHT,
        Math.min(total - MIN_PANE_HEIGHT, beforeHeight + delta)
      );
      before.style.flexBasis = `${nextBefore}px`;
      after.style.flexBasis = `${total - nextBefore}px`;
      before.dataset.expandedHeight = String(nextBefore);
      after.dataset.expandedHeight = String(total - nextBefore);
      rebalancePanes();
      return true;
    };

    for (const pane of panes) {
      const header = pane.querySelector<HTMLElement>(":scope > header");
      const toggle = header?.querySelector<HTMLElement>(":scope > .heading");
      if (!header || !toggle) {
        continue;
      }
      toggle.tabIndex = 0;
      toggle.setAttribute("role", "button");
      toggle.setAttribute("aria-expanded", "true");
      const click = (event: MouseEvent): void => {
        if ((event.target as Element).closest("button")) {
          return;
        }
        togglePane(pane);
      };
      const keydown = (event: KeyboardEvent): void => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        togglePane(pane);
      };
      header.addEventListener("click", click, { signal: controller.signal });
      toggle.addEventListener("keydown", keydown, {
        signal: controller.signal,
      });
    }

    for (const resizer of main.querySelectorAll<HTMLElement>(".resizer")) {
      let previousY: number | undefined;
      const pointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || !resizePanes(resizer, 0)) {
          return;
        }
        event.preventDefault();
        previousY = event.clientY;
        resizer.classList.add("active");
        resizer.setPointerCapture(event.pointerId);
      };
      const pointerMove = (event: PointerEvent): void => {
        if (previousY === undefined) {
          return;
        }
        resizePanes(resizer, event.clientY - previousY);
        previousY = event.clientY;
      };
      const stop = (): void => {
        previousY = undefined;
        resizer.classList.remove("active");
      };
      const keydown = (event: KeyboardEvent): void => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
          return;
        }
        event.preventDefault();
        resizePanes(resizer, event.key === "ArrowUp" ? -12 : 12);
      };
      resizer.addEventListener("pointerdown", pointerDown, {
        signal: controller.signal,
      });
      resizer.addEventListener("pointermove", pointerMove, {
        signal: controller.signal,
      });
      resizer.addEventListener("pointerup", stop, {
        signal: controller.signal,
      });
      resizer.addEventListener("pointercancel", stop, {
        signal: controller.signal,
      });
      resizer.addEventListener("keydown", keydown, {
        signal: controller.signal,
      });
    }
    rebalancePanes();
    return () => controller.abort();
  }, []);

  return (
    <main ref={root}>
      {projects}
      <div
        className="resizer"
        data-before="projects"
        data-after="threads"
        role="separator"
        aria-label="Resize Projects and Threads"
        aria-orientation="horizontal"
        tabIndex={0}
      />
      {threads}
      <div
        className="resizer"
        data-before="threads"
        data-after="thread"
        role="separator"
        aria-label="Resize Threads and Thread"
        aria-orientation="horizontal"
        tabIndex={0}
      />
      {thread}
    </main>
  );
};
