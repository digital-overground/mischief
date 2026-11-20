/* oxlint-disable unicorn/require-post-message-target-origin, promise/prefer-await-to-callbacks, promise/prefer-await-to-then, eslint/no-nested-ternary, eslint/no-negated-condition, unicorn/no-negated-condition, eslint/prefer-destructuring -- WebKit uses a one-argument bridge; React event handlers deliberately start correlated Host requests. */
import type {
  CreateElicitationRequest,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import MarkdownIt from "markdown-it";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  elicitationInteraction,
  permissionInteraction,
} from "../shared/acp/interactions";
import {
  reduceTranscriptUpdate,
  translateTranscriptUpdate,
} from "../shared/acp/transcript";
import agentConfig from "../shared/agents/config.json";
import { SvgIcon } from "../shared/icons/icon";
import { ConfigControl } from "../shared/webview/config-control";
import {
  Interaction,
  InteractionQuestion,
  respondToElicitation,
} from "../shared/webview/thread/interaction";
import type {
  ThreadInteraction,
  ThreadInteractionResponse,
} from "../shared/webview/thread/types";
import type { TranscriptAction } from "../shared/webview/transcript/actions";
import { Transcript } from "../shared/webview/transcript/transcript";
import type { RenderedTranscriptItem } from "../shared/webview/transcript/types";

type AgentId = keyof typeof agentConfig;
const isAgentId = (value: string): value is AgentId =>
  Object.hasOwn(agentConfig, value);
interface PromptImage {
  data: string;
  mimeType: string;
}
interface Thread {
  agentId?: AgentId;
  configOptions?: SessionConfigOption[] | null;
  error?: string;
  id: string;
  name: string;
  owner: "host" | null;
  status: string;
  unread: boolean;
  updatedAt: string;
  workspace?: string;
}
interface Workspace {
  name: string;
  path: string;
  projectRoot: string | null;
  threads: Thread[];
}
interface Library {
  attention: number;
  type: "library";
  workspaces: Workspace[];
}
interface State {
  badge: number;
  host: "running" | "stopped";
  permission: string;
  pid: number | null;
  type: "state";
  view: "home" | "diagnostic";
}
interface HostThreadsMessage {
  threads: Thread[];
  type: "threads";
}
interface Command extends Record<string, unknown> {
  action: string;
  requestId?: string;
  type: "command";
}
interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
}
interface TranscriptPage {
  cursor: number | null;
  events: unknown[];
}
interface DiffPreview {
  newText: string;
  oldText?: string;
  path: string;
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

const markdown = new MarkdownIt({ breaks: true, html: false, linkify: true });
const pending = new Map<string, PendingRequest>();
let requestNumber = 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const transcriptPage = (value: unknown): TranscriptPage => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.events) ||
    (value.cursor !== null &&
      (typeof value.cursor !== "number" ||
        !Number.isSafeInteger(value.cursor) ||
        value.cursor < 0))
  ) {
    throw new Error("Mischief Host returned an invalid transcript page");
  }
  return { cursor: value.cursor, events: value.events };
};
const send = (action: string, values: Record<string, unknown> = {}): void => {
  window.webkit.messageHandlers.diagnostic.postMessage({
    action,
    type: "command",
    ...values,
  });
};
const request = async <T,>(
  action: string,
  values: Record<string, unknown> = {}
): Promise<T> => {
  requestNumber += 1;
  const requestId = `mac:${requestNumber}`;
  // oxlint-disable-next-line promise/avoid-new -- Host results resolve protocol-correlated requests.
  const result = new Promise<unknown>((resolve, reject) => {
    pending.set(requestId, { reject, resolve });
  });
  try {
    send(action, { ...values, requestId });
  } catch (error) {
    pending
      .get(requestId)
      ?.reject(error instanceof Error ? error : new Error(String(error)));
    pending.delete(requestId);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- callers provide the result type for their correlated Host command.
  return (await result) as T;
};
const isThread = (value: unknown): value is Thread =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  typeof value.status === "string" &&
  typeof value.updatedAt === "string";
const isWorkspace = (value: unknown): value is Workspace =>
  isRecord(value) &&
  typeof value.path === "string" &&
  typeof value.name === "string" &&
  (value.projectRoot === null || typeof value.projectRoot === "string") &&
  Array.isArray(value.threads) &&
  value.threads.every(isThread);
const isLibrary = (value: unknown): value is Library =>
  isRecord(value) &&
  value.type === "library" &&
  typeof value.attention === "number" &&
  Array.isArray(value.workspaces) &&
  value.workspaces.every(isWorkspace);
const isState = (value: unknown): value is State =>
  isRecord(value) &&
  value.type === "state" &&
  (value.host === "running" || value.host === "stopped") &&
  (value.pid === null || typeof value.pid === "number") &&
  typeof value.badge === "number" &&
  (value.view === "home" || value.view === "diagnostic") &&
  typeof value.permission === "string";
const isHostThreads = (value: unknown): value is HostThreadsMessage =>
  isRecord(value) &&
  value.type === "threads" &&
  Array.isArray(value.threads) &&
  value.threads.every(
    (thread) => isThread(thread) && typeof thread.workspace === "string"
  );

const appendTranscript = (
  items: RenderedTranscriptItem[],
  event: unknown,
  copy = true
): RenderedTranscriptItem[] => {
  if (!isRecord(event) || !isRecord(event.update)) {
    return items;
  }
  // The Host forwards values already parsed by the ACP SDK.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the private protocol carries the SDK value unchanged.
  const update = translateTranscriptUpdate(event.update as SessionUpdate);
  if (update === undefined) {
    return items;
  }
  const next = copy ? items.map((item) => ({ ...item })) : items;
  const changed = reduceTranscriptUpdate(next, update);
  if (
    changed?.text !== undefined &&
    changed.kind !== "tool" &&
    changed.kind !== "plan"
  ) {
    changed.html = markdown.render(changed.text);
  }
  return next;
};
const transcriptItems = (events: unknown[]): RenderedTranscriptItem[] => {
  let items: RenderedTranscriptItem[] = [];
  for (const event of events) {
    items = appendTranscript(items, event, false);
  }
  return items;
};
const readImage = async (file: File): Promise<PromptImage> => {
  const source = await file.arrayBuffer();
  let binary = "";
  for (const byte of new Uint8Array(source)) {
    binary += String.fromCodePoint(byte);
  }
  return { data: btoa(binary), mimeType: file.type };
};
const ThreadConfig = ({
  agentId,
  options,
  threadId,
  onError,
}: {
  agentId: AgentId;
  options: SessionConfigOption[];
  threadId: string;
  onError: (message: string) => void;
}): React.JSX.Element => (
  <div className="thread-configs">
    {options.map((option) => (
      <ConfigControl
        agentId={agentId}
        config={option}
        key={`${option.id}:${option.currentValue}`}
        onChange={(value) => {
          void request("threadSetConfig", {
            configId: option.id,
            threadId,
            value,
          }).catch((error: unknown) => {
            onError(error instanceof Error ? error.message : String(error));
          });
        }}
      />
    ))}
  </div>
);

interface WorkspaceRowProps {
  onCreate: (workspace: string, agentId: AgentId) => void;
  onSelect: (id: string) => void;
  selected: string | null;
  workspace: Workspace;
}
const WorkspaceRow = ({
  workspace,
  selected,
  onSelect,
  onCreate,
}: WorkspaceRowProps): React.JSX.Element => {
  const [agentId, setAgentId] = useState<AgentId>("magpi-acp");
  return (
    <li className="workspace">
      <div className="workspace-heading">
        <button
          className="link workspace-link"
          onClick={() => {
            send("openWorkspace", { path: workspace.path });
          }}
          type="button"
        >
          <SvgIcon kind="folder" /> {workspace.name} ↗
        </button>
        <select
          aria-label={`Agent for new Thread in ${workspace.name}`}
          className="new-thread-agent"
          onChange={(event) => {
            if (isAgentId(event.currentTarget.value)) {
              setAgentId(event.currentTarget.value);
            }
          }}
          value={agentId}
        >
          {Object.entries(agentConfig).map(([id, agent]) => (
            <option key={id} value={id}>
              {agent.name}
            </option>
          ))}
        </select>
        <button
          aria-label={`New Thread in ${workspace.name}`}
          className="link"
          onClick={() => {
            onCreate(workspace.path, agentId);
          }}
          title="New Thread"
          type="button"
        >
          <SvgIcon kind="plus" /> New
        </button>
        <button
          aria-label={`Deactivate ${workspace.name}`}
          className="link"
          onClick={() => {
            send("deactivateWorkspace", { path: workspace.path });
          }}
          title="Deactivate Workspace"
          type="button"
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
            thread.unread && thread.status === "idle"
              ? "unread"
              : thread.status;
          return (
            <li key={thread.id}>
              <button
                aria-current={selected === thread.id ? "true" : undefined}
                className="link thread-link"
                onClick={() => {
                  onSelect(thread.id);
                }}
                type="button"
              >
                <SvgIcon kind="chat" />
                <span
                  className={`thread-status ${status}`}
                  aria-hidden="true"
                />
                <span className="thread-name">{thread.name}</span>
                <span className="thread-state">{status}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </li>
  );
};

const respondToInteraction = async (
  threadId: string,
  interactionId: string,
  kind: ThreadInteraction["kind"],
  response: ThreadInteractionResponse
): Promise<void> => {
  // oxlint-disable-next-line unicorn/prefer-ternary -- each ACP interaction uses a different Host command and response envelope.
  if (kind === "permission") {
    await request("acpRespondPermission", {
      interactionId,
      response:
        response.action === "select"
          ? {
              outcome: {
                optionId: response.optionId,
                outcome: "selected",
              },
            }
          : { outcome: { outcome: "cancelled" } },
      threadId,
    });
  } else {
    await request("acpRespondElicitation", {
      interactionId,
      response:
        response.action === "accept"
          ? { action: "accept", content: response.values }
          : { action: "cancel" },
      threadId,
    });
  }
};

const Composer = ({
  drafts,
  interaction,
  running,
  threadId,
  onDraftsConsumed,
  onError,
}: {
  drafts: string[];
  interaction?: ThreadInteraction;
  onDraftsConsumed: () => void;
  onError: (message: string) => void;
  running: boolean;
  threadId: string;
}): React.JSX.Element => {
  const [text, setText] = useState("");
  useEffect(() => {
    if (drafts.length > 0) {
      setText((current) => [current, ...drafts].filter(Boolean).join("\n\n"));
      onDraftsConsumed();
    }
  }, [drafts, onDraftsConsumed]);
  const [images, setImages] = useState<PromptImage[]>([]);
  const [sending, setSending] = useState(false);
  const submitting = useRef(false);
  const sendRequest = (operation: Promise<unknown>): void => {
    submitting.current = true;
    setSending(true);
    onError("");
    void operation
      .then(() => {
        setText("");
        setImages([]);
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        submitting.current = false;
        setSending(false);
      });
  };
  const submit = (): void => {
    if (submitting.current) {
      return;
    }
    if (interaction?.kind === "elicitation") {
      respondToElicitation(interaction, text, (id, response) => {
        sendRequest(
          respondToInteraction(threadId, id, interaction.kind, response)
        );
      });
    } else if (text.trim().length > 0 || images.length > 0) {
      sendRequest(request("threadPrompt", { images, text, threadId }));
    }
  };
  const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="mac-composer">
      {images.length > 0 ? (
        <div className="composer-images">{images.length} image attached</div>
      ) : null}
      <textarea
        aria-label="Prompt"
        disabled={sending}
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
        onKeyDown={keyDown}
        placeholder={
          interaction?.kind === "elicitation"
            ? "Type your answer…"
            : running
              ? "Queue another prompt…"
              : "Ask the Agent…"
        }
        rows={3}
        value={text}
      />
      <div className="mac-composer-actions">
        <label className="action image-input">
          <SvgIcon kind="plus" /> Image
          <input
            accept="image/*"
            disabled={sending}
            multiple
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              void Promise.all(files.map(readImage)).then((next) => {
                setImages((current) => [...current, ...next].slice(0, 20));
              });
              event.currentTarget.value = "";
            }}
            type="file"
          />
        </label>
        {running && interaction?.kind !== "elicitation" ? (
          <button
            className="action danger"
            onClick={() => {
              void request("threadCancel", { threadId });
            }}
            type="button"
          >
            <SvgIcon kind="stop" /> Stop
          </button>
        ) : null}
        <button
          className="action primary"
          disabled={sending}
          onClick={submit}
          type="button"
        >
          <SvgIcon kind="send" /> {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
};

// oxlint-disable-next-line complexity -- this companion screen coordinates Host snapshots, transcript streaming, and controls.
const App = (): React.JSX.Element => {
  const [state, setState] = useState<State | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [hostThreads, setHostThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<RenderedTranscriptItem[]>([]);
  const [visibleCount, setVisibleCount] = useState(100);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const loadingThread = useRef<string | null>(null);
  const loadedEvents = useRef<unknown[]>([]);
  const olderCursor = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) {
      return;
    }
    if (prepend.current) {
      container.scrollTop =
        prepend.current.top + container.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (stickToBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [transcript, visibleCount]);
  const [interactions, setInteractions] = useState<
    Record<string, ThreadInteraction>
  >({});
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState("");
  const [diff, setDiff] = useState<DiffPreview | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  useEffect(() => {
    window.selectThread = (_workspace, id) => {
      setSelected(id);
    };
    if (window.pendingThreadId !== undefined) {
      setSelected(window.pendingThreadId);
    }
    // oxlint-disable-next-line complexity -- one protocol boundary narrows every Host event before updating UI state.
    window.receiveDiagnostic = (message: unknown) => {
      if (isLibrary(message)) {
        window.libraryReady = true;
        setLibrary(message);
      } else if (isState(message)) {
        setState(message);
        if (message.host === "stopped") {
          for (const waiting of pending.values()) {
            waiting.reject(new Error("Mischief Host disconnected"));
          }
          pending.clear();
        }
      } else if (isHostThreads(message)) {
        setHostThreads(message.threads);
      } else if (isRecord(message) && message.type === "result") {
        const requestId = message.requestId;
        if (typeof requestId === "string") {
          const waiting = pending.get(requestId);
          pending.delete(requestId);
          if (typeof message.error === "string") {
            waiting?.reject(new Error(message.error));
          } else {
            waiting?.resolve(message.value);
          }
        }
      } else if (
        isRecord(message) &&
        message.type === "acpUpdate" &&
        message.threadId === selectedRef.current &&
        loadingThread.current !== message.threadId
      ) {
        loadedEvents.current.push(message);
        setTranscript((current) => appendTranscript(current, message));
      } else if (
        isRecord(message) &&
        (message.type === "acpPermission" ||
          message.type === "acpElicitation") &&
        typeof message.threadId === "string" &&
        typeof message.interactionId === "string" &&
        isRecord(message.request)
      ) {
        const threadId = message.threadId;
        try {
          const interaction =
            message.type === "acpPermission"
              ? permissionInteraction(
                  message.interactionId,
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Host forwards the validated ACP SDK request.
                  message.request as RequestPermissionRequest
                )
              : elicitationInteraction(
                  message.interactionId,
                  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Host forwards the validated ACP SDK request.
                  message.request as Extract<
                    CreateElicitationRequest,
                    { mode: "form" }
                  >
                );
          setInteractions((current) => ({
            ...current,
            [threadId]: interaction,
          }));
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      } else if (
        isRecord(message) &&
        message.type === "acpInteractionResolved" &&
        typeof message.interactionId === "string"
      ) {
        setInteractions((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([, interaction]) => interaction.id !== message.interactionId
            )
          )
        );
      } else if (
        isRecord(message) &&
        (message.type === "threadPromptComplete" ||
          message.type === "threadPromptError") &&
        typeof message.threadId === "string"
      ) {
        const threadId = message.threadId;
        setInteractions((current) => {
          const { [threadId]: _removed, ...next } = current;
          return next;
        });
      } else if (
        isRecord(message) &&
        message.type === "threadQueueCleared" &&
        typeof message.threadId === "string" &&
        message.threadId === selectedRef.current &&
        Array.isArray(message.drafts) &&
        message.drafts.every((draft) => typeof draft === "string")
      ) {
        const threadId = message.threadId;
        const returned = message.drafts.filter(
          (draft): draft is string => typeof draft === "string"
        );
        setDrafts((current) => ({
          ...current,
          [threadId]: returned,
        }));
        setNotice(
          `Stopped. ${returned.length} queued prompt(s) were returned.`
        );
      } else if (
        isRecord(message) &&
        message.type === "error" &&
        typeof message.message === "string"
      ) {
        setNotice(message.message);
      }
    };
    if (window.pendingLibrary !== undefined) {
      window.receiveDiagnostic(window.pendingLibrary);
      delete window.pendingLibrary;
    }
    send("ready");
    return () => {
      for (const waiting of pending.values()) {
        waiting.reject(new Error("macOS app closed"));
      }
      pending.clear();
      delete (window as Partial<Window>).receiveDiagnostic;
      delete (window as Partial<Window>).selectThread;
    };
  }, []);

  const workspaces = useMemo(
    () =>
      (library?.workspaces ?? []).map((workspace) => ({
        ...workspace,
        threads: [
          ...workspace.threads.filter((thread) => thread.owner !== "host"),
          ...hostThreads
            .filter((thread) => thread.workspace === workspace.path)
            .map((thread) => ({ ...thread, owner: "host" as const }))
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        ],
      })),
    [hostThreads, library]
  );
  const selectedWorkspace = workspaces.find((workspace) =>
    workspace.threads.some((thread) => thread.id === selected)
  );
  const selectedThread = selectedWorkspace?.threads.find(
    (thread) => thread.id === selected
  );
  useEffect(() => {
    let cancelled = false;
    setTranscript([]);
    loadedEvents.current = [];
    olderCursor.current = null;
    loadingOlder.current = false;
    setVisibleCount(100);
    stickToBottom.current = true;
    prepend.current = null;
    setNotice("");
    const threadId =
      selectedThread?.owner === "host" ? selectedThread.id : null;
    loadingThread.current = threadId;
    if (threadId !== null) {
      void request<Thread>("threadLoad", { threadId })
        .then(async () => {
          const page = transcriptPage(
            await request<unknown>("threadTranscript", { threadId })
          );
          if (cancelled) {
            return;
          }
          loadingThread.current = null;
          loadedEvents.current = page.events;
          olderCursor.current = page.cursor;
          setTranscript(transcriptItems(page.events));
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }
          loadingThread.current = null;
          setNotice(error instanceof Error ? error.message : String(error));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [selectedThread?.id, selectedThread?.owner]);

  const loadOlder = async (): Promise<void> => {
    const threadId = selectedRef.current;
    const cursor = olderCursor.current;
    if (threadId === null || cursor === null || loadingOlder.current) {
      return;
    }
    loadingOlder.current = true;
    try {
      const page = transcriptPage(
        await request<unknown>("threadTranscript", { cursor, threadId })
      );
      if (selectedRef.current !== threadId) {
        return;
      }
      olderCursor.current = page.cursor;
      loadedEvents.current = [...page.events, ...loadedEvents.current];
      setTranscript(transcriptItems(loadedEvents.current));
      setVisibleCount((count) => count + 100);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      loadingOlder.current = false;
    }
  };

  const createThread = (workspace: string, agentId: AgentId): void => {
    setNotice("");
    void request<Thread>("threadCreate", { agentId, cwd: workspace })
      .then((thread) => {
        setSelected(thread.id);
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
  };
  const transcriptAction = (action: TranscriptAction): void => {
    if (!selectedWorkspace || !selectedThread) {
      return;
    }
    if (action.type === "openDiff") {
      const candidate = transcript
        .flatMap((item) => item.diffs ?? [])
        .find((item) => item.path === action.path);
      if (candidate) {
        setDiff(candidate);
      }
    } else if (action.type === "openLocation") {
      send("openFile", {
        line: action.line,
        path: action.path,
        workspace: selectedWorkspace.path,
      });
    } else if (action.type === "openTranscriptLink") {
      send("openTranscriptLink", {
        href: action.href,
        workspace: selectedWorkspace.path,
      });
    }
  };

  const projects = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    if (workspace.projectRoot !== null) {
      projects.set(workspace.projectRoot, [
        ...(projects.get(workspace.projectRoot) ?? []),
        workspace,
      ]);
    }
  }
  const untracked = workspaces.filter(
    (workspace) => workspace.projectRoot === null
  );
  const rows = (entries: Workspace[]): React.JSX.Element[] =>
    entries.map((workspace) => (
      <WorkspaceRow
        key={workspace.path}
        onCreate={createThread}
        onSelect={setSelected}
        selected={selected}
        workspace={workspace}
      />
    ));
  let contents = <p>Loading Default VS Code profile…</p>;
  if (library !== null) {
    contents =
      workspaces.length === 0 ? (
        <p>No active Workspaces in the Default VS Code profile.</p>
      ) : (
        <>
          {[...projects].map(([root, entries]) => (
            <section key={root}>
              <h2 title={root}>
                <SvgIcon kind="folderGit2" /> {root.split("/").at(-1) ?? root}
              </h2>
              <ul>{rows(entries)}</ul>
            </section>
          ))}
          {untracked.length > 0 ? (
            <section>
              <h2>
                <SvgIcon kind="folder" /> Untracked Workspaces
              </h2>
              <ul>{rows(untracked)}</ul>
            </section>
          ) : null}
        </>
      );
  }

  const interaction = selected === null ? undefined : interactions[selected];
  const running =
    selectedThread?.status === "running" ||
    selectedThread?.status === "waiting";
  return (
    <main>
      <header className="toolbar">
        <h1>Mischief</h1>
        <span
          aria-label={`${library?.attention ?? 0} Threads needing attention`}
          className="count"
        >
          {library?.attention ?? 0} need attention
        </span>
        <button
          className="action"
          disabled={state?.host !== "running"}
          onClick={() => {
            send("refresh");
          }}
          type="button"
        >
          <SvgIcon kind="history" /> Refresh
        </button>
        <button
          className="action primary"
          disabled={state?.host !== "running"}
          onClick={() => {
            send("addWorkspace");
          }}
          type="button"
        >
          <SvgIcon kind="plus" /> Add Workspace…
        </button>
        {state?.host === "stopped" ? (
          <button
            className="action"
            onClick={() => {
              send("restart");
            }}
            type="button"
          >
            <SvgIcon kind="history" /> Restart Host
          </button>
        ) : null}
      </header>
      <div className="library">
        <nav
          aria-label="Projects, Workspaces, and Threads"
          className="navigator"
        >
          {contents}
        </nav>
        <section aria-label="Selected Thread" className="detail">
          {selectedThread && selectedWorkspace ? (
            selectedThread.owner === "host" ? (
              <section className="mac-thread" id="thread">
                <header className="mac-thread-header">
                  <div>
                    <h2>{selectedThread.name}</h2>
                    <span className="thread-agent-name">
                      {selectedThread.agentId !== undefined
                        ? agentConfig[selectedThread.agentId].name
                        : "Agent"}
                    </span>
                  </div>
                </header>
                <div
                  className="mac-transcript"
                  ref={scroll}
                  onScroll={(event) => {
                    const container = event.currentTarget;
                    stickToBottom.current =
                      container.scrollHeight -
                        container.scrollTop -
                        container.clientHeight <
                      80;
                    if (
                      container.scrollTop < 100 &&
                      prepend.current === null &&
                      (olderCursor.current !== null ||
                        visibleCount < transcript.length)
                    ) {
                      prepend.current = {
                        height: container.scrollHeight,
                        top: container.scrollTop,
                      };
                      stickToBottom.current = false;
                      if (olderCursor.current !== null) {
                        void loadOlder();
                      } else {
                        setVisibleCount((count) => count + 100);
                      }
                    }
                  }}
                >
                  {olderCursor.current !== null ? (
                    <button
                      type="button"
                      onClick={() => {
                        const container = scroll.current;
                        if (container) {
                          prepend.current = {
                            height: container.scrollHeight,
                            top: container.scrollTop,
                          };
                          stickToBottom.current = false;
                        }
                        void loadOlder();
                      }}
                    >
                      Load older messages
                    </button>
                  ) : null}
                  <Transcript
                    onAction={transcriptAction}
                    onCopied={() => {
                      setNotice("");
                    }}
                    onSetupOptionChange={() => {
                      setNotice("");
                    }}
                    selected={{
                      id: selectedThread.id,
                      items: transcript,
                      status: selectedThread.status,
                    }}
                    selectedSetupOptions={[]}
                    visibleCount={visibleCount}
                  />
                  {interaction?.kind === "elicitation" ? (
                    <InteractionQuestion interaction={interaction} />
                  ) : null}
                  {notice !== "" || selectedThread.error !== undefined ? (
                    <div className="thread-notice" role="status">
                      {notice !== "" ? notice : selectedThread.error}
                    </div>
                  ) : null}
                  {selectedThread.status === "error" ? (
                    <button
                      className="action primary"
                      onClick={() => {
                        void request("threadRetry", {
                          threadId: selectedThread.id,
                        }).catch((error: unknown) => {
                          setNotice(
                            error instanceof Error
                              ? error.message
                              : String(error)
                          );
                        });
                      }}
                      type="button"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
                {selectedThread.agentId ? (
                  <ThreadConfig
                    agentId={selectedThread.agentId}
                    options={selectedThread.configOptions ?? []}
                    threadId={selectedThread.id}
                    onError={setNotice}
                  />
                ) : null}
                {interaction?.kind === "elicitation" ? (
                  <Interaction
                    interaction={interaction}
                    onCancel={() => {
                      void request("threadCancel", {
                        threadId: selectedThread.id,
                      });
                    }}
                    onRespond={(id, response) => {
                      void respondToInteraction(
                        selectedThread.id,
                        id,
                        interaction.kind,
                        response
                      ).catch((error: unknown) => {
                        setNotice(
                          error instanceof Error ? error.message : String(error)
                        );
                      });
                    }}
                  />
                ) : null}
                <Composer
                  key={selectedThread.id}
                  drafts={drafts[selectedThread.id] ?? []}
                  interaction={interaction}
                  onDraftsConsumed={() => {
                    setDrafts((current) => ({
                      ...current,
                      [selectedThread.id]: [],
                    }));
                  }}
                  onError={setNotice}
                  running={running}
                  threadId={selectedThread.id}
                />
                {interaction?.kind === "permission" ? (
                  <Interaction
                    interaction={interaction}
                    onCancel={() => {
                      void respondToInteraction(
                        selectedThread.id,
                        interaction.id,
                        interaction.kind,
                        { action: "cancel" }
                      ).catch((error: unknown) => {
                        setNotice(
                          error instanceof Error ? error.message : String(error)
                        );
                      });
                    }}
                    onRespond={(id, response) => {
                      void respondToInteraction(
                        selectedThread.id,
                        id,
                        interaction.kind,
                        response
                      ).catch((error: unknown) => {
                        setNotice(
                          error instanceof Error ? error.message : String(error)
                        );
                      });
                    }}
                  />
                ) : null}
              </section>
            ) : (
              <>
                <h2>{selectedThread.name}</h2>
                <p className="hint">
                  VS Code owns this legacy Thread. Open it there to read or
                  continue working.
                </p>
                <button
                  className="action primary"
                  onClick={() => {
                    send("openThread", {
                      path: selectedWorkspace.path,
                      threadId: selectedThread.id,
                    });
                  }}
                  type="button"
                >
                  <SvgIcon kind="chat" /> Open in VS Code ↗
                </button>
              </>
            )
          ) : (
            <p className="hint">
              Select a Thread or create one from a Workspace.
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
      </details>
      {diff ? (
        <div className="diff-overlay" role="presentation">
          <section
            aria-labelledby="diff-title"
            className="diff-dialog"
            role="dialog"
          >
            <header>
              <h2 id="diff-title">{diff.path}</h2>
              <button
                aria-label="Close diff"
                className="action"
                onClick={() => {
                  setDiff(null);
                }}
                type="button"
              >
                <SvgIcon kind="x" /> Close
              </button>
            </header>
            <div className="diff-columns">
              <div>
                <h3>Before</h3>
                <pre>{diff.oldText ?? ""}</pre>
              </div>
              <div>
                <h3>After</h3>
                <pre>{diff.newText}</pre>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
};

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Mischief page is missing its root element");
}
createRoot(root).render(<App />);
