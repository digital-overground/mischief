# Mischief

Mischief is a VS Code extension for managing code Projects and graphical Agent Threads powered by MagPi ACP. It replaces the old Herdr terminal integration with a focused Project → Workspace → Thread experience.

## Language

**Project**:
A folder deliberately managed by Mischief. A Project contains one primary Workspace and any linked Git Workspaces.
_Avoid_: Repository, application, VS Code workspace.

**Workspace**:
A concrete folder or checkout where a Thread runs. Linked Git worktrees are separate Workspaces in the same Project.
_Avoid_: Project, session, checkout when the folder itself is meant.

**Thread**:
A conversation owned by Mischief and executed by one Agent in one Workspace.
_Avoid_: Session, chat, task.

**Agent**:
An ACP-speaking executable that runs Threads. MagPi ACP is the default Agent.
_Avoid_: Model, provider, session.

**Membership**:
Whether a Project is present in Mischief's profile-wide managed list. Removing membership does not delete Threads or Agent history.
_Avoid_: Deletion, archive.

**ACP session**:
The protocol-level runtime/session identified by an ACP Agent. It is an implementation detail behind a Mischief Thread.
_Avoid_: Thread when speaking about the user's domain.

## Relationships

- A Project contains one or more Workspaces.
- A Workspace contains zero or more Threads.
- A Thread runs through exactly one Agent and one Workspace.
- ACP executes and persists protocol sessions; Mischief owns the Project and Thread index.
- ACP never creates Projects.
- Separate Git clones are separate Projects even when they share a remote origin.

## Project behavior

- Opening an unlisted folder in VS Code automatically creates a Project for that exact folder.
- Opening an already-listed Workspace does not change Project membership.
- There is no promotion from a selected subfolder to its Git root. A selected monorepo subfolder remains that exact Project folder.
- If the exact added folder is a Git checkout root, current linked worktrees are discovered automatically and shown as Workspaces in the same Project.
- Newly-created linked worktrees appear on refresh; deleted or pruned worktrees disappear on refresh.
- Separate clones never join the same Project based on GitHub or another remote origin.
- Project membership is global per VS Code profile and persists across restarts and windows.
- Opening a different Workspace reuses the current VS Code window by default. A future setting may allow a new window.
- Removing a Project removes membership only. Mischief Thread registrations and ACP/Pi history remain and reappear if the Project is added again.
- Adding a Project is available explicitly for folders that are not currently open.

## Thread behavior

- Mischief registers only Threads it creates or explicitly tracks; arbitrary ACP session history does not create Projects.
- Focusing a Thread opens or reuses its Workspace, then restores the Thread transcript.
- Thread history is restored through ACP load using the Agent-owned protocol session.
- ACP streams assistant messages, thoughts, tool calls, plans, usage, permissions, and elicitation into the graphical transcript.
- The first version uses a stable VS Code Webview rather than proposed Chat Session APIs.
- In-flight turns do not need to survive extension-host restarts in the first version.
- The default Agent is MagPi ACP. Additional ACP Agents are configurable through the same `{ command, args, env }` shape.
- Mischief does not require Herdr, a Herdr server, terminal mirroring, or TUI interaction.

## Architecture decisions

- Start a fresh project rather than continue the Herdex/Merdr fork. Only the useful behavior is carried forward.
- Organize by domain, not by a symmetric `view/model/service/repository` template.
- `Projects` is one deep domain module. It hides profile persistence, path canonicalization, Git worktree discovery, and Git status.
- `Threads` is one deep domain module. It hides Thread persistence, transcript state, ACP lifecycle, and prompt/cancel behavior.
- Views are thin VS Code adapters inside their domain folders.
- ACP is an internal external-system adapter inside `threads/`, not a generic repository layer.
- Git is an internal external-system adapter inside `projects/`.
- Add separate transcript logic only when its reduction behavior earns a file; do not create generic shared layers preemptively.
- Tests cross the `Projects` and `Threads` interfaces. Projects tests may use temporary real Git repositories; Threads tests use a fake ACP connection.
- Add a repository or separate model only when persistence or domain rules materially outgrow the owning domain module.

## Planned shape

```text
src/
  extension.ts
  projects/
    projects.ts
    git.ts
    view.ts
    projects.test.ts
  threads/
    threads.ts
    transcript.ts
    acp.ts
    agents-view.ts
    thread-view.ts
    threads.test.ts
```

The exact split is allowed to shrink if a file does not earn its own behavior. `shared/`, generic `utils/`, dependency containers, event buses, factories, and pass-through repositories are not part of the baseline.

## Tooling

- TypeScript is the implementation language, using strict compiler checks.
- Ultracite is used with its Oxlint + Oxfmt provider.
- Oxlint is the linter; Oxfmt is the formatter. ESLint, Prettier, and Biome are not part of the toolchain.
- Every supported source, configuration, and documentation file must be format-compliant.
- The project should provide `format`, `format:check`, `lint`, `typecheck`, `test`, and aggregate `check` commands before implementation begins.
- Pocock engineering skills are installed under `.pi/skills/`; initialize their repo-specific setup before using issue-tracker or domain workflow skills.

## Explicitly deferred

- Durable background ownership of in-flight turns.
- Proposed VS Code Chat APIs.
- Importing all existing Pi sessions.
- Filters, selection sending, status-bar decoration, and other convenience features not required for the first vertical slice.
- Automatic deletion of ACP/Pi history when Project membership is removed.
