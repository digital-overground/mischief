# Profile-wide Workspace and Thread status synchronization

**Status:** Proposed

## Goal

Keep every running Mischief Instance in one VS Code profile synchronized without adding a broker process.

A user with multiple Workspace windows open must see the same Project and Workspace list, durable Thread registrations, and current Thread statuses in each window. Closing an owning window must eventually make its live statuses offline rather than leaving them running forever.

This plan does not keep Agent turns alive after their owning VS Code window closes. That requires a future runtime daemon.

## Confirmed decisions

- Use one deep `ProfileSync` module as the synchronization interface and TDD seam.
- Store records beneath `ExtensionContext.globalStorageUri`.
- Use one file per independently-owned record rather than one shared state file.
- Each Thread has one logical writer for its heartbeat file: its owning Mischief Instance.
- Heartbeats use direct writes. Readers tolerate partial JSON and retain the last valid value until it expires.
- Durable membership, selection, and Thread records use temporary-file replacement because an interrupted write must not destroy durable user state.
- Poll the profile directory instead of introducing `fs.watch`, sockets, a server, or a dependency.
- Keep ACP connections and Agent processes in their current Workspace extension hosts.
- Defer notifications.

## Domain language

**Instance:** One running Mischief extension host in one VS Code window.

**Owner Instance:** The Instance that owns a Workspace's live `Threads` module and ACP connections. The first version assumes one active VS Code window per Workspace, matching current Mischief behavior.

**Profile Sync:** Profile-wide synchronization of durable membership and Thread registrations plus ephemeral Instance and Thread presence.

**Thread heartbeat:** An ephemeral status record written only by the Thread's Owner Instance.

Do not call Profile Sync a daemon or server. It is in-process code running independently in every active Instance against a shared profile directory.

## Current constraints

The implementation agent must preserve these facts:

- `Projects` currently stores complete `roots`, `ungrouped`, and `suppressed` arrays under `mischief.projects`.
- `Projects` rereads storage for operations, but VS Code does not provide a cross-window `globalState` change event.
- `Threads` currently loads the complete `mischief.threads` value once in its constructor. Two extension hosts can therefore hold stale copies and overwrite unrelated Thread registrations.
- A Git Project is keyed by its exact canonical Git-root path.
- An untracked Workspace is keyed by its exact canonical folder path.
- Linked worktrees remain discovered Workspaces, not independent memberships.
- Thread IDs are UUIDs and remain globally unique.
- ACP owns transcript history. Profile Sync stores registrations and status, not full transcripts.
- A running Thread still stops when its Owner Instance exits.

## Architecture decision

This plan deliberately changes the existing architecture statement that `Projects` and `Threads` each own their profile persistence. Cross-window synchronization has made shared coordination a real responsibility rather than a generic shared layer. `Projects` and `Threads` still hide persistence from their callers; `ProfileSync` is their internal local-filesystem dependency and owns only synchronization mechanics.

Phase 0 must record this trade-off in `docs/adr/0001-profile-sync-files.md`: shared files instead of stale `globalState` copies or a broker, one deep Profile Sync seam, and Workspace extension hosts retaining Agent runtime ownership.

## Scope

### Included

- Synchronized Git Project and untracked Workspace membership.
- Synchronized removal tombstones.
- Synchronized durable Thread registrations and selected-Thread restoration.
- Instance presence for open Workspace windows.
- Thread status heartbeats for `running`, `waiting`, `idle`, and `error`.
- Existing completed/unread state from durable Thread records.
- Workspace-level activity shown in every running Instance.
- Migration from current `globalState` records.
- Real-filesystem integration tests using temporary directories.

### Deferred

- Background Agent execution after VS Code closes.
- A broker, socket, HTTP server, LaunchAgent, or companion process.
- Cross-machine, Settings Sync, Remote SSH, and Codespaces synchronization.
- Native or VS Code notifications.
- Streaming transcripts between Instances.
- Opening another Workspace's Thread transcript inside the current window.
- Ownership arbitration for manually opening the same Workspace in multiple VS Code windows.
- `fs.watch`, indexes, journals, event logs, databases, and third-party locking packages.

Add this deliberate ceiling near the polling implementation:

```ts
// ponytail: profile-local polling is enough; add IPC or indexing only when scan cost or latency is measurable
```

Add this deliberate ceiling near status publication:

```ts
// ponytail: one active Instance per Workspace; add an ownership lease if duplicate Workspace windows become supported
```

## Planned files

Start with the minimum split:

```text
src/
  profile-sync/
    profile-sync.ts
    profile-sync.test.ts
```

Modify existing modules only when a phase reaches them:

```text
src/extension.ts
src/view.ts
src/view.test.ts
src/projects/projects.ts
src/projects/projects.test.ts
src/threads/threads.ts
src/threads/threads.test.ts
src/webview/protocol.ts
src/webview/app.tsx
src/webview/app.test.tsx
src/webview/projects/projects-pane.tsx
media/webview.css
CONTEXT.md
docs/adr/0001-profile-sync-files.md
```

Do not create generic `shared/`, repository, event-bus, filesystem-adapter, lock-manager, or schema utility modules. Keep file encoding, parsing, polling, expiry, and migration inside `profile-sync.ts` until a second implementation gives a split real leverage.

## ProfileSync interface

The exact TypeScript spelling may shrink during TDD, but callers must need no file-layout knowledge. Keep the interface equivalent to:

```ts
const sync = await ProfileSync.open({
  instanceId,
  log,
  profileDirectory,
  workspace,
});

sync.snapshot();
sync.onChange(listener);
await sync.apply(change);
await sync.dispose();
```

### Interface behavior

`ProfileSync.open(...)`

- Creates the required profile directories.
- Loads all valid durable records.
- Loads non-expired Instance and Thread presence.
- Writes this Instance's presence record.
- Starts polling and heartbeat timers.
- Returns only after the initial snapshot is available.
- Uses the supplied `log` callback for recoverable polling and validation warnings; failed caller-initiated writes reject `apply`.

`ProfileSync.snapshot()`

Return one read-only shape equivalent to:

```ts
interface ProfileSyncSnapshot {
  memberships: readonly Membership[];
  threads: readonly SyncedThread[];
  selectedThreads: Readonly<Record<string, string | undefined>>;
  workspaceActivity: Readonly<Record<string, WorkspaceActivity>>;
}
```

- Never mutate a previously returned snapshot.
- Sort arrays deterministically.
- Exclude removed Thread tombstones from `threads`.
- Keep active and removed membership states visible to `Projects`.
- Retain tombstone and presence mechanics privately.
- Include derived Workspace activity without exposing filesystem details.

`ProfileSync.onChange(listener)`

- Fires only when the observable snapshot changes.
- Returns an unsubscribe function.
- Does not fire for a heartbeat rewrite whose observable values are unchanged.

`ProfileSync.apply(change)`

Use one discriminated union rather than many pass-through methods. Add variants only when a vertical slice requires them:

```ts
type ProfileSyncChange =
  | { type: "putMembership"; membership: Membership }
  | { type: "removeMembership"; path: string }
  | { type: "putThread"; thread: SyncedThread }
  | { type: "removeThread"; id: string; workspace: string }
  | { type: "selectThread"; threadId?: string; workspace: string }
  | {
      type: "publishThreadStatuses";
      workspace: string;
      threads: { id: string; status: ThreadStatus }[];
    };
```

The implementation supplies record version, Instance ID, and write timestamp. Callers supply domain values only.

`ProfileSync.dispose()`

- Stops timers.
- Deletes this Instance's presence file.
- Deletes heartbeat files currently owned by this Instance on a best-effort basis.
- Leaves all durable files intact.

## On-disk layout

Use a versioned directory so a future incompatible format can coexist during migration:

```text
<globalStorageUri>/profile-sync-v1/
  memberships/
    <sha256-path>.json
  threads/
    <thread-id>.json
  selections/
    <sha256-workspace-path>.json
  instances/
    <instance-id>.json
  heartbeats/
    <thread-id>.json
```

Hash the complete canonical path with Node's standard `crypto.createHash("sha256")` and use the full lowercase hexadecimal digest. Never substitute a remote URL or folder basename for the path.

### Membership record

```ts
interface MembershipRecord {
  version: 1;
  kind: "git" | "untracked";
  path: string;
  state: "active" | "removed";
  writtenAt: string;
}
```

Rules:

- `path` is already canonicalized by `Projects` before writing.
- A `git` record stores the Project root only; linked Workspaces continue to come from Git discovery.
- An `untracked` record stores the non-Git Workspace folder.
- Removal writes `state: "removed"`; it does not delete the record.
- Adding a previously removed path overwrites the same hashed record with `state: "active"`.

### Thread record

Move the current durable `StoredThread` fields without changing their meaning:

```ts
type ThreadRecord =
  | {
      version: 1;
      state: "active";
      id: string;
      workspace: string;
      sessionId?: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      error?: string;
      retryText?: string;
      authentication?: TerminalAuthentication;
      manualName?: boolean;
      unread?: boolean;
      usage?: ThreadUsage;
      writtenAt: string;
    }
  | {
      version: 1;
      state: "removed";
      id: string;
      workspace: string;
      writtenAt: string;
    };
```

Rules:

- The Owner Instance for the Workspace is the only logical writer.
- Removing a Thread writes the smaller tombstone variant so an old in-memory copy cannot resurrect it.
- ACP transcript items remain outside Profile Sync.

### Selection record

```ts
interface SelectionRecord {
  version: 1;
  workspace: string;
  threadId?: string;
  writtenAt: string;
}
```

Rules:

- There is one selected Thread record per Workspace.
- Removing the selected Thread writes the replacement ID or an explicitly empty selection.
- A missing selected Thread falls back to the newest active Thread, preserving current behavior.

### Instance presence

```ts
interface InstancePresenceRecord {
  version: 1;
  instanceId: string;
  workspace?: string;
  writtenAt: string;
}
```

Rules:

- The owning Instance directly overwrites its own file.
- Write immediately on startup and every five seconds.
- Delete on clean disposal.
- Treat a record as offline when `writtenAt` is more than fifteen seconds old.
- A stale or partial record is ignored, not deleted during a read.

### Thread heartbeat

```ts
interface ThreadHeartbeatRecord {
  version: 1;
  instanceId: string;
  threadId: string;
  workspace: string;
  status: "idle" | "running" | "waiting" | "error";
  writtenAt: string;
}
```

Rules:

- The Thread's Owner Instance directly overwrites the file.
- Write immediately when status changes.
- Rewrite owned heartbeat files every five seconds while the Instance runs.
- On malformed JSON, readers retain the last valid in-memory heartbeat until it expires.
- After fifteen seconds without a valid heartbeat, live status becomes offline.
- A heartbeat for a removed or unknown Thread is ignored.
- The `threadId` must match the filename and an active Thread record in the same Workspace.
- The heartbeat's Instance must have a non-expired presence record for that Workspace.

## Write and read policy

### Ephemeral records

Instance presence and Thread heartbeat records use direct `writeFile` calls. A reader can observe a truncated record while another process writes. Parsing must therefore be tolerant:

1. Read the file.
2. Parse and validate it.
3. Replace the cached value only when valid.
4. Keep the previous valid cached value after partial JSON or invalid data until normal expiry decides it is stale.
5. Drop the cached value immediately after `ENOENT`, because the Owner Instance completed a clean deletion.

This is intentional and must not be replaced with locks or temporary files.

### Durable records

Membership, Thread, and selection records use one local helper inside `profile-sync.ts`:

1. Write JSON to a temporary sibling whose name includes the writing Instance ID.
2. Rename it over the destination.
3. Leave the previous destination untouched if writing fails.

There is no global lock. Records are independent, and current behavior gives each Workspace one Owner Instance. Concurrent writes to the same membership record use last completed write wins; simultaneous add/remove actions for the same path are outside the first-version guarantee. Within one process, ignore an observed record whose `writtenAt` predates the cached record.

### Validation

All disk content is an input boundary:

- Require plain objects and exact supported `version`.
- Bound string lengths and reject control characters where existing domain validation does.
- Require absolute Workspace and membership paths.
- Generate one `instanceId` with `randomUUID()` during extension activation; do not persist it across launches.
- Validate UUID-shaped Thread and Instance IDs.
- Bound each file read to a small maximum such as 1 MiB.
- Preserve the last valid snapshot when a polling pass encounters an I/O error.
- Report durable-record corruption to the existing Mischief output channel without deleting or overwriting the file.

Do not add a schema-validation dependency. Small explicit guards are sufficient.

## Derived activity

Profile Sync should return raw synchronized records plus a small derived Workspace activity map for the VS Code adapter:

```ts
interface WorkspaceActivity {
  open: boolean;
  status: "error" | "waiting" | "running" | "completed" | "idle" | "offline";
  activeThreads: number;
  attentionThreads: number;
}
```

Use this precedence when multiple Threads exist:

1. `error`
2. `waiting`
3. `running`
4. `completed`
5. `idle`
6. `offline`

Interpretation:

- `open` means at least one non-expired Instance presence record names the Workspace.
- `running`, `waiting`, and live `error` come from non-expired heartbeats.
- `completed` comes from an active durable Thread with `unread: true` and no higher-priority live status.
- `idle` means durable Threads exist without an attention state.
- `offline` means the Workspace has no live Instance and no durable completed/error state.
- `activeThreads` counts non-expired `running` and `waiting` heartbeats.
- `attentionThreads` counts waiting, error, and durable unread Threads without double-counting one Thread.

The existing `Workspace.current` field remains local to the viewing Instance. Do not turn it into a global value.

## TDD rules for every phase

The confirmed public seams are:

1. `ProfileSync` for cross-Instance file behavior.
2. Existing `Projects` and `Threads` interfaces for domain integration.
3. `MischiefView`/webview messages for rendered Workspace activity.

Use real temporary directories for Profile Sync tests. Mock only system boundaries such as time and VS Code. Do not mock internal Profile Sync helpers or assert private filenames except when injecting a filesystem failure that cannot be produced through the interface.

For every vertical slice:

1. Add one behavior-focused test through the relevant confirmed seam.
2. Run only that test and confirm it fails for the intended missing behavior.
3. Add the smallest implementation that makes it pass.
4. Run the focused test again.
5. Run affected existing tests and `pnpm typecheck`.
6. Perform a ponytail pass: remove speculative types, options, helpers, retries, and files not required by the now-green behavior.
7. Continue to the next slice only after the current completion criterion is met.

Do not write every test before implementation. Do not refactor during red-green work. Collect justified cleanup for the phase review gate.

## Phase 0: Pin the specification and baseline

### Work

- Treat this file as the implementation specification.
- Record the starting commit as the future review fixed point.
- Confirm the working tree contains no unrelated changes before implementation.
- Read `CONTEXT.md`, `AGENTS.md`, relevant `docs/adr/`, and this plan completely.
- Add `docs/adr/0001-profile-sync-files.md` with the concise decision and trade-off under **Architecture decision**; link to this plan instead of duplicating its implementation steps.
- Update `CONTEXT.md` only with durable domain behavior: open Instances share membership and Thread attention state; Agent ownership remains with the Workspace window.

### Commands

`git rev-parse HEAD`

`git status --short --branch`

`pnpm check`

### Completion criterion

The baseline commit is recorded, the ADR exists, existing checks pass, and the implementation agent can state the three confirmed test seams above without referring to a proposed helper or file format.

## Phase 1: Synchronize one membership record

### Red

Add `src/profile-sync/profile-sync.test.ts` with one integration test:

> membership added by one Instance becomes visible to another Instance

Test setup:

- Create one real temporary profile directory with `mkdtemp`.
- Open two `ProfileSync` instances with fixed Instance IDs and different Workspace paths.
- Subscribe to the second Instance.
- Apply one active untracked Workspace membership through the first Instance.
- Advance fake timers through one polling interval.
- Assert through `second.snapshot()` that the exact known membership is present.
- Dispose both Instances and remove the temporary directory in `finally`.

Run the test and verify red because `ProfileSync` does not exist.

### Green

Implement only:

- the `ProfileSync.open`, `snapshot`, `apply`, `onChange`, and `dispose` interface;
- directory creation;
- membership encoding and validation;
- deterministic membership sorting;
- durable membership replacement;
- one-second polling; and
- change emission when the membership snapshot changes.

Do not add Threads, presence, migration, expiry, retries, or UI code in this phase.

### Review gate

- The interface contains no raw path-to-record methods.
- The test asserts only observable membership behavior.
- Polling constants are module constants, not configuration.
- There is one implementation file and one test file.

### Completion criterion

The focused test is green from two independent `ProfileSync` objects sharing only a temporary directory.

## Phase 2: Preserve membership removal behavior

### Slice 2A: Removal tombstones

#### Red

Add a test:

> removing membership in one Instance marks it removed in another Instance

Start with an active record, remove it through `apply`, advance the poll, and assert that the second snapshot exposes it as removed rather than active.

#### Green

Add the `removeMembership` change and removal tombstone merge. Overwrite the same hashed record; do not add a deletion protocol.

#### Completion criterion

A later stale in-memory active value cannot reappear after a valid removed record has been observed.

### Slice 2B: Projects integration

#### Red

Extend `src/projects/projects.test.ts` through the public `Projects` interface:

> Project membership added in one Instance appears when another Instance refreshes

Use a real temporary Git Project as existing tests do. Use two real Profile Sync objects sharing one profile directory. Keep expected paths as known canonical literals from test setup rather than recomputing the implementation's hash or file path.

#### Green

Refactor `Projects` to consume Profile Sync membership instead of `mischief.projects` arrays:

- `open` still canonicalizes the selected folder.
- `add` writes one active membership record.
- `remove` writes one removed membership record.
- `refresh` reads the latest Profile Sync snapshot and performs Git discovery.
- Missing Git roots and untracked Workspace paths retain existing cleanup behavior without deleting removal tombstones.
- Linked worktree discovery remains inside `Projects`.

Remove `StoredProjects`, `STORAGE_KEY`, and `ProjectsStorage` only after all callers and tests have moved. Do not leave a pass-through compatibility wrapper.

#### Completion criterion

All existing Projects tests plus the new two-Instance test pass, and `Projects` contains no file-layout or polling knowledge.

## Phase 3: Migrate durable membership

### Red

Add one Profile Sync test:

> opening Profile Sync imports legacy Project membership exactly once

Pass a representative legacy value containing a Git root, untracked Workspace, and path from the legacy `suppressed` array. Open Profile Sync twice and assert one active or removed record per path with removal preserved.

### Green

- Let `ProfileSync.open` accept optional legacy Project values only for migration.
- Import only when no v1 membership records exist.
- Use canonical paths so concurrent idempotent imports converge.
- In `src/extension.ts`, read `mischief.profileSyncProjectsVersion`, pass legacy values only when needed, and update the marker to `1` after `ProfileSync.open` succeeds.
- Leave legacy values untouched.
- Prefer existing v1 records over legacy values.

Keep the Profile Sync module free of `vscode` imports.

### Completion criterion

Restarting or opening a second Instance cannot duplicate, erase, or unsuppress imported memberships.

## Phase 4: Synchronize Thread registrations and selections

### Slice 4A: One Thread registration

#### Red

Add a Profile Sync integration test:

> Thread registered by its Owner Instance becomes visible to another Instance

Use a fixed Thread record with literal expected values. Apply it in the first Instance, advance polling, and assert it from the second snapshot.

#### Green

Add:

- Thread record encoding and validation;
- `putThread` and `removeThread` changes;
- active/tombstone merge;
- deterministic newest-first ordering within each Workspace; and
- durable selection records with `selectThread`.

Do not add heartbeat files in this slice.

### Slice 4B: Threads integration

#### Red

Adapt the existing Threads restoration behavior at its public interface:

> a Thread registered in one Owner Instance restores from Profile Sync when its Workspace opens in another Instance

The test should verify Thread ID, name, selected state, and ACP session load through the existing fake Agent connection. It must not inspect Profile Sync files.

#### Green

Refactor `Threads` persistence:

- Load current Workspace Thread records and selection during `openWorkspace`.
- Persist each changed Thread through `putThread` instead of rewriting a global array.
- Persist selection through `selectThread`.
- Write a Thread tombstone on removal.
- Preserve current behavior for naming, retry data, authentication, unread completion, usage, fork, rollback, and newest-first ordering.
- Keep runtime transcript items, queued prompts, drafts, commands, and config options in memory as they are now.

Retain an in-memory test implementation only if it remains a real adapter used by existing domain tests. Otherwise move tests to Profile Sync and delete the obsolete generic storage seam. Do not mock `ProfileSync` methods just to preserve old test setup.

### Slice 4C: Migrate Threads and selections

#### Red

Add one Profile Sync test:

> opening Profile Sync imports legacy Thread registrations and Workspace selections exactly once

Include two Workspaces, one selected Thread per Workspace, and every optional durable `StoredThread` field. Reopen Profile Sync with the same legacy value and assert one active record per Thread with both selections preserved.

#### Green

- Extend `ProfileSync.open` to accept optional legacy Thread values.
- Import only when no v1 Thread records exist.
- In `src/extension.ts`, read `mischief.profileSyncThreadsVersion`, pass legacy values only when needed, and update the marker to `1` after `ProfileSync.open` succeeds.
- Prefer existing v1 Thread and selection records over legacy values.
- Leave `mischief.threads` untouched for rollback.

### Review gate

Run every Threads test. Compare the diff for lost persistence fields; every current `StoredThread` field must be either synchronized or explicitly remain runtime-only according to this plan.

### Completion criterion

Two Workspace windows cannot overwrite registrations belonging to different Workspaces, migration preserves all durable fields, and all existing Thread persistence behavior remains green.

## Phase 5: Synchronize Instance presence

### Red

Add one test:

> Workspace presence becomes offline after its Instance heartbeat expires

Use fake timers, a fixed system time, and the real temporary filesystem:

- Open one reader Instance for a different Workspace.
- Fault-inject one valid foreign Instance record stamped with the current time.
- Advance one polling interval and observe the foreign Workspace as open through the reader snapshot.
- Advance the clock beyond fifteen seconds without rewriting the foreign fixture.
- Advance one more polling interval and assert that the foreign Workspace is offline.

The fixture simulates an unclean process exit at the filesystem boundary. Assertions remain entirely through `ProfileSync.snapshot()`.

### Green

Implement:

- direct Instance-file writes at startup and every five seconds;
- a fifteen-second expiry threshold;
- best-effort Instance-file deletion during disposal;
- last-valid-record caching; and
- derived `open` Workspace presence.

A test may fault-inject partial JSON into an Instance file, but assertions must remain through `ProfileSync.snapshot()`. The expected behavior is no crash and retention of the last valid presence until expiry.

### Completion criterion

An uncleanly terminated Instance cannot leave a Workspace globally open for longer than the expiry threshold.

## Phase 6: Synchronize Thread heartbeats

### Slice 6A: Status publication

#### Red

Add one test:

> waiting Thread status published by its Owner Instance appears in another Instance

Publish a known Thread registration and status, advance one poll, and assert the second snapshot's derived Workspace activity is `waiting` with one attention Thread.

#### Green

Implement `publishThreadStatuses`:

- The caller sends the complete current Workspace Thread summaries.
- Profile Sync directly writes one heartbeat file per supplied Thread.
- Profile Sync tracks the files owned by this Instance.
- A five-second timer rewrites the last valid owned statuses.
- Status changes write immediately.
- Statuses omitted from a later complete publication have their owned heartbeat removed best-effort.

Wire one publication point from the existing `Threads.onChange` flow. Do not add writes to every Thread method.

### Slice 6B: Partial and stale heartbeat handling

#### Red

Add one filesystem-boundary fault test:

> partial heartbeat writes never erase the last valid status before expiry

After observing a valid `running` status, replace the heartbeat contents with partial JSON, poll, and assert `running` remains. Advance beyond expiry and assert `offline`.

#### Green

Add only the tolerant cache and expiry behavior needed by the test. Do not add retries, file locks, temporary heartbeat files, or watchers.

### Slice 6C: Activity precedence

#### Red

Use a table-driven test with known literal outcomes for Workspaces containing combinations of error, waiting, running, unread completed, idle, and offline Threads.

#### Green

Implement the precedence exactly as specified under **Derived activity**. Keep it in Profile Sync so every caller receives identical behavior.

### Completion criterion

Other Instances observe status changes within two seconds, and stale or partial heartbeat files cannot cause crashes, flicker, or permanently running indicators.

## Phase 7: Render synchronized Workspace activity

### Slice 7A: Host protocol

#### Red

Extend `src/view.test.ts`:

> a Profile Sync change posts updated Workspace activity to the webview

Assert the public host-to-webview message only. Do not assert listener call counts or internal merge helpers.

#### Green

- Subscribe `MischiefView` to Profile Sync changes.
- Add `workspaceActivity: Record<string, WorkspaceActivity>` to the state message in `src/webview/protocol.ts`.
- Keep `ProjectsSnapshot` free of Thread status fields.
- Preserve `Workspace.current` as this-window state.
- Serialize refreshes so overlapping polls cannot reorder rendered snapshots.

### Slice 7B: Workspace row

#### Red

Extend `src/webview/app.test.tsx`:

> a Workspace row shows running and attention activity received from another Instance

Use a literal host message and assert accessible status text, not CSS class implementation.

#### Green

- Pass `workspaceActivity` from `App` to `ProjectsPane`.
- Reuse existing Thread indicator language and styles where that is smaller than a second status system.
- Show `open` and aggregate status without replacing branch, changes, ahead, or behind metadata.
- Ensure color alone is not the only status signal.
- Keep the middle Threads pane scoped to the current Workspace.

### Completion criterion

Every active Instance renders the same aggregate activity for all listed Workspaces while still identifying its own current Workspace correctly.

## Phase 8: Lifecycle and cleanup

### Red

Add one end-to-end Profile Sync test:

> disposing one Instance removes only its owned presence and heartbeats

Create two Instances and Threads, dispose one, poll from the other, and assert the second Instance's files and statuses remain observable.

### Green

- Track only files this Instance owns.
- Clear all timers before deletion.
- Ignore `ENOENT` during best-effort cleanup.
- Keep stale foreign files until normal polling ignores them.
- Optionally delete expired Instance files during startup only if the deletion is a trivial addition; expiry correctness must not depend on cleanup.

### Completion criterion

Closing one VS Code window cannot remove durable records or another window's live statuses.

## Phase 9: Documentation and final review

### Documentation

Update `CONTEXT.md` with behavior, not file mechanics:

- Managed membership and Thread attention state are synchronized across running Instances in one profile.
- Each Workspace window still owns its running Threads.
- Closing the Owner Instance stops its turns.

Update this plan's status to **Implemented** only after every acceptance criterion is met.

### Full verification

Run the existing aggregate check once:

`pnpm check`

### Ponytail review

Run the ponytail over-engineering review against the complete implementation diff. Specifically challenge:

- abstractions with one caller;
- configuration for fixed polling/expiry values;
- generic storage or event layers;
- locks around single-writer heartbeat files;
- watchers layered on polling;
- duplicated status derivation;
- compatibility wrappers left after migration; and
- files that can be merged without reducing locality.

Apply deletions and simplifications, then rerun `pnpm check`.

### Pocock two-axis review

Use the baseline commit from Phase 0 as the fixed point and this file as the spec source.

Run both review axes independently:

- **Standards:** check `AGENTS.md`, `CONTEXT.md`, relevant ADRs, repository conventions, and the Fowler smell baseline from the `code-review` skill.
- **Spec:** check every requirement, non-goal, completion criterion, and acceptance criterion in this plan. Flag missing behavior, incorrect behavior, and scope creep.

Keep the reports separate. Resolve every hard standards violation and every missing or incorrect spec item. Treat smell findings as judgment calls, favoring deletion and native Node/VS Code capabilities. Rerun the focused affected test after each fix, then rerun `pnpm check`.

### Completion criterion

Formatting, linting, type checking, all tests, and both bundles pass after review fixes; no unresolved Standards or Spec findings remain.

## Acceptance criteria

### Membership

- Adding a Git Project or untracked Workspace in one Instance appears in every other running Instance within two seconds.
- Removing membership in one Instance removes it everywhere within two seconds.
- Removed paths stay removed and are not resurrected by stale readers.
- Linked Workspace discovery and missing-path cleanup retain current behavior.
- Separate clones remain separate Projects.

### Threads

- Creating, naming, renaming, forking, rolling back, and removing a Thread cannot overwrite registrations from another Workspace.
- Opening a Workspace restores its selected Thread and ACP session from synchronized durable records.
- Removing a Thread preserves Agent-owned ACP/Pi history.
- Transcript contents are not copied into Profile Sync files.

### Presence and status

- Every Instance publishes its current Workspace presence.
- Other Instances observe `running`, `waiting`, `error`, completed/unread, idle, and offline outcomes.
- A clean shutdown removes owned ephemeral records best-effort.
- A crash or forced shutdown makes live status offline within fifteen seconds.
- Partial heartbeat JSON does not crash polling or erase the last valid status before expiry.
- One Instance cannot delete another Instance's presence or heartbeats.
- The UI never presents a stale heartbeat as permanently running.

### Architecture

- `Projects` and `Threads` contain no polling, file-path, hashing, or heartbeat-expiry logic.
- The webview contains no filesystem or synchronization logic.
- Profile Sync imports no `vscode` module.
- No new runtime dependency is added.
- No subprocess, socket, network listener, daemon, or OS notification is introduced.
- Polling and heartbeat intervals are fixed implementation constants.

## Manual verification

After automated checks pass:

1. Launch one Extension Development Host and open a listed Workspace.
2. Launch a second Extension Development Host under the same test profile and open another listed Workspace.
3. Add and remove membership in one window; verify the other updates without manual refresh.
4. Start a Thread in one window; verify the other window shows running activity for that Workspace.
5. Trigger a permission or elicitation request; verify waiting/attention appears in the other window.
6. Complete a background Thread; verify completed/unread appears until that Thread is viewed.
7. Force-close the owning window during a running turn; verify the other window marks it offline within fifteen seconds.
8. Reopen the Workspace; verify durable Thread registration and selected Thread restoration still work.

Document any discrepancy as a failing automated test before fixing it.

## Future daemon conversion

Profile Sync is the seam a future daemon client should replace. Preserve these boundaries now:

- Callers apply domain changes and consume snapshots.
- File layout and polling remain private implementation details.
- Agent runtime ownership remains outside Profile Sync.

A future daemon migration can move the current Profile Sync implementation behind a local process and replace polling with transport messages without changing Projects, Threads, or webview contracts. Continuing Agent turns after all VS Code windows close will still require a separate later step that moves ACP connections, prompt queues, interaction handling, and transcript buffering into that process.
