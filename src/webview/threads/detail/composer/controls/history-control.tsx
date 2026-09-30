import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isNonEmpty } from "../../../../../present";
import { postMessage } from "../../../../bridge";
import { SvgIcon } from "../../../../icon";
import type { RenderedTranscriptItem } from "../../../../protocol";

const preview = (item: RenderedTranscriptItem): string => {
  if (isNonEmpty(item.text)) {
    return item.text;
  }
  return item.kind === "user" ? "Image prompt" : "Agent response";
};

export const HistoryControl = ({
  items,
  onJumpMessage,
  selected,
}: {
  items: RenderedTranscriptItem[];
  onJumpMessage?: (id: string) => void;
  selected?: {
    id: string | null;
    status: string;
    sessionOperation?: string;
    forkSupported?: boolean;
    treeNavigationSupported?: boolean;
  };
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(8);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
      list.current.focus();
    }
  }, [open]);
  useEffect(() => {
    const outside = (event: MouseEvent): void => {
      if (
        open &&
        event.target instanceof Node &&
        button.current?.parentElement?.contains(event.target) !== true
      ) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (open && event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div id="history-control">
      <button
        ref={button}
        className="action"
        type="button"
        title="Message history"
        aria-label="Message history"
        aria-controls="history-list"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!isNonEmpty(selected?.id) || items.length === 0}
        onClick={(event) => {
          if (!open) {
            const footer = event.currentTarget.closest("footer");
            const bounds = footer?.getBoundingClientRect();
            const width =
              bounds !== undefined && bounds.width > 0
                ? bounds.width
                : window.innerWidth;
            const popupWidth = Math.min(500, width - 16);
            setLeft(
              Math.max(
                8,
                Math.min(
                  event.clientX - (bounds?.left ?? 0),
                  width - popupWidth - 8
                )
              )
            );
          }
          setOpen((current) => !current);
        }}
      >
        <SvgIcon kind="history" />
      </button>
      {open ? (
        <div
          id="history-list"
          ref={list}
          role="dialog"
          aria-label="Message history"
          tabIndex={-1}
          style={{ left }}
        >
          {items.map((item) => {
            const threadId = selected?.id;
            const actionable =
              isNonEmpty(threadId) &&
              selected?.status === "idle" &&
              selected.sessionOperation === undefined &&
              item.id.startsWith(`${item.kind}:`) &&
              item.id.length > item.kind.length + 1 &&
              item.queued === undefined &&
              item.cancelled !== true;
            return (
              <div className={`history-entry ${item.kind}`} key={item.id}>
                <button
                  className="history-jump"
                  type="button"
                  title={preview(item)}
                  disabled={
                    selected?.status === "running" ||
                    selected?.status === "waiting"
                  }
                  onClick={() => {
                    setOpen(false);
                    onJumpMessage?.(item.id);
                  }}
                >
                  {preview(item)}
                </button>
                {actionable &&
                item.kind === "user" &&
                selected?.forkSupported === true ? (
                  <button
                    type="button"
                    aria-label={`Fork at ${preview(item)}`}
                    title="Fork here"
                    onClick={() => {
                      setOpen(false);
                      if (isNonEmpty(threadId)) {
                        postMessage({
                          messageId: item.id,
                          threadId,
                          type: "forkThread",
                        });
                      }
                    }}
                  >
                    <SvgIcon kind="fork" />
                  </button>
                ) : null}
                {actionable && selected?.treeNavigationSupported === true ? (
                  <button
                    type="button"
                    aria-label={`Navigate to ${preview(item)}`}
                    title="Navigate here"
                    onClick={() => {
                      setOpen(false);
                      if (isNonEmpty(threadId)) {
                        postMessage({
                          messageId: item.id,
                          threadId,
                          type: "navigateThreadTree",
                        });
                      }
                    }}
                  >
                    <SvgIcon kind="gitBranch" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
