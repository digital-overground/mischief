# Mischief workflow portability

**Date:** 2026-09-10

## Conclusion

Mischief's **core outcome can be reproduced in Zed today without a Zed fork** by registering MagPi as a custom ACP agent and using Zed's native Agent Panel, Threads Sidebar, project groups, and Git worktrees.

It cannot be reproduced **exactly** as a normal Zed extension. Zed's public extension API has no custom panel, view, or webview surface, so an extension cannot recreate Mischief's branded three-level browser or add its workspace metadata and actions to Zed's UI. Zed's [Webview via Extensions](https://github.com/zed-industries/zed/issues/21208) request remains open.

The practical choices are:

1. **Prefer equivalent behavior:** use Zed's native agent workflow plus a small MagPi lifecycle fix. No Zed extension is needed.
2. **Require the exact Mischief UI:** stay on VS Code or test the existing VSIX in a VS Code-compatible editor such as Cursor.
3. **Require both a different IDE and an exact custom UI:** build an IntelliJ Platform plugin. This needs no IDE fork, but it is a substantial port.

## What must be preserved

Mischief currently combines two products in one webview:

- A profile-wide managed **Project → Workspace** browser, including linked Git worktree discovery and creation, standalone folders, membership, window opening, branch/change/ahead/behind metadata, and workspace colors.
- Durable **Threads** backed by MagPi ACP, including parallel status, restored transcripts, streamed messages/thoughts/tools/diffs/plans, permissions, forms, terminal authentication, slash commands, images and file context, configuration, usage, queueing, cancellation, steering, rename/removal, fork, and rollback.

The detailed domain behavior is defined in [CONTEXT.md](../../CONTEXT.md). Mischief owns its Project and Thread index; MagPi/Pi owns protocol sessions and conversation history.

## Zed capability map

Legend: **Yes** = same outcome is available; **Partial** = usable native equivalent with a workflow or adapter difference; **No** = unavailable through current public Zed/ACP integration.

| Mischief behavior | Zed + MagPi | Finding |
| --- | --- | --- |
| Multiple profile-wide Projects | **Partial** | The Threads Sidebar holds multiple projects and lets users add recent, local, or remote projects. It does not implement Mischief's explicit membership, suppression, and `Ungrouped` model. |
| Project → Workspace → Thread hierarchy | **Partial** | Zed groups threads by project and associates each thread with a main or linked worktree, but it does not render Workspace as an intermediate nested row. Linked-worktree threads remain grouped under the main project. |
| Git and non-Git folders | **Yes** | Zed projects can be ordinary folders; Git features activate when a repository is present. |
| Discover, create, switch, open, and remove linked worktrees | **Yes** | Zed has a native worktree picker and can create, switch, open in another window, and delete linked worktrees. New worktrees start detached; selecting/creating the branch is a separate step. |
| Preserve/restore an archived thread's worktree | **Yes** | Zed saves an archived thread's worktree state, removes the checkout when unused, and recreates it when the thread is restored. |
| Workspace branch/change/ahead/behind metadata and colors in the browser | **Partial** | Zed exposes repository, branch, file status, and diffs through native Git UI. It does not reproduce Mischief's compact workspace row, ahead/behind counters there, or automatic per-window color assignment. |
| Durable thread list, titles, running/idle/waiting/error state | **Yes** | Zed shows thread title, status, and agent, keeps history across projects, and detects pending ACP permission/elicitation interactions. |
| Multiple concurrent threads | **Partial** | Zed supports this natively, but current MagPi deliberately keeps only one live Pi subprocess per ACP connection. Zed shares one custom-agent connection across a project's threads, so MagPi needs the lifecycle change described below for same-project concurrency. |
| New/load/list/import/restore sessions | **Yes** | MagPi advertises load/list and Zed can import external-agent sessions into Thread History, then restore and continue them. |
| Stream text, thoughts, tools, diffs, plans, titles, commands, config, and usage | **Yes** | Zed's ACP thread reducer handles these update types directly. Tool locations and diffs use native editor surfaces. |
| Permissions and structured elicitation forms | **Yes** | Zed handles ACP permission requests and session/request-scoped form or URL elicitations. |
| Terminal authentication | **Yes** | Zed supports ACP terminal authentication, including the legacy metadata shape currently used by MagPi. |
| File context, images, and slash commands | **Yes** | Zed's composer supports `@` context and images; MagPi advertises its available commands over ACP. |
| Per-thread role/model/thinking controls | **Yes** | Zed renders ACP session modes and configuration options. MagPi already exposes these values. |
| Queue follow-up messages and cancel | **Yes** | Zed queues messages during generation, allows queue edits/removal/send-now, and sends ACP cancellation. |
| Steer during an active external-agent turn | **No** | Zed explicitly limits steering to the Zed Agent; external-agent messages wait for the current ACP turn or interrupt it immediately. |
| Rename and remove without deleting Pi history | **Partial** | Zed supports manual titles, archive, and delete. Because MagPi does not advertise ACP session deletion, removing Zed's record need not delete Pi history, but this is not Mischief's explicit unregister/membership contract. |
| Edit a previous message and roll back from that point | **Partial** | Zed's native edit/checkpoint UI requires a truncate-capable connection, which its external ACP connection does not currently provide. MagPi's `/tree` command can rewind Pi through an elicitation, but Zed does not immediately truncate its displayed transcript or provide Mischief's per-message rollback button. |
| Fork a prior message into a separate Thread | **No** | ACP's current unstable schema defines session fork and the local MagPi work in progress implements it, but current Zed source does not consume `ForkSessionRequest` or expose external-agent fork UI. |
| Mischief-specific combined layout, styles, font, and actions | **No** | ACP supplies agent behavior and timeline data, not arbitrary host UI. Zed extensions cannot add the missing view. |

Zed's native organization is therefore closer to:

```text
Project
  Thread — bound to main checkout or linked worktree
```

It preserves the operational relationship, but flattens Mischief's visible middle layer.

## Two concrete blockers

### 1. A custom Mischief panel cannot be shipped as a Zed extension

The current [`zed_extension_api::Extension`](https://docs.rs/zed_extension_api/latest/zed_extension_api/trait.Extension.html) surface covers language servers, debuggers, context servers, slash commands, and documentation indexing. It exposes no view, panel, tab, component, or webview contribution.

The absence is deliberate/current rather than a hidden API: Zed issue [#21208](https://github.com/zed-industries/zed/issues/21208) tracks webviews/custom extension UI and is still open as of this report. ACP cannot bypass that restriction; custom agents render inside Zed's existing Agent Panel.

**Result:** exact UI in stock Zed is not currently achievable. A private Zed fork or an accepted upstream Zed change would be required.

### 2. MagPi's process policy conflicts with Zed's thread multiplexing

Zed stores one agent connection per agent in each project and reuses it for that project's sessions ([source](https://github.com/zed-industries/zed/blob/9e636045f74d3d431abe9873d2b8d2962e614c98/crates/agent_ui/src/agent_connection_store.rs#L69-L82), [reuse path](https://github.com/zed-industries/zed/blob/9e636045f74d3d431abe9873d2b8d2962e614c98/crates/agent_ui/src/agent_connection_store.rs#L143-L161)).

MagPi currently calls `closeAllExcept` when creating or loading a session ([new session](https://github.com/digital-overground/magpi-acp/blob/a21717b80d2ad8902461b49a5a9465276b22a262/src/acp/agent.ts#L389-L394), [load session](https://github.com/digital-overground/magpi-acp/blob/a21717b80d2ad8902461b49a5a9465276b22a262/src/acp/agent.ts#L1056-L1058)). That policy works for clients that create one ACP process per Thread, as Mischief does, but not for Zed's multiplexed connection.

The smallest robust adapter change is:

1. Remove the two `closeAllExcept` calls.
2. Advertise [ACP session-close support](https://agentclientprotocol.com/rfds/session-close).
3. Implement `closeSession` by calling MagPi's existing `sessions.close(sessionId)`.
4. Add one integration test with two active sessions on one connection.

Zed already sends `session/close` when a released external session advertises that capability ([source](https://github.com/zed-industries/zed/blob/9e636045f74d3d431abe9873d2b8d2962e614c98/crates/agent_servers/src/acp.rs#L1176-L1218)). This is a MagPi change, not an editor fork.

## Why native Zed covers most of Mischief

Zed now provides the shell that Mischief had to build in VS Code:

- The [Threads Sidebar](https://zed.dev/docs/ai/parallel-agents) groups threads across projects, displays status, runs them independently, and groups linked-worktree threads with their main project.
- [Worktree isolation](https://zed.dev/docs/ai/parallel-agents#worktree-isolation) creates isolated checkouts and ties their lifecycle to thread archive/restore.
- [External Agents](https://zed.dev/docs/ai/external-agents) accepts a custom `{ command, args, env }` ACP process and imports existing sessions.
- The [Agent Panel](https://zed.dev/docs/ai/agent-panel) supplies transcript, queue, context/image input, notifications, review/diff UI, titles, and history.
- Zed's ACP reducer handles agent messages, thoughts, tools, plans, title/command/config changes, and usage ([source](https://github.com/zed-industries/zed/blob/9e636045f74d3d431abe9873d2b8d2962e614c98/crates/acp_thread/src/acp_thread.rs#L2593-L2697)).
- Waiting state includes both permissions and elicitations ([source](https://github.com/zed-industries/zed/blob/9e636045f74d3d431abe9873d2b8d2962e614c98/crates/acp_thread/src/acp_thread.rs#L2499-L2515)).

This means a separate Zed extension would mostly duplicate native code even if the UI API existed.

## History-control limitation in Zed

Zed has internal checkpoint/rewind machinery, but it is capability-gated. User messages become read-only when the connection cannot truncate the session ([source](https://github.com/zed-industries/zed/blob/9e636045f74d3d431abe9873d2b8d2962e614c98/crates/agent_ui/src/entry_view_state.rs#L238-L270)). The generic `AgentConnection` defaults `truncate` to unsupported, and Zed's external `AcpConnection` does not override it. Its restore operation first requires that truncate capability ([source](https://github.com/zed-industries/zed/blob/9e636045f74d3d431abe9873d2b8d2962e614c98/crates/acp_thread/src/acp_thread.rs#L4080-L4128)).

Consequences for MagPi in Zed:

- `/tree` can still alter Pi's active branch because it is an agent command backed by ACP elicitation.
- Zed cannot atomically remove the abandoned transcript suffix through that command.
- Previous-message editing and the native Restore Checkpoint button remain unavailable for the external connection.
- No external-agent fork path is wired in the inspected Zed revision, although ACP defines an [unstable `session/fork` request](https://github.com/agentclientprotocol/agent-client-protocol/blob/4c2164ad2338de5278f09c0e98610fd6e34ab34e/agent-client-protocol-schema/src/v1/agent.rs#L1105-L1204).

These are client integration gaps, not missing Pi history primitives.

## Other no-fork editors

| Target | Exact Mischief UI? | Effort | Assessment |
| --- | --- | --- | --- |
| **Cursor / another compatible VS Code distribution** | Likely yes | Very low | Cursor is based on VS Code and supports importing VS Code extensions. Package and smoke-test the current VSIX; compatibility is vendor-controlled, so treat it as a tested target rather than assume every release works. |
| **JetBrains native AI Chat + MagPi ACP** | No | Low | JetBrains accepts custom ACP agents through `~/.jetbrains/acp.json`, so the Agent portion can run without a plugin. Its native project/thread organization is not Mischief's exact browser. |
| **Custom IntelliJ Platform plugin** | Yes | High | A plugin can contribute a tool window, embed the existing web UI through JCEF, persist application-level state, run subprocesses, and use editor/diff APIs. No IDE fork is needed, but the VS Code host layer must be rewritten in Kotlin or moved behind a packaged sidecar. |
| **Standalone companion app + Zed CLI** | Yes, outside Zed | Medium | The existing UI/domain logic could become a separate app that opens folders in Zed. This avoids an editor fork but does not satisfy an in-editor-panel requirement. |

Primary references for the JetBrains option: [custom ACP agents](https://www.jetbrains.com/help/ai-assistant/acp.html), [plugin tool windows](https://plugins.jetbrains.com/docs/intellij/tool-windows.html), [JCEF](https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html), [persistent application/project state](https://plugins.jetbrains.com/docs/intellij/persisting-state-of-components.html), [external-process execution](https://plugins.jetbrains.com/docs/intellij/execution.html), and [editor access](https://plugins.jetbrains.com/docs/intellij/editors.html). Cursor documents its VS Code base and extension import in [VS Code Migration](https://cursor.com/docs/configuration/migrations/vscode).

## Recommendation

Adopt **native Zed + MagPi ACP** if the requirement is the working model rather than Mischief's exact pixels:

```text
Zed Project group
  Zed Thread, assigned to the main checkout or a linked worktree
    MagPi/Pi session
```

Do not build a Zed extension now; it cannot provide the missing UI and would duplicate the native Agent Panel. First make MagPi safe for multiplexed sessions, then validate these five paths in a short spike:

1. Two concurrent MagPi Threads in one Zed project.
2. One Thread in the main checkout and one in a linked worktree.
3. Session list/import/load after restarting Zed.
4. Permission, form elicitation, and terminal-auth flows.
5. `/tree` rewind followed by reload, documenting the transcript limitation.

Choose a JetBrains custom plugin only if the explicit Workspace tier, membership browser, row metadata/colors, steering, and per-message fork/rollback controls are non-negotiable. Otherwise Zed already supplies the expensive parts, and the small MagPi lifecycle fix is the shortest no-fork path.
