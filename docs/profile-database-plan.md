# Profile-wide file database

**Status:** Proposed

## Goal

Give every Mischief window in one VS Code profile the same Project, Workspace, and Thread data without a broker process.

Each window opens the same small file database beneath `ExtensionContext.globalStorageUri`. The window that owns a Workspace writes that Workspace and its Threads. Other windows poll and read.

Agent processes still belong to the VS Code window where their Workspace is open. Closing that window stops its running turns.

## Domain model

### Project

A Project is the conceptual grouping of Git Workspaces with the same canonical Git root. It is derived from Workspace records and does not need its own file or active/inactive status.

### Workspace

A Workspace is a concrete folder where Threads run.

- A Git Workspace stores its canonical path and canonical Project root.
- An untracked Workspace stores only its canonical path.
- `active` Workspaces are shown in the UI.
- `inactive` Workspaces remain in the database but are hidden.
- Only the Instance with that Workspace currently open may mark it inactive.

### Thread

A Thread belongs to exactly one Workspace. Its status remains one of `idle`, `running`, `waiting`, or `error`. ACP continues to own transcript history.

### Instance

An Instance is one running Mischief extension host in one VS Code window. Its current Workspace is the only Workspace whose Thread records it may update.

## File layout

Use one independently replaceable JSON file per Workspace or Thread:

```text
<globalStorageUri>/profile-db-v1/
  workspaces/
    <sha256-workspace-path>.json
  threads/
    <thread-id>.json
```

Projects are derived from Workspace records, so there is no `projects/` directory.

Use Node's `crypto.createHash("sha256")` over the complete canonical Workspace path. Thread filenames use their UUIDs.

## Records

### Workspace record

```ts
interface WorkspaceRecord {
  version: 1;
  path: string;
  projectRoot?: string;
  status: "active" | "inactive";
  writtenAt: number;
}
```

- `path` and `projectRoot` are absolute canonical paths.
- `projectRoot` is present for Git Workspaces and absent for untracked Workspaces.
- The Git root Workspace has `path === projectRoot`.
- `writtenAt` is `Date.now()`, an integer Unix timestamp in milliseconds.
- Opening or explicitly adding a Workspace writes `active`.
- Cleanly closing the owning window writes `inactive` best effort.
- A reader never writes another Workspace inactive.
- Missing folders are omitted from the UI without changing their records.

### Thread record

Keep the existing durable Thread fields and add its current status and write timestamp:

```ts
interface ThreadRecord {
  version: 1;
  id: string;
  workspace: string;
  sessionId?: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "waiting" | "error";
  error?: string;
  retryText?: string;
  authentication?: TerminalAuthentication;
  manualName?: boolean;
  unread?: boolean;
  usage?: ThreadUsage;
  writtenAt: number;
}
```

- Only the Instance whose current Workspace equals `workspace` may write the record.
- Removing a Thread removes it from Mischief without deleting ACP/Pi history.
- Transcript items, prompt queues, drafts, commands, and live ACP connections stay in memory or ACP storage.

## Database interface

Keep file layout, validation, polling, and write ordering behind one deep module:

```ts
const database = await ProfileDatabase.open({
  currentWorkspace,
  instanceId,
  log,
  profileDirectory,
});

database.snapshot();
database.onChange(listener);
await database.apply(change);
await database.dispose();
```

The observable snapshot grows only when a vertical slice needs another entity:

```ts
interface ProfileDatabaseSnapshot {
  workspaces: readonly WorkspaceRecord[];
  threads: readonly ThreadRecord[];
}
```

Callers never receive filenames or hashing details.

## Writes and concurrency

All records use temporary-file replacement:

1. Write JSON to a sibling temporary file containing the Instance ID.
2. Rename it over the destination.
3. Leave the previous destination untouched when writing fails.

Readers validate every file and keep their previous snapshot after an I/O failure. Arrays are sorted deterministically, and previously returned snapshots are never mutated.

For the same record, a reader accepts the greatest `writtenAt`. Equal timestamps accept the file currently on disk. Millisecond timestamps are sufficient because Workspace and Thread writes have one logical owner. Add stronger revision numbers only if real conflicting writers appear.

```ts
// ponytail: one writer per Workspace is enough; add leases only if duplicate owning windows become supported
```

## Polling

Each Instance scans the database once per second and emits only when its observable snapshot changes.

```ts
// ponytail: profile-local polling is enough; add IPC or indexing only when scan cost or latency is measurable
```

Do not add `fs.watch`, sockets, a server, a daemon, a database dependency, or a lock manager.

## Ownership rules

- An Instance may activate a Workspace when the user opens or adds it.
- Only the Instance with that Workspace currently open may mark it inactive.
- Only that Instance may create, update, or remove its Thread records.
- Every other Instance only reads those records.
- A Project is shown whenever at least one of its Workspaces is active.
- An inactive Workspace is not shown.

The first version assumes VS Code does not open the same Workspace in two windows. If that becomes possible, add an ownership lease rather than guessing between writers.

## Migration

Migration reads the old aggregate values once after the new database opens successfully:

- Existing Git roots are discovered into active Git Workspace records.
- Existing untracked folders become active untracked Workspace records.
- Existing Thread registrations become Thread records for their Workspace.
- Old values remain untouched for rollback.
- A version marker is written only after the import succeeds.
- Existing `profile-db-v1` records always win over old values.

Paths that were already absent from the old visible lists need no new record.

## Implementation sequence

### Phase 0: Pin the model

- Update `CONTEXT.md` and the ADR.
- Replace the old synchronization plan with this file-database model.
- Confirm the public test seams remain Profile Database, Projects/Threads, and MischiefView/webview messages.

### Phase 1: Workspace records

Through a real temporary directory, prove that one Instance activating a Workspace becomes visible to another Instance after polling.

Implement only Workspace files, validation, atomic replacement, timestamps, immutable snapshots, polling, and change emission.

### Phase 2: Projects integration

Through `Projects`, prove that active Git and untracked Workspaces render correctly and inactive Workspaces do not. Derive Projects from `projectRoot`; keep Git discovery inside `Projects`.

Remove the old aggregate Projects storage after migration is ready.

### Phase 3: Workspace ownership and migration

- Prove a non-owning Instance cannot mark a Workspace inactive.
- Prove the owning Instance can mark its current Workspace inactive.
- Import the old visible Project and untracked Workspace paths exactly once.
- Wire startup and clean disposal.

### Phase 4: Thread records and migration

Move durable Thread registrations behind the database. Preserve every existing durable field, selection behavior, ACP restoration, and the current Thread status values. Enforce that only the owning Workspace Instance writes them.

### Phase 5: UI polling

Subscribe MischiefView to database changes and render the same active Workspaces and Thread statuses in every open Instance. Keep `Workspace.current` local to each window.

### Phase 6: Final verification

Run focused tests after every slice, then `pnpm check`. Review the complete diff for duplicate storage layers, pass-through wrappers, unnecessary configuration, watchers, locks, and invented infrastructure.

## Acceptance criteria

- Every running Instance reads the same Workspace and Thread records within two seconds.
- Active Workspaces are shown; inactive Workspaces are hidden.
- Projects are derived by grouping active Git Workspaces by canonical Project root.
- Untracked Workspaces remain under `Ungrouped`.
- Only the current Workspace's Instance can mark it inactive or update its Threads.
- Thread status remains `idle`, `running`, `waiting`, or `error`.
- No Instance overwrites another Workspace's Threads.
- ACP transcript history is not copied into the database.
- Profile Database imports no `vscode` module.
- No runtime dependency, broker, socket, watcher, daemon, or lock manager is added.
