import type {
  Project,
  ProjectsSnapshot,
  Workspace,
} from "../../projects/projects";
import type { WorkspaceActivity } from "../../threads/threads";
import { postMessage } from "../bridge";
import { indicatorLabel, StatusIndicator } from "../threads/threads-pane";

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

const activityMeta = (activity: WorkspaceActivity): string =>
  [
    activity.activeThreads ? `${activity.activeThreads} active` : "",
    activity.attentionThreads
      ? `${activity.attentionThreads} ${activity.attentionThreads === 1 ? "needs" : "need"} attention`
      : "",
  ]
    .filter(Boolean)
    .join(" · ") || "idle";

const WorkspaceRow = ({
  activity,
  workspace,
}: {
  activity?: WorkspaceActivity;
  workspace: Workspace;
}): React.JSX.Element => (
  <div className={`row${workspace.current ? " selected" : ""}`}>
    <button
      className="row-open"
      title={workspace.path}
      onClick={() =>
        postMessage({ path: workspace.path, type: "openWorkspace" })
      }
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
      {activity ? (
        <StatusIndicator
          kind={activity.indicator}
          label={`${workspace.name}: ${indicatorLabel(activity.indicator)}; ${activityMeta(activity)}`}
        />
      ) : null}
      <span className="name">{workspace.name}</span>
      <span className="meta">
        {[
          workspace.branch,
          workspace.linked ? "worktree" : "",
          workspace.changes ? `✎${workspace.changes}` : "",
          workspace.ahead ? `↑${workspace.ahead}` : "",
          workspace.behind ? `↓${workspace.behind}` : "",
          activity ? activityMeta(activity) : "",
        ]
          .filter(Boolean)
          .join("  ")}
      </span>
    </button>
    {workspace.current ? (
      <IconButton
        title="New Thread"
        onClick={(event) => {
          event.stopPropagation();
          postMessage({ type: "newThread" });
        }}
      >
        ＋
      </IconButton>
    ) : null}
    <IconButton
      title="Close Workspace"
      onClick={() =>
        postMessage({ path: workspace.path, type: "deactivateWorkspace" })
      }
    >
      ×
    </IconButton>
  </div>
);

const ProjectGroup = ({
  project,
  workspaceActivity,
}: {
  project: Project;
  workspaceActivity: Readonly<Record<string, WorkspaceActivity>>;
}): React.JSX.Element => (
  <>
    <div className="group-row">
      <span className="name">{project.name}</span>
      <IconButton
        title="New Workspace"
        onClick={() =>
          postMessage({ path: project.root, type: "newWorkspace" })
        }
      >
        ＋
      </IconButton>
    </div>
    {project.workspaces.map((workspace) => (
      <WorkspaceRow
        activity={workspaceActivity[workspace.path]}
        workspace={workspace}
        key={workspace.path}
      />
    ))}
  </>
);

export const ProjectsPane = ({
  snapshot,
  workspaceActivity,
}: {
  snapshot: ProjectsSnapshot;
  workspaceActivity: Readonly<Record<string, WorkspaceActivity>>;
}): React.JSX.Element => (
  <section id="projects">
    <header>
      <span className="heading">Projects / Workspaces</span>
      <IconButton
        title="Add Workspace"
        onClick={() => postMessage({ type: "add" })}
      >
        ＋
      </IconButton>
      <IconButton
        title="Refresh"
        onClick={() => postMessage({ type: "refresh" })}
      >
        ↻
      </IconButton>
    </header>
    <div className="content" id="project-list">
      {snapshot.projects.map((project) => (
        <ProjectGroup
          project={project}
          workspaceActivity={workspaceActivity}
          key={project.root}
        />
      ))}
      {snapshot.ungrouped.length ? (
        <>
          <div className="group-row">Ungrouped</div>
          {snapshot.ungrouped.map((workspace) => (
            <WorkspaceRow
              activity={workspaceActivity[workspace.path]}
              workspace={workspace}
              key={workspace.path}
            />
          ))}
        </>
      ) : null}
      {!snapshot.projects.length && !snapshot.ungrouped.length ? (
        <div className="empty">No active Workspaces. Add one with ＋.</div>
      ) : null}
    </div>
  </section>
);
