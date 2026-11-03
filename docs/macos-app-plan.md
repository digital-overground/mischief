# Mischief for macOS Plan

## Status

Phases 1 and 2 passed their signed-app and cross-client checks; see [build and observed results](../macos/README.md). The Phase 2 companion deliberately leaves a VS Code window open when it deactivates a Workspace. Phase 3 is next; later phases remain draft. Storage formats, Phase 3 Host ownership, and remote networking will be designed as those phases approach.

## Goal

Build a standalone macOS app for viewing and managing Mischief Projects, Workspaces, and Threads.

The app should eventually run and control Threads without VS Code. It should remain useful in the background by showing a Dock badge and notifying the user when a Thread needs attention. VS Code remains a supported Mischief client rather than the permanent owner of every Thread.

Remote access is a later phase. The local architecture must leave a clear path to it without exposing a local machine or rewriting the Thread runtime.

## Product shape

Mischief for macOS has three parts:

### macOS shell

A small Swift/AppKit application owns the native macOS experience:

- Application and window lifecycle
- Dock icon and badge
- Notifications and notification clicks
- Menus, file dialogs, and links to other applications
- Signing, notarization, installation, and updates

The shell should stay small. It should not duplicate Project, Workspace, Thread, or Agent rules.

### React interface

A `WKWebView` renders the existing React interface, adapted for a full application window. It presents:

- Projects and their Workspaces
- Untracked Workspaces
- Thread lists and attention state
- The selected Thread transcript and composer
- Settings and Agent controls

The macOS app and VS Code extension should share this interface where their behavior matches. During Phase 2, move platform-independent React controls and domain classes out of `vscode-extension/` into a root-level `shared/` library as real second callers emerge. VS Code APIs remain in `vscode-extension/`; AppKit and WebKit APIs remain in `macos/`. Do not extract the extension's interface for the Phase 1 diagnostic page.

### Mischief Host

A Node process owns Mischief's working state:

- Profile data
- Project and Workspace discovery
- Thread records and transcripts
- Agent installation and ACP connections
- Running turns, queues, permissions, and elicitation
- Commands from connected clients and updates sent back to them

The Host becomes the only process allowed to run or mutate a Thread once independent Thread control ships. This prevents the app and extension from opening the same Agent session at the same time.

## Delivery principles

1. **Each phase must be useful.** The first app can be a companion before it can run Threads.
2. **One owner for live Threads.** Independent control does not ship until the Host can prevent duplicate runtimes and conflicting writes.
3. **Keep the current product working.** The VS Code extension continues to work while responsibility moves into the Host.
4. **Reuse behavior, not platform glue.** Keep the existing Project, Thread, ACP, and React behavior. Replace VS Code-specific windowing, storage access, and message transport where needed.
5. **Treat remote access as a security feature.** Do not expose the local Host to a network until authentication, encryption, pairing, and revocation are designed.

## Phase 1: Prove the application shape

Build a small technical prototype before moving product behavior.

The prototype should:

1. Launch a signed development build of the AppKit application.
2. Load a local React page in `WKWebView`.
3. Exchange typed messages between Swift and React.
4. Start the Node Host and reconnect after the window is closed and reopened.
5. Set and clear the Dock badge from Host state.
6. Show a notification and open the correct view when it is clicked.
7. Quit cleanly without leaving an unknown child process behind.

The prototype lives in `macos/` and has a small, separate React diagnostic screen, not the VS Code navigator. It reads no profile data and performs no real Thread actions. Bundle the React assets and a Node runtime with the app; do not require a development server or an installed Node. For this prototype, Swift launches Node and exchanges messages over the child process's standard input/output; Swift and React exchange typed, runtime-validated messages through WebKit. No TCP listener is needed. These choices do not define the Phase 3 client-to-Host transport.

Closing the window leaves the diagnostic Host running. Clicking the Dock icon reopens one window and reconnects it without starting a second Host. Quit stops and reaps the Host. An unexpected Host exit is visible, with an explicit restart action rather than a silent restart loop. This does not decide what happens to running Threads on Quit in Phase 3.

A manual test action sets and clears a badge from diagnostic Host state and sends a notification addressed to a diagnostic view. Show notification authorization or denial clearly. Clicking the notification opens the target view while the app is running, even if its window was closed; notification handling after Quit is deferred.

This phase is complete only after a repeatable check of the packaged arm64 `.app` signed with an Apple Development identity verifies launch, local React loading, typed round-trip, Host start/reconnect and failure, badge changes, notification permission and click routing, and Quit without an orphaned child. Record the commands, prerequisites, observed results, and a go/no-go decision. If bundling, signing, or supervising the Node Host proves unreliable, stop and reconsider Electron before moving product behavior. Universal binaries and minimum supported macOS version are release decisions, not prototype gates.

## Phase 2: Ship a local companion app

Build the first useful macOS release without changing ownership of live Threads.

The app should:

1. Connect to the Default VS Code profile. Profile selection can follow if needed.
2. Show Projects, Workspaces, and Threads in one window.
3. Group Git Workspaces under their derived Project and list untracked Workspaces separately.
4. Add or deactivate a Workspace and refresh Workspace status.
5. Open a Workspace or Thread in VS Code when an action still belongs there.
6. Count Threads that are waiting, errored, or completed but unread.
7. Show that count on the Dock icon.
8. Notify only when a Thread changes from not needing attention to needing attention.
9. Avoid sending a notification for every existing attention item at startup.
10. Open the relevant Thread when the user clicks a notification.

The companion app may read all Thread summaries, but VS Code still owns Agent processes and Thread mutation during this phase. Thread creation, prompts, cancellation, permission responses, rename, and removal continue in VS Code. For this companion release, Deactivate hides a Workspace record without closing an already-open VS Code window; it is not the extension's Close Workspace action.

This phase tests whether the Project hierarchy, background behavior, and native shell are useful before the runtime moves.

## Phase 3: Move Thread ownership into the Host

Make the macOS app an independent Mischief client.

Work through the transition in this order:

1. Give the Host a stable application-support directory for its database and Agent installations.
2. Add a one-time import from the selected VS Code profile.
3. Make the Host the single owner of ACP connections and Thread writes.
4. Connect the macOS app to the Host for all Project, Workspace, and Thread actions.
5. Connect the VS Code extension to the same Host instead of opening its own Agent sessions.
6. Preserve existing Thread behavior: create, load, prompt, queue, cancel, retry, rename, unregister, history, permissions, elicitation, configuration, fork, and rollback.
7. Keep running turns alive when the app window closes.
8. Define what happens when the user quits while work is running.
9. Detect incompatible client and Host versions and explain the required update.
10. Verify that two clients cannot start duplicate runtimes for one Thread.

This phase is complete when the app can create and continue a Thread with VS Code closed, and the same Thread can then be viewed and controlled from VS Code without transferring or duplicating its Agent session.

The existing Profile Database ADR must be superseded here. It currently assigns Thread writes to a Workspace's VS Code extension instance and explicitly avoids a broker process.

## Phase 4: Finish the macOS product

Prepare the independent app for normal installation and daily use.

Include:

1. A signed and notarized installer.
2. An update path for the app and Host.
3. Recovery after Host or app crashes.
4. Clear connection and Agent failure states.
5. Migration backup and rollback instructions.
6. macOS accessibility checks for navigation, transcript controls, dialogs, and notifications.
7. Measured launch time, idle memory, and background CPU use.
8. A decision on launch at login. Do not enable it by default without a user-facing reason.
9. A clear distinction between closing the window, quitting the app, and stopping the Host.

## Phase 5: Add remote access

Treat remote access as a separate product and security plan built on the same Host.

Before implementation, decide:

- Where the Host runs and which files and Agent credentials it can access
- Whether clients connect through a private network, direct connection, or managed relay
- How a user pairs a client, reviews access, and revokes it
- How transport encryption and Host identity are verified
- Which actions are allowed remotely, especially permission and elicitation responses
- How file links, diffs, images, and large tool output are delivered
- What happens when the Host sleeps, disconnects, or changes networks
- Whether a remote client can install Agents or change Host settings
- What audit history the user can inspect

Start remote access as an explicit opt-in. The Host must not bind an unauthenticated port to the LAN or internet.

## Management semantics

The app should preserve Mischief's current domain rules:

- A Project is derived from Git Workspaces with the same canonical Git root. It is displayed but not independently created or deleted.
- Adding a folder activates a Workspace.
- Creating a linked Workspace creates a Git worktree and branch.
- Closing a Workspace marks it inactive; it does not delete its folder, worktree, Threads, or Agent history.
- Creating a Thread starts a Mischief-owned conversation in one Workspace with one fixed Agent.
- Removing a Thread unregisters it from Mischief; it does not delete Agent-owned history.

Destructive folder, Git worktree, or Agent-history deletion is outside this plan and should require a separate design.

## Attention behavior

Use the existing definition of a Thread that needs attention:

- The Agent is waiting for a response.
- The Thread ended with an error.
- A turn completed while the Thread was not being viewed.

The Dock badge shows the number of attention-needing Threads in active Workspaces. Viewing or resolving a Thread clears its attention state through the Host, so every connected client updates together.

Notifications should represent transitions, not periodic reminders. Notification preferences, quiet hours, and per-Project controls can wait until users demonstrate a need for them.

## Decisions still open

Resolve these before their phase begins:

1. Whether Phase 3 merges multiple local VS Code profiles into one Host library.
2. How the production Host is bundled, upgraded, and stopped across clients; Phase 1 only proves a bundled, app-launched diagnostic Node child.
3. How the VS Code extension finds and starts the local Host when the app is not open.
4. Whether app Quit stops an idle Host and what happens during a running turn.
5. Which remote connection model to pursue.
6. Whether a future Windows or Linux client is a product goal. This plan covers macOS only.

## Documentation changes

As the plan moves forward:

1. Record the shell, webview, and Host split in a new architecture decision.
2. Update `CONTEXT.md` when the Host becomes the Thread owner.
3. Supersede the current Profile Database ownership ADR rather than silently contradicting it.
4. Keep remote authentication and network exposure in their own decision and threat model.

## Final outcome

A user can open Mischief on macOS, see every local Project, Workspace, and Thread, respond to work that needs attention, and continue using the same Threads from VS Code. Agent work continues under one local Host regardless of which client is open. The same Host can later accept authenticated remote clients without moving Thread ownership again.
