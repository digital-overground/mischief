import { useEffect, useRef, useState } from "react";

import { postMessage } from "./bridge";
import { ButtonTooltip } from "./button-tooltip";
import { NavigatorPane } from "./navigator-pane";
import type { HostToWebviewMessage, RenderedTranscriptItem } from "./protocol";
import { SettingsDialog } from "./settings-dialog";
import { ThreadView } from "./threads/detail/thread-view";

const initialState: Extract<HostToWebviewMessage, { type: "state" }> = {
  font: "ui-monospace, monospace",
  projects: { navigation: { workspaces: [] } },
  threads: { threads: [] },
  type: "state",
};

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState(initialState);
  const [contextItems, setContextItems] = useState<string[]>([]);
  const [expandAllRequest, setExpandAllRequest] = useState(0);
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  const [threadMaximized, setThreadMaximized] = useState(false);
  const [transcript, setTranscript] = useState<{
    items: RenderedTranscriptItem[];
    streaming: boolean;
    threadId?: string;
  }>({ items: [], streaming: false });
  const previousWorkspace = useRef<string | null>(null);
  const selectedThreadId = useRef<string | null>(null);

  useEffect(() => {
    const receive = (event: MessageEvent<HostToWebviewMessage>): void => {
      if (event.data.type === "contextItems") {
        setContextItems(event.data.items);
      } else if (event.data.type === "toggleProjectsMenu") {
        setProjectsMenuOpen((open) => !open);
      } else if (event.data.type === "setAllExpanded") {
        if (event.data.expanded) {
          setExpandAllRequest((request) => request + 1);
        }
        setThreadMaximized(!event.data.expanded);
      } else if (event.data.type === "state") {
        selectedThreadId.current = event.data.threads.selected?.id ?? null;
        setSnapshot(event.data);
        setTranscript({ items: [], streaming: false });
      } else if (event.data.type === "sessionOperation") {
        const { data: update } = event;
        setSnapshot((current) => {
          const { selected } = current.threads;
          if (selected?.id !== update.threadId) {
            return current;
          }
          return {
            ...current,
            threads: {
              ...current.threads,
              selected: {
                ...selected,
                sessionOperation: update.operation,
              },
            },
          };
        });
      } else if (event.data.type === "transcript") {
        const update = event.data;
        if (update.threadId !== selectedThreadId.current) {
          return;
        }
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
    return () => {
      window.removeEventListener("message", receive);
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--mischief-mono-font",
      snapshot.font
    );
  }, [snapshot.font]);

  const currentWorkspace = snapshot.projects.navigation.current?.workspace;
  useEffect(() => {
    if ((currentWorkspace?.path ?? null) === previousWorkspace.current) {
      return;
    }
    previousWorkspace.current = currentWorkspace?.path ?? null;
    setContextItems([]);
    postMessage({ type: "contextItems" });
  }, [currentWorkspace?.path]);

  return (
    <>
      <main>
        <NavigatorPane
          agentIcons={snapshot.agentIcons}
          collapseAll={threadMaximized}
          expandAllRequest={expandAllRequest}
          onDismissProjectsMenu={() => {
            setProjectsMenuOpen(false);
          }}
          onExpand={() => {
            setThreadMaximized(false);
          }}
          onToggleProjectsMenu={() => {
            setProjectsMenuOpen((open) => !open);
          }}
          projects={snapshot.projects}
          projectsMenuOpen={projectsMenuOpen}
          threads={snapshot.threads}
        />
        <ThreadView
          agentIcons={snapshot.agentIcons}
          contextItems={contextItems}
          setup={snapshot.setup}
          snapshot={snapshot.threads}
          transcript={transcript}
        />
      </main>
      <SettingsDialog icons={snapshot.agentIcons} />
      <ButtonTooltip />
    </>
  );
};
