/* oxlint-disable unicorn/require-post-message-target-origin -- WebKit's message handler accepts one payload, not window.postMessage's origin */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { SvgIcon } from "../shared/icons/icon";

interface Thread {
  id: string;
  name: string;
  status: string;
  unread: boolean;
  updatedAt: string;
}
interface Workspace {
  path: string;
  projectRoot: string | null;
  name: string;
  threads: Thread[];
}
interface Library {
  type: "library";
  workspaces: Workspace[];
  attention: number;
}
interface State {
  type: "state";
  host: "running" | "stopped";
  pid: number | null;
  badge: number;
  view: "home" | "diagnostic";
  permission: string;
}
interface Command {
  type: "command";
  action:
    | "notify"
    | "restart"
    | "refresh"
    | "openWorkspace"
    | "openThread"
    | "addWorkspace"
    | "deactivateWorkspace";
  path?: string;
  threadId?: string;
}

declare global {
  interface Window {
    webkit: {
      messageHandlers: {
        diagnostic: { postMessage: (message: Command) => void };
      };
    };
    receiveDiagnostic: (message: unknown) => void;
    selectThread: (workspace: string, threadId: string) => void;
    pendingThreadId?: string;
    libraryReady?: boolean;
    pendingLibrary?: Library;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isThread = (value: unknown): value is Thread =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  typeof value.status === "string" &&
  typeof value.unread === "boolean" &&
  typeof value.updatedAt === "string";
const isWorkspace = (value: unknown): value is Workspace =>
  isRecord(value) &&
  typeof value.path === "string" &&
  typeof value.name === "string" &&
  (value.projectRoot === null || typeof value.projectRoot === "string") &&
  Array.isArray(value.threads) &&
  value.threads.every((thread: unknown) => isThread(thread));
const isLibrary = (value: unknown): value is Library =>
  isRecord(value) &&
  value.type === "library" &&
  Array.isArray(value.workspaces) &&
  value.workspaces.every((workspace: unknown) => isWorkspace(workspace)) &&
  typeof value.attention === "number";
const isState = (value: unknown): value is State =>
  isRecord(value) &&
  value.type === "state" &&
  (value.host === "running" || value.host === "stopped") &&
  (value.pid === null || typeof value.pid === "number") &&
  typeof value.badge === "number" &&
  (value.view === "home" || value.view === "diagnostic") &&
  typeof value.permission === "string";
const send = (
  action: Command["action"],
  path?: string,
  threadId?: string
): void => {
  window.webkit.messageHandlers.diagnostic.postMessage({
    action,
    path,
    threadId,
    type: "command",
  });
};

interface WorkspaceRowProps {
  workspace: Workspace;
  selected: string | null;
  onSelect: (id: string) => void;
}
const WorkspaceRow = ({ workspace, selected, onSelect }: WorkspaceRowProps) => (
  <li className="workspace">
    <div className="workspace-heading">
      <button
        className="link workspace-link"
        onClick={() => {
          send("openWorkspace", workspace.path);
        }}
      >
        <SvgIcon kind="folder" /> {workspace.name} ↗
      </button>
      <button
        className="link"
        onClick={() => {
          send("deactivateWorkspace", workspace.path);
        }}
        aria-label={`Deactivate ${workspace.name}`}
        title="Deactivate Workspace"
      >
        <SvgIcon kind="archive" /> Deactivate
      </button>
    </div>
    <span className="workspace-path" title={workspace.path}>
      {workspace.path}
    </span>
    <ul>
      {workspace.threads.map((thread) => {
        const status =
          thread.unread && thread.status === "idle" ? "unread" : thread.status;
        return (
          <li key={thread.id}>
            <button
              className="link thread-link"
              aria-current={selected === thread.id ? "true" : undefined}
              onClick={() => {
                onSelect(thread.id);
              }}
            >
              <SvgIcon kind="chat" />
              <span className={`thread-status ${status}`} aria-hidden="true" />
              <span className="thread-name">{thread.name}</span>
              <span className="thread-state">{status}</span>
            </button>
          </li>
        );
      })}
    </ul>
  </li>
);

// oxlint-disable-next-line complexity -- this single companion screen chooses among loading, empty, and grouped states
const App = () => {
  const [state, setState] = useState<State | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    window.selectThread = (_workspace, id) => {
      setSelected(id);
    };
    if (window.pendingThreadId !== undefined) {
      setSelected(window.pendingThreadId);
    }
    window.receiveDiagnostic = (message: unknown) => {
      if (isLibrary(message)) {
        window.libraryReady = true;
        setLibrary(message);
      } else if (isState(message)) {
        setState(message);
      }
    };
    if (window.pendingLibrary !== undefined) {
      window.receiveDiagnostic(window.pendingLibrary);
      delete window.pendingLibrary;
    }
    send("restart");
    return () => {
      delete (window as Partial<Window>).receiveDiagnostic;
      delete (window as Partial<Window>).selectThread;
    };
  }, []);
  const selectedWorkspace = library?.workspaces.find((w) =>
    w.threads.some((t) => t.id === selected)
  );
  const selectedThread = selectedWorkspace?.threads.find(
    (t) => t.id === selected
  );
  const projects = new Map<string, Workspace[]>();
  for (const workspace of library?.workspaces ?? []) {
    if (workspace.projectRoot !== null) {
      projects.set(workspace.projectRoot, [
        ...(projects.get(workspace.projectRoot) ?? []),
        workspace,
      ]);
    }
  }
  const untracked =
    library?.workspaces.filter((w) => w.projectRoot === null) ?? [];
  const rows = (workspaces: Workspace[]) =>
    workspaces.map((workspace) => (
      <WorkspaceRow
        key={workspace.path}
        workspace={workspace}
        selected={selected}
        onSelect={setSelected}
      />
    ));
  let contents = <p>Loading Default VS Code profile…</p>;
  if (library !== null) {
    contents =
      library.workspaces.length === 0 ? (
        <p>No active Workspaces in the Default VS Code profile.</p>
      ) : (
        <>
          {[...projects].map(([root, workspaces]) => (
            <section key={root}>
              <h2 title={root}>
                <SvgIcon kind="folderGit2" /> {root.split("/").at(-1) ?? root}
              </h2>
              <ul>{rows(workspaces)}</ul>
            </section>
          ))}
          {untracked.length > 0 && (
            <section>
              <h2>
                <SvgIcon kind="folder" /> Untracked Workspaces
              </h2>
              <ul>{rows(untracked)}</ul>
            </section>
          )}
        </>
      );
  }
  return (
    <main>
      <header className="toolbar">
        <h1>Mischief</h1>
        <span
          className="count"
          aria-label={`${library?.attention ?? 0} Threads needing attention`}
        >
          {library?.attention ?? 0} need attention
        </span>
        <button
          className="action"
          disabled={state?.host !== "running"}
          onClick={() => {
            send("refresh");
          }}
        >
          <SvgIcon kind="history" /> Refresh
        </button>
        <button
          className="action primary"
          disabled={state?.host !== "running"}
          onClick={() => {
            send("addWorkspace");
          }}
        >
          <SvgIcon kind="plus" /> Add Workspace…
        </button>
        {state?.host === "stopped" && (
          <button
            className="action"
            onClick={() => {
              send("restart");
            }}
          >
            <SvgIcon kind="history" /> Restart Host
          </button>
        )}
      </header>
      <div className="library">
        <nav
          className="navigator"
          aria-label="Projects, Workspaces, and Threads"
        >
          {contents}
        </nav>
        <section className="detail" aria-label="Selected Thread">
          {selectedThread && selectedWorkspace ? (
            <>
              <h2>{selectedThread.name}</h2>
              <p>
                {selectedWorkspace.name} ·{" "}
                <span className="status-text">
                  {selectedThread.unread && selectedThread.status === "idle"
                    ? "unread"
                    : selectedThread.status}
                </span>
              </p>
              <p className="hint">
                VS Code owns this Thread. Open it there to read, respond, or
                continue working.
              </p>
              <button
                className="action primary"
                onClick={() => {
                  send("openThread", selectedWorkspace.path, selectedThread.id);
                }}
              >
                <SvgIcon kind="chat" /> Open in VS Code ↗
              </button>
            </>
          ) : (
            <p className="hint">
              Select a Thread to see its status and open it in VS Code.
            </p>
          )}
        </section>
      </div>
      <details className="diagnostics">
        <summary>Diagnostics · Host {state?.host ?? "connecting"}</summary>
        <p>
          PID: {state?.pid ?? "—"} · View: {state?.view ?? "—"} · Badge:{" "}
          {state?.badge ?? "—"} · Notification permission:{" "}
          {state?.permission ?? "checking"}
        </p>
        <button
          className="action"
          disabled={state?.host !== "running"}
          onClick={() => {
            send("notify");
          }}
        >
          <SvgIcon kind="alert" /> Test notification
        </button>
      </details>
    </main>
  );
};

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Mischief page is missing its root element");
}
createRoot(root).render(<App />);
