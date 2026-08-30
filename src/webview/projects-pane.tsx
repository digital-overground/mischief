import type {
  Project,
  ProjectsSnapshot,
  Workspace,
} from "../projects/projects";
import { postMessage } from "./bridge";

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

const WorkspaceRow = ({
  removable = false,
  workspace,
}: {
  removable?: boolean;
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
      <span className="name">{workspace.name}</span>
      <span className="meta">
        {[
          workspace.branch,
          workspace.linked ? "worktree" : "",
          workspace.changes ? `✎${workspace.changes}` : "",
          workspace.ahead ? `↑${workspace.ahead}` : "",
          workspace.behind ? `↓${workspace.behind}` : "",
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
    {removable ? (
      <IconButton
        title="Remove membership"
        onClick={() =>
          postMessage({ path: workspace.path, type: "removeMembership" })
        }
      >
        ×
      </IconButton>
    ) : null}
  </div>
);

const ProjectGroup = ({ project }: { project: Project }): React.JSX.Element => (
  <>
    <div className="group-row">
      <span className="name">{project.name}</span>
      <IconButton
        title="Remove membership"
        onClick={() =>
          postMessage({ path: project.root, type: "removeMembership" })
        }
      >
        ×
      </IconButton>
    </div>
    {project.workspaces.map((workspace) => (
      <WorkspaceRow workspace={workspace} key={workspace.path} />
    ))}
  </>
);

export const ProjectsPane = ({
  snapshot,
}: {
  snapshot: ProjectsSnapshot;
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
        <ProjectGroup project={project} key={project.root} />
      ))}
      {snapshot.ungrouped.length ? (
        <>
          <div className="group-row">Ungrouped</div>
          {snapshot.ungrouped.map((workspace) => (
            <WorkspaceRow
              removable
              workspace={workspace}
              key={workspace.path}
            />
          ))}
        </>
      ) : null}
      {!snapshot.projects.length && !snapshot.ungrouped.length ? (
        <div className="empty">No managed Workspaces. Add one with ＋.</div>
      ) : null}
    </div>
  </section>
);
