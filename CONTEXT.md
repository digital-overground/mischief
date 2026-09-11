# Mischief

Mischief is a VS Code extension for managing code Projects and graphical Agent Threads powered by MagPi ACP. It replaces the old Herdr terminal integration with a focused Project → Workspace → Thread experience.

## Language

**Project**: A conceptual Git-based grouping added to Mischief. A Project is anchored to one Git checkout root and contains that root plus any linked Git Workspaces. _Avoid_: Repository, application, VS Code workspace.

**Workspace**: A concrete folder or checkout where a Thread runs. Linked Git worktrees are separate Workspaces in the same Project. _Avoid_: Project, session, checkout when the folder itself is meant.

**Thread**: A conversation owned by Mischief and executed by one Agent in one Workspace. _Avoid_: Session, chat, task.

**Agent**: An ACP-speaking executable that runs Threads. MagPi ACP is the default Agent. _Avoid_: Model, provider, session.

**Workspace status**: Whether a Workspace is `active` and shown or `inactive` and hidden. Only the Mischief Instance with that Workspace open may make it inactive.

**ACP session**: The protocol-level runtime/session identified by an ACP Agent. It is an implementation detail behind a Mischief Thread. _Avoid_: Thread when speaking about the user's domain.

## Relationships

- A Project is the conceptual grouping of Git Workspaces with the same canonical Git root.
- An untracked Workspace belongs to the non-selectable `Ungrouped` section rather than a Project.
- Projects themselves are not selectable in the combined view. They are labeled by their root folder name and sorted alphabetically; the currently open Workspace is visibly indicated.
- A Workspace contains zero or more Threads.
- A Thread runs through exactly one Agent and one Workspace.
- ACP executes and persists protocol sessions; Mischief owns the Project and Thread index.
- ACP never creates Projects.
- Separate Git clones are separate Projects even when they share a remote origin.

## Project behavior

- Opening or adding a folder activates that exact Workspace. Git discovery associates it with its canonical-root Project; a non-Git folder becomes an untracked Workspace under `Ungrouped`.
- Projects are derived from their Workspaces rather than activated or removed independently. A Project is shown while it has at least one active Workspace.
- Only the Mischief Instance with a Workspace currently open may make that Workspace inactive. Making one Workspace inactive does not affect its siblings.
- Active Workspaces are shown; inactive Workspaces are hidden. Changing status does not delete Threads or ACP/Pi history.
- A Project is keyed by its exact canonical Git-root path; an untracked Workspace is keyed by its exact canonical folder path. Separate clones never join the same Project based on GitHub or another remote origin.
- Newly-created linked worktrees are associated with the same Project when discovered. Deleted or missing folders are omitted from the UI without another Instance rewriting their status.
- Selecting a Workspace focuses its existing VS Code window when open; otherwise it opens the folder in a new window. Workspace rows use the folder name as their primary label and show branch/worktree identity plus Git changes, ahead, and behind status.
- Workspace records are global per VS Code profile, persist across restarts, and are shared by every open Mischief window in that profile.

## Thread behavior

- A new Thread can be started from its Workspace row or from the selected Workspace’s Thread-section toolbar. An empty new Thread appears only in the transcript composer, without a Thread-list row. Mischief registers it when its first prompt is sent; an empty Thread is not durable. If that attempt fails, the Thread remains durable in a failed state and can be retried. ACP can name the Thread from a quick summary at that point; the user may rename it afterward.
- Mischief registers only Threads it creates or explicitly tracks; arbitrary ACP session history creates neither Thread registrations nor Projects. Removing a Thread unregisters it from Mischief without deleting Agent-owned ACP/Pi history.
- Focusing a Thread opens or reuses its Workspace, then restores the Thread transcript. On activation, Mischief expands the current Workspace and restores its last-selected Thread, falling back to its newest Thread. If the Workspace has no Threads, the bottom section immediately shows an unregistered New Thread composer.
- Threads are the user-facing conversations; there is no separate Agents collection or view. The fixed Agent is metadata and runtime ownership for each Thread.
- Threads in the selected Workspace are ordered newest-first by creation time. Each Thread row shows its name, running/idle/waiting/error state, and time since its last message using compact units such as `13min`, `2h`, or `4d`. Waiting means the Agent needs a permission or elicitation response. MagPi requests that interaction through ACP; Mischief renders it inline in the Thread transcript and returns the user’s response through ACP. V1 relies on Thread-row indicators for waiting and errors.
- Thread history is restored through ACP load using the Agent-owned protocol session. If the fixed Agent or ACP session is unavailable, Mischief keeps the Thread visible with an error and retry action. If MagPi reports that Pi authentication is required, Mischief launches ACP Terminal Auth in a VS Code integrated terminal and then allows retry.
- ACP streams assistant messages, thoughts, tool calls, plans, usage, permissions, and elicitation into the graphical transcript. Thinking remains visible by default; tool output is compact by default and can be expanded, matching Pi’s display posture. Tool file locations and structured diffs open in VS Code’s native editor/diff view. Mischief does not summarize Agent-provided thoughts. Cancelling a turn preserves already-streamed output and activity, marked as cancelled.
- The first version uses one stable Activity Bar Webview rather than native TreeViews or proposed Chat Session APIs. It renders Projects/Workspaces at the top, Threads in the middle, and the selected Thread transcript/composer at the bottom. The whole view can use a Mischief-specific font. Domain state and actions stay outside webview JavaScript so the sections can become separate native views later without changing Projects or Threads.
- Multiple Thread turns may run concurrently, including within one Workspace. A running Thread’s composer remains enabled; additional messages are shown as queued with their position and run in order. Stopping the active turn clears the Agent’s queue but restores the queued message text as editable drafts. Navigating away from a Thread does not cancel its turn; it continues in its Workspace’s VS Code window and remains visible when the Thread is reopened.
- Open Mischief windows in one VS Code profile share registered Threads and Thread attention state. Each Workspace window’s extension host still owns its running Threads; closing that window stops its in-flight turns.
- MagPi ACP is the only Agent in v1. The selected Thread header renders its ACP-provided Role, Model, and Thinking configuration controls. These settings belong to that Thread. An Agent is fixed for the lifetime of a Thread; future support for additional ACP Agents may use the same `{ command, args, env }` shape.
- Mischief does not require Herdr, a Herdr server, terminal mirroring, or TUI interaction.

## Architecture decisions

- Start a fresh project rather than continue the Herdex/Merdr fork. Only the useful behavior is carried forward.
- Organize by domain, not by a symmetric `view/model/service/repository` template.
- `ProfileDatabase` is one deep synchronization module. It hides profile files, validation, polling, and write ordering.
- `Projects` is one deep domain module. It hides path canonicalization, Git worktree discovery, Git status, and Project grouping.
- `Threads` is one deep domain module. It hides Thread records, transcript state, ACP lifecycle, and prompt/cancel behavior.
- The combined Webview is a thin VS Code adapter over `Projects` and `Threads`; it owns no domain state.
- ACP is an internal external-system adapter inside `threads/`, not a generic repository layer.
- Git is an internal external-system adapter inside `projects/`.
- Add separate transcript logic only when its reduction behavior earns a file; do not create generic shared layers preemptively.
- Tests cross the `ProfileDatabase`, `Projects`, and `Threads` interfaces. Profile Database tests use temporary directories, Projects tests may use temporary real Git repositories, and Threads tests use a fake ACP connection.
- Add a repository or separate model only when persistence or domain rules materially outgrow the owning domain module.

## Planned shape

```text
src/
  extension.ts
  view.ts
  profile-database/
    profile-database.ts
    profile-database.test.ts
  projects/
    projects.ts
    git.ts
    projects.test.ts
  threads/
    threads.ts
    transcript.ts
    acp.ts
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
- Configuring or selecting additional ACP Agents.
- Displaying ACP context usage and cost in the Thread header.
- Filters, selection sending, status-bar decoration, background waiting/error notifications, and other convenience features not required for the first vertical slice.
- Automatic deletion of ACP/Pi history when a Workspace becomes inactive.
