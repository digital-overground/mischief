import { useEffect, useMemo, useRef, useState } from "react";

import { postMessage } from "./bridge";
import { ButtonTooltip } from "./button-tooltip";
import { SvgIcon } from "./icon";
import { NavigatorPane } from "./navigator-pane";
import type {
  AgentSetting,
  HostToWebviewMessage,
  RenderedTranscriptItem,
} from "./protocol";
import { ThreadView } from "./threads/detail/thread-view";

const agentStatus: Record<AgentSetting["state"], string> = {
  checking: "Checking for updates…",
  current: "Up to date",
  installing: "Installing…",
  missing: "Not installed",
  newer: "Newer than published release",
  unknown: "Could not check for updates",
  updateAvailable: "Update available",
  waiting: "Not connected yet",
};

const initialState: Extract<HostToWebviewMessage, { type: "state" }> = {
  font: "ui-monospace, monospace",
  projects: { projects: [], ungrouped: [] },
  threads: { threads: [] },
  type: "state",
};

export const App = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState(initialState);
  const [assignWorkspaceColors, setAssignWorkspaceColors] = useState(true);
  const [agents, setAgents] = useState<AgentSetting[]>([]);
  const [contextItems, setContextItems] = useState<string[]>([]);
  const [expandAllRequest, setExpandAllRequest] = useState(0);
  const [threadMaximized, setThreadMaximized] = useState(false);
  const [transcript, setTranscript] = useState<{
    items: RenderedTranscriptItem[];
    streaming: boolean;
    threadId?: string;
  }>({ items: [], streaming: false });
  const previousWorkspace = useRef<string | null>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const receive = (event: MessageEvent<HostToWebviewMessage>): void => {
      if (event.data.type === "showSettings") {
        setAssignWorkspaceColors(event.data.assignWorkspaceColors);
        setAgents(event.data.agents);
        const dialog = settingsDialog.current;
        if (dialog && !dialog.open) {
          dialog.showModal();
        }
      } else if (event.data.type === "agents") {
        setAgents(event.data.agents);
      } else if (event.data.type === "contextItems") {
        setContextItems(event.data.items);
      } else if (event.data.type === "setAllExpanded") {
        if (event.data.expanded) {
          setExpandAllRequest((request) => request + 1);
        }
        setThreadMaximized(!event.data.expanded);
      } else if (event.data.type === "state") {
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
    <>
      <main>
        <NavigatorPane
          collapseAll={threadMaximized}
          expandAllRequest={expandAllRequest}
          projects={snapshot.projects}
          threads={snapshot.threads}
          onExpand={() => {
            setThreadMaximized(false);
          }}
        />
        <ThreadView
          contextItems={contextItems}
          setup={snapshot.setup}
          snapshot={snapshot.threads}
          threadMaximized={threadMaximized}
          transcript={transcript}
          onToggleMaximized={() => {
            if (threadMaximized) {
              setExpandAllRequest((request) => request + 1);
            }
            setThreadMaximized(!threadMaximized);
          }}
        />
      </main>
      <dialog
        id="settings-dialog"
        ref={settingsDialog}
        aria-labelledby="settings-title"
      >
        <div className="settings-header">
          <h2 id="settings-title">Mischief Settings</h2>
          <button
            className="icon"
            type="button"
            title="Close Settings"
            aria-label="Close Settings"
            onClick={() => settingsDialog.current?.close()}
          >
            ×
          </button>
        </div>
        <label className="settings-option">
          <input
            type="checkbox"
            checked={assignWorkspaceColors}
            aria-describedby="assign-workspace-colors-description"
            onChange={(event) => {
              const value = event.currentTarget.checked;
              setAssignWorkspaceColors(value);
              postMessage({ type: "setAssignWorkspaceColors", value });
            }}
          />
          <span>
            <span className="settings-name">
              Assign Workspace window colors
            </span>
            <span
              className="settings-description"
              id="assign-workspace-colors-description"
            >
              Automatically assigns colors from the active theme to Workspace
              windows that do not already define them.
            </span>
          </span>
        </label>
        <section className="settings-agents" aria-labelledby="agents-title">
          <h3 id="agents-title">Agents</h3>
          <div aria-live="polite">
            {agents.map((agent) => (
              <div className="settings-agent" key={agent.id}>
                <span className="settings-name">{agent.name}</span>
                <span className="settings-description">
                  {agent.installedVersion === undefined
                    ? ""
                    : `Installed ${agent.installedVersion} · `}
                  {agent.latestVersion === undefined
                    ? ""
                    : `Latest ${agent.latestVersion} · `}
                  {agent.error ?? agentStatus[agent.state]}
                </span>
                <button
                  className={`action${agent.managed === true ? "" : " primary"}`}
                  type="button"
                  aria-label={
                    agent.managed === true
                      ? `Check ${agent.name} for updates`
                      : `Install ${agent.name} managed`
                  }
                  disabled={
                    agent.state === "checking" || agent.state === "installing"
                  }
                  onClick={() => {
                    postMessage({
                      id: agent.id,
                      type:
                        agent.managed === true ? "checkAgent" : "installAgent",
                    });
                  }}
                >
                  {agent.managed === true ? null : (
                    <SvgIcon
                      className="interaction-action-icon"
                      kind="download"
                    />
                  )}
                  {agent.managed === true
                    ? "Check for updates"
                    : "Install managed"}
                </button>
              </div>
            ))}
          </div>
          <p className="settings-description">
            Managed Agents install in Mischief storage. After you approve an
            install, Mischief updates it automatically; running Threads keep
            their current process.
          </p>
        </section>
      </dialog>
      <ButtonTooltip />
    </>
  );
};
