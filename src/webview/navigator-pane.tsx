import { memo, useEffect, useRef, useState } from "react";

import type {
  Project,
  ProjectsSnapshot,
  Workspace,
} from "../projects/projects";
import type { ThreadIndicator, ThreadSummary } from "../threads/threads";
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

const visibleColor = (color: string): string => {
  let opaque = color;
  if (color.length === 5) {
    opaque = color.slice(0, -1);
  } else if (color.length === 9) {
    opaque = color.slice(0, -2);
  }
  const channels = opaque
    .match(/[\da-f]{2}/giu)
    ?.map((channel) => Number.parseInt(channel, 16));
  const brightest = Math.max(...(channels ?? []));
  if (!channels || channels.length !== 3 || brightest >= 160) {
    return opaque;
  }
  if (brightest === 0) {
    return "#a0a0a0";
  }
  return `#${channels
    .map((channel) => Math.round((channel * 160) / brightest))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
};

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

const WorkspaceNode = ({
  expanded,
  now,
  onToggle,
  selectedId,
  threads,
  workspace,
}: {
  expanded: boolean;
  now: number;
  onToggle: () => void;
  selectedId?: string | null;
  threads: ThreadSummary[];
  workspace: Workspace;
}): React.JSX.Element => {
  const attention = (["waiting", "error", "completed"] as const).filter(
    (indicator) => threads.some((thread) => thread.indicator === indicator)
  );
  const workspaceAction = `${expanded ? "Collapse" : "Expand"} ${workspace.name}`;
  return (
    <div className={`workspace-node${workspace.current ? " current" : ""}`}>
      <div
        className={`row workspace-row${workspace.current && !expanded ? " selected" : ""}`}
      >
        <button
          className="workspace-disclosure workspace-toggle"
          type="button"
          title={`${expanded ? "Collapse" : "Expand"} ${workspace.name}`}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${workspace.name}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          className="row-open workspace-open"
          type="button"
          title={workspaceAction}
          aria-label={workspaceAction}
          onClick={onToggle}
        >
          {workspace.color ? (
            <span
              aria-hidden="true"
              className="workspace-color"
              style={{
                backgroundColor: workspace.color,
                boxShadow: `0 0 0 1px ${visibleColor(workspace.color)}`,
              }}
            />
          ) : null}
          <span className="workspace-label">
            <span className="name">{workspace.name}</span>
            {workspace.branch ? (
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
        {workspace.current ? null : (
          <IconButton
            title={`Open ${workspace.name} Window`}
            onClick={() =>
              postMessage({ path: workspace.path, type: "openWorkspace" })
            }
          >
            <SvgIcon className="thread-action-icon" kind="externalLink" />
          </IconButton>
        )}
        {workspace.current ? (
          <>
            <IconButton
              title="Thread History"
              onClick={() => postMessage({ type: "threadHistory" })}
            >
              <SvgIcon className="thread-action-icon" kind="history" />
            </IconButton>
            <IconButton
              title="New Thread"
              onClick={() => postMessage({ type: "newThread" })}
            >
              <SvgIcon className="thread-action-icon" kind="chat" />
            </IconButton>
          </>
        ) : null}
        <IconButton
          title="Close Workspace"
          onClick={() =>
            postMessage({ path: workspace.path, type: "deactivateWorkspace" })
          }
        >
          <SvgIcon className="thread-action-icon" kind="x" />
        </IconButton>
      </div>
      {expanded ? (
        <div className="workspace-threads">
          {threads.map((thread) => (
            <div
              className={`row thread-row${selectedId === thread.id ? " selected" : ""}`}
              key={thread.id}
            >
              <button
                className="row-open"
                title="Open Thread"
                onClick={() =>
                  postMessage({ id: thread.id, type: "selectThread" })
                }
              >
                <StatusIndicator kind={thread.indicator} />
                <span className="name">{thread.name}</span>
                <span className="meta thread-activity">
                  {compactTime(thread.updatedAt, now)}
                </span>
              </button>
              {workspace.current ? (
                <>
                  <IconButton
                    title="Rename Thread"
                    onClick={() =>
                      postMessage({ id: thread.id, type: "renameThread" })
                    }
                  >
                    <SvgIcon className="thread-action-icon" kind="pencil" />
                  </IconButton>
                  <IconButton
                    title="Remove Thread"
                    onClick={() =>
                      postMessage({ id: thread.id, type: "removeThread" })
                    }
                  >
                    <SvgIcon className="thread-action-icon" kind="archive" />
                  </IconButton>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const ProjectGroup = ({
  expanded,
  onToggle,
  project,
  renderWorkspace,
}: {
  expanded: boolean;
  onToggle: () => void;
  project: Project;
  renderWorkspace: (workspace: Workspace) => React.ReactNode;
}): React.JSX.Element => (
  <div className="navigator-group">
    <div className="group-row">
      <button
        className="workspace-disclosure project-toggle"
        type="button"
        title={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? "▾" : "▸"}
      </button>
      <button
        className="row-open project-title"
        type="button"
        title={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
        onClick={onToggle}
      >
        <span className="name">{project.name}</span>
      </button>
      <IconButton
        title="Open GitHub Issues"
        onClick={() => postMessage({ path: project.root, type: "openIssues" })}
      >
        <SvgIcon className="project-action-icon" kind="folderGit2" />
      </IconButton>
      <IconButton
        title="New Workspace"
        onClick={() =>
          postMessage({ path: project.root, type: "newWorkspace" })
        }
      >
        <SvgIcon className="thread-action-icon" kind="plus" />
      </IconButton>
    </div>
    {expanded ? project.workspaces.map(renderWorkspace) : null}
  </div>
);

const UNGROUPED_GROUP = "ungrouped";
const projectGroup = (root: string): string => `project:${root}`;

const NavigatorPaneView = ({
  collapseAll,
  expandAllRequest,
  onExpand,
  projects,
  threads,
}: {
  collapseAll: boolean;
  expandAllRequest: number;
  onExpand: () => void;
  projects: ProjectsSnapshot;
  threads: RenderedThreadsSnapshot;
}): React.JSX.Element => {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const previousCurrent = useRef<string | null>(null);
  const previousExpandAllRequest = useRef(expandAllRequest);
  const workspaces = [
    ...projects.projects.flatMap((project) => project.workspaces),
    ...projects.ungrouped,
  ];
  const currentPath = workspaces.find((workspace) => workspace.current)?.path;
  const currentProject = projects.projects.find((project) =>
    project.workspaces.some((workspace) => workspace.path === currentPath)
  );
  let currentGroup: string | undefined;
  if (currentPath) {
    currentGroup = currentProject
      ? projectGroup(currentProject.root)
      : UNGROUPED_GROUP;
  }
  const currentSelection =
    currentGroup && currentPath ? `${currentGroup}\0${currentPath}` : null;
  useEffect(() => {
    if (currentPath && currentSelection !== previousCurrent.current) {
      setExpanded((paths) => new Set(paths).add(currentPath));
      setCollapsedGroups((groups) => {
        if (!currentGroup || !groups.has(currentGroup)) {
          return groups;
        }
        const next = new Set(groups);
        next.delete(currentGroup);
        return next;
      });
    }
    previousCurrent.current = currentSelection;
  }, [currentGroup, currentPath, currentSelection]);
  useEffect(() => {
    if (collapseAll) {
      setCollapsedGroups(
        new Set([
          ...projects.projects.map((project) => projectGroup(project.root)),
          ...(projects.ungrouped.length ? [UNGROUPED_GROUP] : []),
        ])
      );
      setExpanded(new Set());
    }
  }, [collapseAll, projects]);
  useEffect(() => {
    if (expandAllRequest === previousExpandAllRequest.current) {
      return;
    }
    previousExpandAllRequest.current = expandAllRequest;
    setCollapsedGroups(new Set());
    setExpanded(
      new Set(
        [
          ...projects.projects.flatMap((project) => project.workspaces),
          ...projects.ungrouped,
        ].map((workspace) => workspace.path)
      )
    );
  }, [expandAllRequest, projects]);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(clock);
  }, []);
  const toggleGroup = (group: string, groupExpanded: boolean): void => {
    if (!groupExpanded) {
      onExpand();
    }
    setCollapsedGroups((groups) => {
      const next = new Set(groups);
      if (groupExpanded) {
        next.add(group);
      } else {
        next.delete(group);
      }
      return next;
    });
  };
  const renderWorkspace = (workspace: Workspace): React.ReactNode => {
    const workspaceExpanded = expanded.has(workspace.path);
    return (
      <WorkspaceNode
        expanded={workspaceExpanded}
        key={workspace.path}
        now={now}
        onToggle={() => {
          if (!workspaceExpanded) {
            onExpand();
          }
          setExpanded((paths) => {
            const next = new Set(paths);
            if (workspaceExpanded) {
              next.delete(workspace.path);
            } else {
              next.add(workspace.path);
            }
            return next;
          });
        }}
        selectedId={threads.selected?.id}
        threads={threads.threads.filter(
          (thread) => thread.workspace === workspace.path
        )}
        workspace={workspace}
      />
    );
  };
  const ungroupedExpanded = !collapsedGroups.has(UNGROUPED_GROUP);
  const allExpanded =
    Boolean(projects.projects.length || projects.ungrouped.length) &&
    projects.projects.every(
      (project) => !collapsedGroups.has(projectGroup(project.root))
    ) &&
    (projects.ungrouped.length === 0 || ungroupedExpanded) &&
    workspaces.every((workspace) => expanded.has(workspace.path));
  useEffect(() => {
    postMessage({ expanded: allExpanded, type: "navigatorExpanded" });
  }, [allExpanded]);
  return (
    <section id="navigator">
      <div className="content" id="navigator-list">
        {projects.projects.map((project) => {
          const group = projectGroup(project.root);
          const groupExpanded = !collapsedGroups.has(group);
          return (
            <ProjectGroup
              expanded={groupExpanded}
              key={project.root}
              onToggle={() => toggleGroup(group, groupExpanded)}
              project={project}
              renderWorkspace={renderWorkspace}
            />
          );
        })}
        {projects.ungrouped.length ? (
          <div className="navigator-group">
            <div className="group-row">
              <button
                className="workspace-disclosure project-toggle"
                type="button"
                title={`${ungroupedExpanded ? "Collapse" : "Expand"} Ungrouped`}
                aria-label={`${ungroupedExpanded ? "Collapse" : "Expand"} Ungrouped`}
                aria-expanded={ungroupedExpanded}
                onClick={() => toggleGroup(UNGROUPED_GROUP, ungroupedExpanded)}
              >
                {ungroupedExpanded ? "▾" : "▸"}
              </button>
              <span className="name">Ungrouped</span>
            </div>
            {ungroupedExpanded ? projects.ungrouped.map(renderWorkspace) : null}
          </div>
        ) : null}
        {!projects.projects.length && !projects.ungrouped.length ? (
          <div className="empty">No active Workspaces. Add one with ＋.</div>
        ) : null}
      </div>
    </section>
  );
};

export const NavigatorPane = memo(NavigatorPaneView);
