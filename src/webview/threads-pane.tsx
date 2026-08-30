import { memo, useEffect, useState } from "react";

import type { ThreadIndicator, ThreadSummary } from "../threads/threads";
import { postMessage } from "./bridge";
import type { RenderedThreadsSnapshot } from "./protocol";

const indicatorKind = (thread: ThreadSummary): ThreadIndicator => {
  if (
    ["active", "waiting", "completed", "idle", "error"].includes(
      thread.indicator
    )
  ) {
    return thread.indicator;
  }
  if (thread.status === "running") {
    return "active";
  }
  if (thread.status === "waiting") {
    return "waiting";
  }
  if (thread.status === "error") {
    return "error";
  }
  return "idle";
};

const indicatorLabel = (kind: ThreadIndicator): string => {
  if (kind === "active") {
    return "Agent active";
  }
  if (kind === "waiting") {
    return "Waiting for user input";
  }
  if (kind === "completed") {
    return "Completed — needs attention";
  }
  if (kind === "error") {
    return "Agent error — needs attention";
  }
  return "Idle";
};

const compactTime = (value: string, now: number): string => {
  const elapsed = Math.max(0, now - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}min`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

const StatusIndicator = ({
  kind,
  label = indicatorLabel(kind),
}: {
  kind: ThreadIndicator;
  label?: string;
}): React.JSX.Element => (
  <span
    className={`thread-status ${kind}`}
    title={label}
    role="img"
    aria-label={label}
  />
);

const Attention = ({
  threads,
}: {
  threads: ThreadSummary[];
}): React.JSX.Element | null => {
  const attention = threads.filter(
    (thread) =>
      thread.needsAttention ||
      ["waiting", "completed", "error"].includes(indicatorKind(thread))
  );
  if (!attention.length) {
    return null;
  }
  const waiting = attention.some((thread) =>
    ["waiting", "error"].includes(indicatorKind(thread))
  );
  const completed = attention.some(
    (thread) => indicatorKind(thread) === "completed"
  );
  const title = `${attention.length} Thread${attention.length === 1 ? " needs" : "s need"} attention`;
  return (
    <span
      id="threads-attention"
      className="attention-badge"
      title={title}
      role="status"
      aria-label={title}
    >
      {waiting ? (
        <StatusIndicator kind="waiting" label="Thread waiting for user input" />
      ) : null}
      {completed ? (
        <StatusIndicator
          kind="completed"
          label="Thread completed while unread"
        />
      ) : null}
      <span>{attention.length}</span>
    </span>
  );
};

const ThreadsPaneView = ({
  snapshot,
}: {
  snapshot: RenderedThreadsSnapshot;
}): React.JSX.Element => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(clock);
  }, []);
  return (
    <section id="threads">
      <header>
        <span className="heading" id="threads-title">
          Threads
        </span>
        <Attention threads={snapshot.threads} />
        <button
          className="icon"
          id="new-thread"
          title="New Thread"
          aria-label="New Thread"
          disabled={!snapshot.workspace}
          onClick={() => postMessage({ type: "newThread" })}
        >
          ＋
        </button>
      </header>
      <div className="content" id="thread-list">
        {snapshot.threads.map((thread) => (
          <div
            className={`row${snapshot.selected?.id === thread.id ? " selected" : ""}`}
            key={thread.id}
          >
            <button
              className="row-open"
              onClick={() =>
                postMessage({ id: thread.id, type: "selectThread" })
              }
            >
              <StatusIndicator kind={indicatorKind(thread)} />
              <span className="name">{thread.name}</span>
              <span className="meta">
                {thread.status} {"  "}
                {compactTime(thread.updatedAt, now)}
              </span>
            </button>
            <button
              className="icon"
              title="Remove Thread"
              aria-label="Remove Thread"
              onClick={() =>
                postMessage({ id: thread.id, type: "removeThread" })
              }
            >
              ×
            </button>
          </div>
        ))}
        {snapshot.workspace ? null : (
          <div className="empty">Open a managed Workspace.</div>
        )}
        {snapshot.workspace && !snapshot.threads.length ? (
          <div className="empty">No durable Threads yet.</div>
        ) : null}
      </div>
    </section>
  );
};

const sameThread = (previous: ThreadSummary, next: ThreadSummary): boolean =>
  previous.id === next.id &&
  previous.name === next.name &&
  previous.status === next.status &&
  previous.indicator === next.indicator &&
  previous.needsAttention === next.needsAttention &&
  previous.createdAt === next.createdAt &&
  previous.updatedAt === next.updatedAt;

export const ThreadsPane = memo(
  ThreadsPaneView,
  (previous, next) =>
    previous.snapshot.workspace === next.snapshot.workspace &&
    previous.snapshot.selected?.id === next.snapshot.selected?.id &&
    previous.snapshot.attentionCount === next.snapshot.attentionCount &&
    previous.snapshot.threads.length === next.snapshot.threads.length &&
    previous.snapshot.threads.every((thread, index) => {
      const nextThread = next.snapshot.threads[index];
      return nextThread ? sameThread(thread, nextThread) : false;
    })
);
