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
  return (
    <div className={`workspace-node${workspace.current ? " current" : ""}`}>
      <div
        className={`row workspace-row${workspace.current && !expanded ? " selected" : ""}`}
      >
        <button
          className="row-open workspace-toggle"
          type="button"
          title={`${expanded ? "Collapse" : "Expand"} ${workspace.name}`}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${workspace.name}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="workspace-disclosure" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
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
        {workspace.current ? (
          <IconButton
            title="New Thread"
            onClick={() => postMessage({ type: "newThread" })}
          >
            <SvgIcon className="thread-action-icon" kind="chat" />
          </IconButton>
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
  project,
  renderWorkspace,
}: {
  project: Project;
  renderWorkspace: (workspace: Workspace) => React.ReactNode;
}): React.JSX.Element => (
  <>
    <div className="group-row">
      <span className="name">{project.name}</span>
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
    {project.workspaces.map(renderWorkspace)}
  </>
);

const NavigatorPaneView = ({
  projects,
  threads,
}: {
  projects: ProjectsSnapshot;
  threads: RenderedThreadsSnapshot;
}): React.JSX.Element => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const previousCurrent = useRef<string | null>(null);
  const current = [
    ...projects.projects.flatMap((project) => project.workspaces),
    ...projects.ungrouped,
  ].find((workspace) => workspace.current)?.path;
  useEffect(() => {
    if (current && current !== previousCurrent.current) {
      setExpanded((paths) => new Set(paths).add(current));
    }
    previousCurrent.current = current ?? null;
  }, [current]);
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(clock);
  }, []);
  const renderWorkspace = (workspace: Workspace): React.ReactNode => (
    <WorkspaceNode
      expanded={expanded.has(workspace.path)}
      key={workspace.path}
      now={now}
      onToggle={() =>
        setExpanded((paths) => {
          const next = new Set(paths);
          if (next.has(workspace.path)) {
            next.delete(workspace.path);
          } else {
            next.add(workspace.path);
          }
          return next;
        })
      }
      selectedId={threads.selected?.id}
      threads={threads.threads.filter(
        (thread) => thread.workspace === workspace.path
      )}
      workspace={workspace}
    />
  );
  return (
    <section id="navigator">
      <div className="content" id="navigator-list">
        {projects.projects.map((project) => (
          <ProjectGroup
            project={project}
            renderWorkspace={renderWorkspace}
            key={project.root}
          />
        ))}
        {projects.ungrouped.length ? (
          <>
            <div className="group-row">Ungrouped</div>
            {projects.ungrouped.map(renderWorkspace)}
          </>
        ) : null}
        {!projects.projects.length && !projects.ungrouped.length ? (
          <div className="empty">No active Workspaces. Add one with ＋.</div>
        ) : null}
      </div>
    </section>
  );
};

export const NavigatorPane = memo(NavigatorPaneView);
