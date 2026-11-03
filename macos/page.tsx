/* oxlint-disable unicorn/require-post-message-target-origin -- WebKit's message handler accepts one payload, not window.postMessage's origin */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

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
  <li>
    <button
      onClick={() => {
        send("openWorkspace", workspace.path);
      }}
    >
      {workspace.name} ↗ VS Code
    </button>{" "}
    <small>{workspace.path}</small>{" "}
    <button
      onClick={() => {
        send("deactivateWorkspace", workspace.path);
      }}
    >
      Deactivate
    </button>
    <ul>
      {workspace.threads.map((thread) => (
        <li key={thread.id}>
          <button
            aria-current={selected === thread.id ? "true" : undefined}
            onClick={() => {
              onSelect(thread.id);
            }}
          >
            {thread.name} — {thread.status}
            {thread.unread ? " · unread" : ""}
          </button>{" "}
          <button
            onClick={() => {
              send("openThread", workspace.path, thread.id);
            }}
          >
            Open in VS Code
          </button>
        </li>
      ))}
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
  const selectedThread = library?.workspaces
    .flatMap((w) => w.threads)
    .find((t) => t.id === selected);
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
              <h2>Project: {root}</h2>
              <ul>{rows(workspaces)}</ul>
            </section>
          ))}
          {untracked.length > 0 && (
            <section>
              <h2>Untracked Workspaces</h2>
              <ul>{rows(untracked)}</ul>
            </section>
          )}
        </>
      );
  }
  return (
    <main>
      <h1>Mischief</h1>
      <p>
        Host: {state?.host ?? "connecting"}{" "}
        {state?.pid === null || state?.pid === undefined
          ? ""
          : `(PID ${state.pid})`}{" "}
        · Threads needing attention: {library?.attention ?? "—"}
      </p>
      <button
        disabled={state?.host !== "running"}
        onClick={() => {
          send("refresh");
        }}
      >
        Refresh
      </button>{" "}
      <button
        disabled={state?.host !== "running"}
        onClick={() => {
          send("addWorkspace");
        }}
      >
        Add Workspace…
      </button>{" "}
      <button
        disabled={state?.host !== "stopped"}
        onClick={() => {
          send("restart");
        }}
      >
        Restart Host
      </button>
      {selectedThread && (
        <section>
          <h2>{selectedThread.name}</h2>
          <p>
            Status: {selectedThread.status}. Continue this Thread in VS Code.
          </p>
        </section>
      )}
      {contents}
      <details>
        <summary>Diagnostic controls</summary>
        <p>
          View: {state?.view ?? "—"} · Badge: {state?.badge ?? "—"} ·
          Notification permission: {state?.permission ?? "checking"}
        </p>
        <button
          disabled={state?.host !== "running"}
          onClick={() => {
            send("notify");
          }}
        >
          Notify diagnostic view
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
