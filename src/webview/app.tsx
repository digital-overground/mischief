import { useEffect, useMemo, useRef, useState } from "react";

import { postMessage } from "./bridge";
import { PaneLayout } from "./pane-layout";
import { ProjectsPane } from "./projects/projects-pane";
import type { HostToWebviewMessage, RenderedTranscriptItem } from "./protocol";
import { ThreadView } from "./threads/detail/thread-view";
import { ThreadsPane } from "./threads/threads-pane";

const initialState: Extract<HostToWebviewMessage, { type: "state" }> = {
  font: "ui-monospace, monospace",
  projects: { projects: [], ungrouped: [] },
  threads: { attentionCount: 0, threads: [] },
  type: "state",
};

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState(initialState);
  const [contextItems, setContextItems] = useState<string[]>([]);
  const [threadMaximized, setThreadMaximized] = useState(false);
  const [transcript, setTranscript] = useState<{
    items: RenderedTranscriptItem[];
    streaming: boolean;
    threadId?: string;
  }>({ items: [], streaming: false });
  const previousWorkspace = useRef<string | null>(null);

  useEffect(() => {
    const receive = (event: MessageEvent<HostToWebviewMessage>): void => {
      if (event.data.type === "contextItems") {
        setContextItems(event.data.items);
      } else if (event.data.type === "state") {
        setSnapshot(event.data);
        setTranscript({ items: [], streaming: false });
      } else if (event.data.type === "transcript") {
        const update = event.data;
        setTranscript((current) => {
          const items =
            current.threadId === update.threadId ? current.items : [];
          const index = items.findIndex((item) => item.id === update.item.id);
          return {
            items:
              index === -1
                ? [...items, update.item]
                : items.with(index, update.item),
            streaming: update.streaming,
            threadId: update.threadId,
          };
        });
      }
    };
    window.addEventListener("message", receive);
    postMessage({ type: "ready" });
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--mischief-mono-font",
      snapshot.font
    );
  }, [snapshot.font]);

  const currentWorkspace = useMemo(
    () =>
      [
        ...snapshot.projects.projects.flatMap((project) => project.workspaces),
        ...snapshot.projects.ungrouped,
      ].find((workspace) => workspace.current)?.path,
    [snapshot.projects]
  );
  useEffect(() => {
    if ((currentWorkspace ?? null) === previousWorkspace.current) {
      return;
    }
    previousWorkspace.current = currentWorkspace ?? null;
    setContextItems([]);
    postMessage({ type: "contextItems" });
  }, [currentWorkspace]);

  return (
    <PaneLayout
      projects={<ProjectsPane snapshot={snapshot.projects} />}
      threadMaximized={threadMaximized}
      threads={<ThreadsPane snapshot={snapshot.threads} />}
      thread={
        <ThreadView
          contextItems={contextItems}
          snapshot={snapshot.threads}
          threadMaximized={threadMaximized}
          transcript={transcript}
          onToggleMaximized={() =>
            setThreadMaximized((maximized) => !maximized)
          }
        />
      }
    />
  );
};
