import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AgentId } from "../agents/update";
import { isNonEmpty } from "../present";
import type { ProjectsSnapshot, Workspace } from "../projects/projects";
import type { ThreadIndicator, ThreadSummary } from "../threads/threads/models";
import { AgentIcon } from "./agent-icon";
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
  >
    {kind === "waiting" ? (
      <SvgIcon
        className="thread-status-question"
        kind="messageCircleQuestionMark"
      />
    ) : null}
  </span>
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
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            postMessage({ path: projectRoot, type: "projectSetup" });
            dismiss();
          }}
        >
          <SvgIcon kind="gear" /> Project Settings
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

// oxlint-disable-next-line complexity -- Workspace menu and Thread row actions share this rendering path
const WorkspaceNode = ({
  agentIcons,
  parentMenuOpen,
  expanded,
  flyout,
  now,
  onNavigate,
  onToggle,
  projectRoot,
  selectedId,
  threads,
  workspace,
}: {
  agentIcons?: Partial<Record<AgentId, string>>;
  parentMenuOpen: boolean;
  expanded: boolean;
  flyout: boolean;
  now: number;
  onNavigate?: () => void;
  onToggle: () => void;
  projectRoot?: string;
  selectedId?: string | null;
  threads: ThreadSummary[];
  workspace: Workspace;
}): React.JSX.Element => {
  const [closing, setClosing] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (parentMenuOpen) {
      setMenu(null);
    }
  }, [parentMenuOpen]);
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
  const showMenu = (x: number, y: number): void => {
    setMenu({
      left: Math.max(4, Math.min(x, window.innerWidth - 216)),
      top: Math.max(
        4,
        Math.min(y, window.innerHeight - Math.min(window.innerHeight - 8, 152))
      ),
    });
  };
  const closeWorkspace = (): void => {
    setMenu(null);
    setClosing(true);
    postMessage({ path: workspace.path, type: "closeWorkspace" });
    onNavigate?.();
  };
  let workspaceAction = `Open ${workspace.name} Window`;
  if (flyout) {
    workspaceAction = `Open ${workspace.name} in Mischief`;
  } else if (workspace.current) {
    workspaceAction = `${expanded ? "Collapse" : "Expand"} ${workspace.name}`;
  }
  return (
    <div
      ref={nodeRef}
      className={`workspace-node${workspace.current ? " current" : ""}${closing ? " closing" : ""}`}
    >
      <div
        aria-busy={closing}
        className={`row workspace-row${workspace.current && !expanded ? " selected" : ""}${closing ? " closing" : ""}`}
        onContextMenu={(event) => {
          if (workspace.current && !closing) {
            event.preventDefault();
            showMenu(event.clientX, event.clientY);
          }
        }}
      >
        {workspace.current && !flyout ? (
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
            if (flyout) {
              postMessage({ path: workspace.path, type: "focusWorkspace" });
              onNavigate?.();
            } else if (workspace.current) {
              onToggle();
            } else {
              postMessage({ path: workspace.path, type: "openWorkspace" });
            }
          }}
        >
          <span className="workspace-label">
            <span className="name">{workspace.name}</span>
            {isNonEmpty(workspace.branch) ? (
              <span className="workspace-branch">
                <SvgIcon className="workspace-branch-icon" kind="gitBranch" />
                {workspace.branch}
              </span>
            ) : null}
          </span>
        </button>
        {workspace.current && !flyout ? (
          <IconButton
            title="New Thread"
            onClick={() => {
              postMessage({ type: "newThread" });
              onNavigate?.();
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
        ) : null}
      </div>
      {menu && workspace.current ? (
        <WorkspaceMenu
          close={closeWorkspace}
          dismiss={() => {
            setMenu(null);
            onNavigate?.();
          }}
          position={menu}
          projectRoot={projectRoot}
        />
      ) : null}
      {(workspace.current || flyout) && expanded ? (
        <div className="workspace-threads">
          {threads.map((thread) => (
            <div
              className={`row thread-row${selectedId === thread.id ? " selected" : ""}${!flyout && thread.indicator !== "idle" ? " has-status" : ""}`}
              key={thread.id}
            >
              {!flyout && thread.indicator !== "idle" ? (
                <StatusIndicator kind={thread.indicator} />
              ) : null}
              <button
                className="row-open"
                type="button"
                title="Open Thread"
                onClick={() => {
                  postMessage({ id: thread.id, type: "selectThread" });
                  onNavigate?.();
                }}
              >
                <span className="name">{thread.name}</span>
                <span className="meta thread-activity">
                  {compactTime(thread.updatedAt, now)}
                  <AgentIcon
                    id={thread.agentId ?? "magpi-acp"}
                    icons={agentIcons}
                  />
                </span>
              </button>
              {workspace.current ? (
                <button
                  className="icon"
                  type="button"
                  title="Close Thread"
                  aria-label="Close Thread"
                  onClick={(event) => {
                    event.stopPropagation();
                    postMessage({ id: thread.id, type: "removeThread" });
                  }}
                >
                  <SvgIcon className="thread-action-icon" kind="x" />
                </button>
              ) : null}
              {flyout && thread.indicator !== "idle" ? (
                <StatusIndicator kind={thread.indicator} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const WorkspaceList = ({
  agentIcons,
  parentMenuOpen,
  emptyMessage,
  expanded,
  flyout,
  workspaces,
  now,
  onNavigate,
  onToggle,
  projectRoot,
  threads,
}: {
  agentIcons?: Partial<Record<AgentId, string>>;
  parentMenuOpen: boolean;
  emptyMessage: string;
  expanded: boolean;
  flyout: boolean;
  workspaces: Workspace[];
  now: number;
  onNavigate?: () => void;
  onToggle: () => void;
  projectRoot?: string;
  threads: RenderedThreadsSnapshot;
}): React.JSX.Element => (
  <div
    className="content workspace-list"
    id={flyout ? "navigator-flyout-list" : "navigator-list"}
  >
    {workspaces.map((workspace) => (
      <WorkspaceNode
        agentIcons={agentIcons}
        parentMenuOpen={parentMenuOpen}
        expanded={flyout || (workspace.current && expanded)}
        flyout={flyout}
        key={workspace.path}
        now={now}
        onNavigate={onNavigate}
        onToggle={onToggle}
        projectRoot={workspace.current ? projectRoot : undefined}
        selectedId={threads.selected?.id}
        threads={threads.threads.filter(
          (thread) => thread.workspace === workspace.path
        )}
        workspace={workspace}
      />
    ))}
    {workspaces.length > 0 ? null : <div className="empty">{emptyMessage}</div>}
  </div>
);

const NavigatorPaneView = ({
  agentIcons,
  collapseAll,
  expandAllRequest,
  onDismissProjectsMenu,
  onExpand,
  onToggleProjectsMenu,
  projects,
  projectsMenuOpen,
  threads,
}: {
  agentIcons?: Partial<Record<AgentId, string>>;
  collapseAll: boolean;
  expandAllRequest: number;
  onDismissProjectsMenu: () => void;
  onExpand: () => void;
  onToggleProjectsMenu: () => void;
  projects: ProjectsSnapshot;
  projectsMenuOpen: boolean;
  threads: RenderedThreadsSnapshot;
}): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 4, top: 36 });
  const projectsMenuRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  const previousCurrent = useRef<string | null>(null);
  const previousExpandAllRequest = useRef(expandAllRequest);
  const { current, workspaces } = projects.navigation;
  const currentPath = current?.workspace.path;
  const currentProjectRoot = current?.projectRoot;
  const visibleWorkspaces = current ? [current.workspace] : [];
  const needsAttention = threads.threads.some(
    (thread) => thread.needsAttention
  );
  const pendingQuestion = threads.threads.some(
    (thread) => thread.indicator === "waiting"
  );
  const attentionLabel = pendingQuestion
    ? "A Thread is waiting for your response"
    : "Threads need attention";
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
    if (projectsMenuOpen) {
      projectsMenuRef.current?.focus();
    }
  }, [projectsMenuOpen]);
  useLayoutEffect(() => {
    if (!projectsMenuOpen || !projectsMenuRef.current) {
      return;
    }
    const menu = projectsMenuRef.current;
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(menuPosition.left, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(menuPosition.top, window.innerHeight - height - 4))}px`;
  }, [menuPosition, projectsMenuOpen]);
  useEffect(() => {
    const dismissOutside = (event: MouseEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest("#workspace-header button") !== null
      ) {
        return;
      }
      if (
        projectsMenuOpen &&
        event.target instanceof Node &&
        projectsMenuRef.current?.contains(event.target) === false
      ) {
        onDismissProjectsMenu();
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (projectsMenuOpen && event.key === "Escape") {
        onDismissProjectsMenu();
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
  }, [onDismissProjectsMenu, projectsMenuOpen]);
  const toggleCurrentWorkspace = (): void => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    onExpand();
    setExpanded(true);
  };
  return (
    <section id="navigator">
      <header id="workspace-header">
        <button
          id="workspace-header-trigger"
          type="button"
          title="Browse Workspaces and Threads"
          aria-label="Browse Workspaces and Threads"
          aria-controls="navigator-flyout-list"
          aria-expanded={projectsMenuOpen}
          aria-haspopup="dialog"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenuPosition({
              left:
                event.detail === 0 ? rect.left + rect.width / 2 : event.clientX,
              top: event.detail === 0 ? rect.bottom : event.clientY,
            });
            onToggleProjectsMenu();
          }}
        >
          <span id="workspace-title">Workspaces</span>
          {needsAttention ? (
            <span
              className={`thread-status ${pendingQuestion ? "waiting" : "needs-attention"} workspace-attention-indicator`}
              title={attentionLabel}
              role="img"
              aria-label={attentionLabel}
            >
              {pendingQuestion ? (
                <SvgIcon
                  className="thread-status-question"
                  kind="messageCircleQuestionMark"
                />
              ) : null}
            </span>
          ) : null}
          <SvgIcon
            className="thread-action-icon workspace-header-more"
            kind="moreVertical"
          />
        </button>
      </header>
      {projectsMenuOpen ? (
        <div
          ref={projectsMenuRef}
          className="workspace-menu projects-menu"
          role="dialog"
          aria-label="Workspaces and Threads"
          tabIndex={-1}
          style={menuPosition}
          onKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('[role="menu"]') !== null
            ) {
              return;
            }
            menuKeyDown(event);
          }}
        >
          <div className="projects-menu-actions">
            <button
              type="button"
              onClick={() => {
                postMessage({ type: "addWorkspace" });
                onDismissProjectsMenu();
              }}
            >
              <SvgIcon kind="plus" /> Add Workspace…
            </button>
            <button
              type="button"
              onClick={() => {
                postMessage({ type: "refresh" });
                onDismissProjectsMenu();
              }}
            >
              <SvgIcon kind="history" /> Refresh
            </button>
          </div>
          <hr />
          <WorkspaceList
            agentIcons={agentIcons}
            parentMenuOpen={projectsMenuOpen}
            emptyMessage="No active Workspaces. Add one with ＋."
            expanded={expanded}
            flyout
            workspaces={workspaces}
            now={now}
            onNavigate={onDismissProjectsMenu}
            onToggle={toggleCurrentWorkspace}
            projectRoot={currentProjectRoot}
            threads={threads}
          />
        </div>
      ) : null}
      <WorkspaceList
        agentIcons={agentIcons}
        parentMenuOpen={projectsMenuOpen}
        emptyMessage={
          workspaces.length > 0
            ? "No current Workspace. Browse Workspaces from the header."
            : "No active Workspaces. Add one from the header."
        }
        expanded={expanded}
        flyout={false}
        workspaces={visibleWorkspaces}
        now={now}
        onToggle={toggleCurrentWorkspace}
        projectRoot={currentProjectRoot}
        threads={threads}
      />
    </section>
  );
};

export const NavigatorPane = memo(NavigatorPaneView);
