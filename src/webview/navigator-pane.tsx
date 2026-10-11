import { memo, useEffect, useRef, useState } from "react";

import { isNonEmpty } from "../present";
import type { ProjectsSnapshot, Workspace } from "../projects/projects";
import type { ThreadIndicator, ThreadSummary } from "../threads/threads/models";
import { postMessage } from "./bridge";
import { SvgIcon } from "./icon";
import type { RenderedThreadsSnapshot } from "./protocol";

const IconButton = ({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: React.MouseEventHandler<HTMLButtonElement>;
  title: string;
}): React.JSX.Element => (
  <button className="icon" title={title} aria-label={title} onClick={onClick}>
    {children}
  </button>
);

export const indicatorLabel = (kind: ThreadIndicator): string => {
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

export const StatusIndicator = ({
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

const menuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const index = items.findIndex((item) =>
    item.contains(document.activeElement)
  );
  if (index === -1) {
    items[event.key === "ArrowDown" ? 0 : items.length - 1]?.focus();
    return;
  }
  items[
    (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
  ]?.focus();
};

const WorkspaceMenu = ({
  close,
  dismiss,
  position,
  projectRoot,
}: {
  close: () => void;
  dismiss: () => void;
  position: { left: number; top: number };
  projectRoot?: string;
}): React.JSX.Element => (
  <div
    className="workspace-menu"
    role="menu"
    aria-label="Workspace actions"
    style={position}
    onKeyDown={menuKeyDown}
  >
    {isNonEmpty(projectRoot) ? (
      <>
        <button
          autoFocus
          type="button"
          role="menuitem"
          onClick={() => {
            postMessage({ path: projectRoot, type: "openIssues" });
            dismiss();
          }}
        >
          <SvgIcon kind="folderGit2" /> Start work on issue
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            postMessage({ path: projectRoot, type: "newWorkspace" });
            dismiss();
          }}
        >
          <SvgIcon kind="plus" /> Add Workspace
        </button>
      </>
    ) : null}
    <button
      autoFocus={!isNonEmpty(projectRoot)}
      type="button"
      role="menuitem"
      onClick={() => {
        postMessage({ type: "threadHistory" });
        dismiss();
      }}
    >
      <SvgIcon kind="history" /> Thread History
    </button>
    <hr />
    <button type="button" role="menuitem" onClick={close}>
      <SvgIcon kind="x" /> Close Workspace
    </button>
  </div>
);

const RemoteWorkspaceMenu = ({
  close,
  dismiss,
  path,
  position,
  threads,
}: {
  close: () => void;
  dismiss: () => void;
  path: string;
  position: { left: number; top: number };
  threads: ThreadSummary[];
}): React.JSX.Element => (
  <div
    className="workspace-menu"
    role="menu"
    aria-label="Workspace actions"
    style={position}
    onKeyDown={menuKeyDown}
  >
    <button
      autoFocus
      type="button"
      role="menuitem"
      onClick={() => {
        postMessage({ path, type: "openWorkspace" });
        dismiss();
      }}
    >
      <SvgIcon kind="externalLink" /> Go to Window
    </button>
    <hr />
    {threads.map((thread) => (
      <button
        key={thread.id}
        type="button"
        role="menuitem"
        onClick={() => {
          postMessage({ id: thread.id, type: "selectThread" });
          dismiss();
        }}
      >
        <SvgIcon kind="botMessageSquare" />{" "}
        <span className="workspace-menu-title">{thread.name}</span>
      </button>
    ))}
    {threads.length ? <hr /> : null}
    <button type="button" role="menuitem" onClick={close}>
      <SvgIcon kind="x" /> Remove Workspace
    </button>
  </div>
);

const ThreadMenu = ({
  dismiss,
  id,
  position,
}: {
  dismiss: () => void;
  id: string;
  position: { left: number; top: number };
}): React.JSX.Element => (
  <div
    className="workspace-menu"
    role="menu"
    aria-label="Thread actions"
    style={position}
    onKeyDown={menuKeyDown}
  >
    <button
      autoFocus
      type="button"
      role="menuitem"
      onClick={() => {
        postMessage({ id, type: "renameThread" });
        dismiss();
      }}
    >
      <SvgIcon kind="pencil" /> Rename Thread
    </button>
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        postMessage({ id, type: "removeThread" });
        dismiss();
      }}
    >
      <SvgIcon kind="archive" /> Close Thread
    </button>
  </div>
);

// oxlint-disable-next-line complexity -- Workspace and Thread row actions share the menu state
const WorkspaceNode = ({
  actionsMenuOpen,
  expanded,
  now,
  onToggle,
  projectRoot,
  selectedId,
  threads,
  workspace,
}: {
  actionsMenuOpen: boolean;
  expanded: boolean;
  now: number;
  onToggle: () => void;
  projectRoot?: string;
  selectedId?: string | null;
  threads: ThreadSummary[];
  workspace: Workspace;
}): React.JSX.Element => {
  const [closing, setClosing] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    left: number;
    top: number;
    threadId?: string;
  } | null>(null);
  useEffect(() => {
    if (actionsMenuOpen) {
      setMenu(null);
    }
  }, [actionsMenuOpen]);
  useEffect(() => {
    const dismissOutside = (event: MouseEvent): void => {
      if (
        menu === null ||
        (event.target instanceof Element &&
          event.target
            .closest('.workspace-menu, [aria-haspopup="menu"]')
            ?.closest(".workspace-node") === nodeRef.current)
      ) {
        return;
      }
      setMenu(null);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenu(null);
      }
    };
    document.addEventListener("click", dismissOutside, true);
    document.addEventListener("contextmenu", dismissOutside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", dismissOutside, true);
      document.removeEventListener("contextmenu", dismissOutside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const showMenu = (x: number, y: number, threadId?: string): void => {
    setMenu({
      left: Math.max(4, Math.min(x, window.innerWidth - 216)),
      top: Math.max(
        4,
        Math.min(
          y,
          window.innerHeight -
            Math.min(
              window.innerHeight - 8,
              workspace.current ? 152 : (threads.length + 3) * 29
            )
        )
      ),
      ...(isNonEmpty(threadId) ? { threadId } : {}),
    });
  };
  const closeWorkspace = (): void => {
    setMenu(null);
    setClosing(true);
    postMessage({ path: workspace.path, type: "closeWorkspace" });
  };
  const attention = (["waiting", "error", "completed"] as const).filter(
    (indicator) => threads.some((thread) => thread.indicator === indicator)
  );
  const workspaceAction = workspace.current
    ? `${expanded ? "Collapse" : "Expand"} ${workspace.name}`
    : `Open ${workspace.name} Window`;
  const threadCountLabel = `Agent Threads: ${threads.length}`;
  return (
    <div
      ref={nodeRef}
      className={`workspace-node${workspace.current ? " current" : ""}${closing ? " closing" : ""}`}
    >
      <div
        aria-busy={closing}
        className={`row workspace-row${workspace.current && !expanded ? " selected" : ""}${closing ? " closing" : ""}`}
        onContextMenu={(event) => {
          if (!closing) {
            event.preventDefault();
            showMenu(event.clientX, event.clientY);
          }
        }}
      >
        {workspace.current ? (
          <button
            className="workspace-disclosure workspace-toggle"
            type="button"
            disabled={closing}
            title={workspaceAction}
            aria-label={workspaceAction}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span
            aria-hidden="true"
            className="workspace-disclosure workspace-disclosure-placeholder"
          />
        )}
        <button
          className="row-open workspace-open"
          type="button"
          disabled={closing}
          title={workspaceAction}
          aria-label={workspaceAction}
          onClick={() => {
            if (workspace.current) {
              onToggle();
            } else {
              postMessage({ path: workspace.path, type: "openWorkspace" });
            }
          }}
        >
          {isNonEmpty(workspace.color) ? (
            <span
              aria-hidden="true"
              className="workspace-color"
              style={{ backgroundColor: workspace.color }}
            />
          ) : null}
          <span className="workspace-label">
            <span className="name">{workspace.name}</span>
            {isNonEmpty(workspace.branch) ? (
              <span className="workspace-branch">
                <SvgIcon className="workspace-branch-icon" kind="gitBranch" />
                {workspace.branch}
              </span>
            ) : null}
          </span>
          <span className="workspace-statuses">
            {attention.map((indicator) => (
              <StatusIndicator kind={indicator} key={indicator} />
            ))}
          </span>
        </button>
        <span
          className="workspace-thread-count"
          title={threadCountLabel}
          role="img"
          aria-label={threadCountLabel}
        >
          <SvgIcon className="workspace-thread-icon" kind="botMessageSquare" />
          <span>{threads.length}</span>
        </span>
        {workspace.current ? (
          <IconButton
            title="New Thread"
            onClick={() => {
              postMessage({ type: "newThread" });
            }}
          >
            <SvgIcon className="thread-action-icon" kind="chat" />
          </IconButton>
        ) : null}
        {closing ? (
          <span
            className="workspace-close-spinner"
            title="Closing Workspace"
            role="status"
            aria-label="Closing Workspace"
          >
            <span className="thread-status active" aria-hidden="true" />
          </span>
        ) : null}
        {workspace.current ? (
          <button
            className="icon workspace-menu-trigger"
            type="button"
            title="Workspace actions"
            aria-label="Workspace actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null && menu.threadId === undefined}
            onClick={(event) => {
              event.stopPropagation();
              if (menu && menu.threadId === undefined) {
                setMenu(null);
              } else {
                const rect = event.currentTarget.getBoundingClientRect();
                showMenu(rect.right - 208, rect.bottom);
              }
            }}
          >
            <SvgIcon className="thread-action-icon" kind="moreVertical" />
          </button>
        ) : (
          <button
            className="icon workspace-menu-trigger"
            type="button"
            title="Workspace actions"
            aria-label="Workspace actions"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={(event) => {
              event.stopPropagation();
              if (menu) {
                setMenu(null);
              } else {
                const rect = event.currentTarget.getBoundingClientRect();
                showMenu(rect.right - 208, rect.bottom);
              }
            }}
          >
            <SvgIcon className="thread-action-icon" kind="moreVertical" />
          </button>
        )}
      </div>
      {menu && menu.threadId === undefined && workspace.current ? (
        <WorkspaceMenu
          close={closeWorkspace}
          dismiss={() => {
            setMenu(null);
          }}
          position={menu}
          projectRoot={projectRoot}
        />
      ) : null}
      {menu && menu.threadId === undefined && !workspace.current ? (
        <RemoteWorkspaceMenu
          close={closeWorkspace}
          dismiss={() => {
            setMenu(null);
          }}
          path={workspace.path}
          position={menu}
          threads={threads}
        />
      ) : null}
      {isNonEmpty(menu?.threadId) ? (
        <ThreadMenu
          dismiss={() => {
            setMenu(null);
          }}
          id={menu.threadId}
          position={menu}
        />
      ) : null}
      {workspace.current && expanded ? (
        <div className="workspace-threads">
          {threads.map((thread) => (
            <div
              className={`row thread-row${selectedId === thread.id ? " selected" : ""}`}
              key={thread.id}
              onContextMenu={(event) => {
                event.preventDefault();
                showMenu(event.clientX, event.clientY, thread.id);
              }}
            >
              <button
                className="row-open"
                type="button"
                title="Open Thread"
                onClick={() => {
                  postMessage({ id: thread.id, type: "selectThread" });
                }}
              >
                <StatusIndicator kind={thread.indicator} />
                <span className="name">{thread.name}</span>
                <span className="meta thread-activity">
                  {compactTime(thread.updatedAt, now)}
                </span>
              </button>
              <button
                className="icon"
                type="button"
                title="Thread actions"
                aria-label="Thread actions"
                aria-haspopup="menu"
                aria-expanded={menu?.threadId === thread.id}
                onClick={(event) => {
                  event.stopPropagation();
                  if (menu?.threadId === thread.id) {
                    setMenu(null);
                  } else {
                    const rect = event.currentTarget.getBoundingClientRect();
                    showMenu(rect.right - 208, rect.bottom, thread.id);
                  }
                }}
              >
                <SvgIcon className="thread-action-icon" kind="moreVertical" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const NavigatorPaneView = ({
  actionsMenuOpen,
  collapseAll,
  expandAllRequest,
  onDismissActionsMenu,
  onExpand,
  projects,
  threads,
}: {
  actionsMenuOpen: boolean;
  collapseAll: boolean;
  expandAllRequest: number;
  onDismissActionsMenu: () => void;
  onExpand: () => void;
  projects: ProjectsSnapshot;
  threads: RenderedThreadsSnapshot;
}): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  const previousCurrent = useRef<string | null>(null);
  const previousExpandAllRequest = useRef(expandAllRequest);
  const workspaces = [
    ...projects.projects.flatMap((project) => project.workspaces),
    ...projects.ungrouped,
  ].toSorted((left, right) => left.name.localeCompare(right.name));
  const currentPath = workspaces.find((workspace) => workspace.current)?.path;
  const currentProjectRoot = projects.projects.find((project) =>
    project.workspaces.some((workspace) => workspace.path === currentPath)
  )?.root;
  useEffect(() => {
    if (currentPath !== previousCurrent.current) {
      previousCurrent.current = currentPath ?? null;
      setExpanded(isNonEmpty(currentPath) && !collapseAll);
    }
  }, [collapseAll, currentPath]);
  useEffect(() => {
    if (collapseAll) {
      setExpanded(false);
    }
  }, [collapseAll]);
  useEffect(() => {
    if (expandAllRequest === previousExpandAllRequest.current) {
      return;
    }
    previousExpandAllRequest.current = expandAllRequest;
    setExpanded(isNonEmpty(currentPath));
  }, [currentPath, expandAllRequest]);
  useEffect(() => {
    const clock = window.setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => {
      window.clearInterval(clock);
    };
  }, []);
  useEffect(() => {
    if (actionsMenuOpen) {
      actionsMenuRef.current?.focus();
    }
  }, [actionsMenuOpen]);
  useEffect(() => {
    const dismissOutside = (event: MouseEvent): void => {
      if (
        actionsMenuOpen &&
        event.target instanceof Node &&
        actionsMenuRef.current?.contains(event.target) === false
      ) {
        onDismissActionsMenu();
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (actionsMenuOpen && event.key === "Escape") {
        onDismissActionsMenu();
      }
    };
    document.addEventListener("click", dismissOutside, true);
    document.addEventListener("contextmenu", dismissOutside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", dismissOutside, true);
      document.removeEventListener("contextmenu", dismissOutside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [actionsMenuOpen, onDismissActionsMenu]);
  return (
    <section id="navigator">
      {actionsMenuOpen ? (
        <div
          ref={actionsMenuRef}
          className="workspace-menu mischief-menu"
          role="menu"
          aria-label="Mischief actions"
          tabIndex={-1}
          onKeyDown={menuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              postMessage({ type: "addWorkspace" });
              onDismissActionsMenu();
            }}
          >
            <SvgIcon kind="plus" /> Add Workspace…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              postMessage({ type: "refresh" });
              onDismissActionsMenu();
            }}
          >
            <SvgIcon kind="history" /> Refresh
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              postMessage({ type: "showSettings" });
              onDismissActionsMenu();
            }}
          >
            <SvgIcon kind="tool" /> Settings
          </button>
        </div>
      ) : null}
      <div className="content" id="navigator-list">
        {workspaces.map((workspace) => (
          <WorkspaceNode
            actionsMenuOpen={actionsMenuOpen}
            expanded={workspace.current && expanded}
            key={workspace.path}
            now={now}
            onToggle={() => {
              if (expanded) {
                setExpanded(false);
                return;
              }
              onExpand();
              setExpanded(true);
            }}
            projectRoot={workspace.current ? currentProjectRoot : undefined}
            selectedId={threads.selected?.id}
            threads={threads.threads.filter(
              (thread) => thread.workspace === workspace.path
            )}
            workspace={workspace}
          />
        ))}
        {workspaces.length ? null : (
          <div className="empty">No active Workspaces. Add one with ＋.</div>
        )}
      </div>
    </section>
  );
};

export const NavigatorPane = memo(NavigatorPaneView);
