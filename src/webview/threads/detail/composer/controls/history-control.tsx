import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { postMessage } from "../../../../bridge";
import { SvgIcon } from "../../../../icon";
import type { RenderedThreadDetail } from "../../../../protocol";

export const HistoryControl = ({
  selected,
}: {
  selected?: RenderedThreadDetail;
}): React.JSX.Element => {
  const messages =
    selected?.items.filter(
      (item) => item.kind === "user" || item.kind === "assistant"
    ) ?? [];
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    bottom: number;
    left: number;
    width: number;
  }>();

  useLayoutEffect(() => {
    if (position && list.current) {
      list.current.scrollTop = list.current.scrollHeight;
      list.current.focus();
    }
  }, [position]);

  useEffect(() => {
    if (!position) {
      return;
    }
    const close = (): void => {
      setPosition(undefined);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", escape);
    };
  }, [position]);

  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    if (position) {
      setPosition(undefined);
      return;
    }
    const left = Math.min(event.clientX, window.innerWidth - 510);
    setPosition({
      bottom:
        window.innerHeight -
        event.currentTarget.getBoundingClientRect().top +
        4,
      left,
      width: window.innerWidth - left - 10,
    });
  };

  return (
    <div id="history-control">
      <button
        className="action"
        id="history"
        title="Message history"
        aria-controls="history-list"
        aria-expanded={Boolean(position)}
        disabled={!messages.length}
        onClick={toggle}
      >
        <SvgIcon kind="history" />
      </button>
      {position ? (
        <div
          id="history-list"
          ref={list}
          role="dialog"
          aria-label="Message history"
          tabIndex={-1}
          style={position}
          onClick={(event) => event.stopPropagation()}
        >
          {messages.map((message) => (
            <div
              className={`history-entry ${message.kind}`}
              key={message.id}
              tabIndex={0}
            >
              <span className="history-message" title={message.text}>
                {message.text}
              </span>
              <div className="history-actions">
                <button
                  className="history-action"
                  title="Fork from this message"
                  aria-label="Fork from this message"
                  type="button"
                  disabled={selected?.status !== "idle"}
                  onClick={() => {
                    postMessage({ id: message.id, type: "forkThread" });
                    setPosition(undefined);
                  }}
                >
                  <SvgIcon kind="fork" />
                </button>
                <button
                  className="history-action"
                  title="Rollback to this message"
                  aria-label="Rollback to this message"
                  type="button"
                  onClick={() => {
                    postMessage({ id: message.id, type: "rollbackThread" });
                    setPosition(undefined);
                  }}
                >
                  <SvgIcon kind="rollback" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
