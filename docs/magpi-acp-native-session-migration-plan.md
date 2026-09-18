# MagPi ACP 1.4 and Pi-native session operations migration plan

- **Prepared:** 2026-09-17
- **Mischief baseline:** `01141fe16373bfc6ca921b6de6c352c41e7f09a5` (`origin/dev`, package `0.2.0`)
- **MagPi behavioral target:** `58d287d37d31e52b2e1e89bb49984e59666488fa` (`origin/dev`)
- **Current published MagPi baseline:** `cc3b509a878073c638f1b213e39069dbea1b6770` / npm `0.1.0`
- **Status:** implementation-ready except for assigning the umbrella Mischief issue and publishing a versioned MagPi release

This is an explicitly requested, noncanonical working artifact. GitHub Issues remain the canonical specifications. Before implementation begins, copy or link the approved core migration scope into a Mischief issue; use existing Mischief issues [#26](https://github.com/digital-overground/mischief/issues/26), [#27](https://github.com/digital-overground/mischief/issues/27), and [#28](https://github.com/digital-overground/mischief/issues/28) for their already-defined follow-up work.

## Executive summary

MagPi's current `origin/dev` replaces Mischief transcript-ID-based fork and rollback behavior with Pi-native session operations:

- fork targets come from Pi's `get_fork_messages` and carry native Pi user-entry IDs;
- targeted fork sends `_meta["magpi-acp/fork-entry-id"]` on the standard unstable ACP fork request;
- tree targets come from Pi's `get_tree` and carry native Pi entry IDs;
- tree navigation changes the active branch of the same ACP session through `_magpi-acp/session/navigate-tree`;
- prompts no longer carry `_meta["magpi-acp/client-message-id"]`;
- `_magpi-acp/session/rewind` no longer exists;
- MagPi no longer generates a model-based title after the first prompt; and
- MagPi and Mischief should both use `@agentclientprotocol/sdk` `1.4.x` while remaining on ACP v1.

Leaving Mischief unchanged is unsafe. The old rollback call fails because its private method was removed. More importantly, the old targeted-fork metadata is ignored by new MagPi, so a user who chooses an earlier transcript row can silently clone the current leaf instead of forking at the selected point.

The migration should therefore:

1. upgrade Mischief to ACP SDK `^1.4.0` and make the required elicitation/auth compatibility changes;
2. consume MagPi's advertised private picker capabilities and decode all private responses at the ACP boundary;
3. remove transcript-row fork/rollback UI and all old ID translation;
4. add separate **Fork Thread** and **Navigate Thread Tree** composer-footer actions;
5. open native VS Code QuickPicks whose selected native IDs stay in the extension host;
6. reload the same Thread after tree navigation and load one child Thread after fork;
7. generate a deterministic first-prompt Thread name in Mischief; and
8. publish Mischief's compatibility release before publishing the breaking MagPi behavior.

No profile-database migration, second persistence layer, custom Webview tree, model title call, new runtime dependency, or direct Pi-session-file reader is needed.

## Confirmed product decisions

These decisions are settled for this migration:

- Add **two** composer-footer actions: **Fork Thread** and **Navigate Thread Tree**.
- Each action opens a native VS Code QuickPick.
- Remove transcript-row fork and rollback actions rather than adapting them.
- Do not add or restore a composer `/tree` workflow.
- Fork only from Pi-native user-message targets returned by `get_fork_messages`.
- Navigate to Pi-native user or assistant message targets returned by `get_tree`.
- Keep tree navigation in the existing Thread and ACP session.
- Use `summarize: false`; richer branch-summary controls remain Mischief #27.
- Hide non-message tree entries initially; support remains Mischief #26.
- Generate the initial Thread name locally from the first prompt; no second model call.
- Preserve explicit user renames and continue accepting standard ACP title updates.
- Keep GitHub Issues canonical; this file explains sequencing and cross-issue integration.

## Domain language

Implementation, tests, and user-facing copy must follow `CONTEXT.md`:

- **Project** is the logical codebase.
- **Workspace** is the concrete folder or linked worktree.
- **Thread** is the user-visible conversation in a Workspace.
- **Agent** is the fixed MagPi-backed implementation.
- **ACP session** is used only at the protocol boundary.
- **Pi entry** or **Pi tree** is appropriate only when describing the Agent-private native target returned by MagPi.

User-facing text should say **Thread**, not session. Internal protocol code may use `sessionId` because that is the ACP field.

## Baselines and source scope

### Mischief

The plan was prepared against Mischief `origin/dev` at `01141fe`:

- package version `0.2.0`;
- `@agentclientprotocol/sdk` `^0.26.0`;
- current fork metadata `_meta["magpi-acp/client-message-id"]`;
- current rewind capability `magpi-acp/tree-rewind` and method `_magpi-acp/session/rewind`;
- current transcript-row selector in `history-control.tsx`; and
- current Agent title handling that already protects `manualName`.

### MagPi

The behavioral comparison starts at `8f6d950` and ends at `58d287d`:

| Commit | Behavior relevant to Mischief |
| --- | --- |
| [`68a65ed`](https://github.com/digital-overground/magpi-acp/commit/68a65eda2b82ff318d71f11e6f37c056289cdda2) | Upgrades MagPi to ACP SDK `1.4.0`. |
| [`98efbd3`](https://github.com/digital-overground/magpi-acp/commit/98efbd3700e662a9f4ab1c97d823e13a7a95a127) | Resolves a prompt on Pi `agent_settled`, not low-level `agent_end`. |
| [`03c887c`](https://github.com/digital-overground/magpi-acp/commit/03c887c62f699fc2d26ff8708be80445a363fb64) | Adds Pi-native fork/tree operations and deletes transcript-ID correlation. |
| [`6b308eb`](https://github.com/digital-overground/magpi-acp/commit/6b308ebd0cf8ffe4484584667990a915d29353bc) | Removes MagPi's redundant `SessionStore`; ACP IDs now resolve directly through Pi history. |
| [`f2022f1`](https://github.com/digital-overground/magpi-acp/commit/f2022f1288f8212234afdd0b1b289ed5e3d0eafa) | Uses Pi-native slash commands and stops advertising the old `/tree` selector. |
| [`d5682e6`](https://github.com/digital-overground/magpi-acp/commit/d5682e6680bc03229261ba3f808419287a75bb38) | Removes unused private startup/queue metadata and emits standard option descriptions. |
| [`58d287d`](https://github.com/digital-overground/magpi-acp/commit/58d287d37d31e52b2e1e89bb49984e59666488fa) | Removes MagPi's model-generated automatic naming. |

The unrelated formatter/linter migration on another MagPi ref is outside this plan. The sibling MagPi checkout's existing modified `README.md` is not part of this work and must remain untouched.

### Release state

As of 2026-09-17:

- MagPi `origin/dev` contains the target behavior at `58d287d`;
- MagPi `origin/main` and tag `v0.1.0` remain at `cc3b509`;
- `npm view magpi-acp version` reports `0.1.0`; and
- MagPi's target `package.json` still says `0.1.0`.

The target is therefore a source contract, not an installable release yet. The eventual published version must be recorded in Mischief's compatibility documentation before release.

### Pi and ACP

- MagPi #4 requires Pi `0.80.4` or newer.
- The inspected local Pi `0.85.1` RPC types expose `clone`, `fork`, `get_fork_messages`, `get_entries`, and `get_tree`; `SessionTreeNode` carries an entry, children, and optional label metadata.
- ACP SDK `1.4.0` remains on stable ACP v1. Experimental ACP v2 is not part of this migration.

## Compatibility spike result

A clean copy of Mischief with only `@agentclientprotocol/sdk` changed from `^0.26.0` to `^1.4.0` fails TypeScript only in `src/threads/acp.ts`. The failures identify the complete SDK source-migration surface:

1. `Client.unstable_createElicitation` became `Client.createElicitation`.
2. `ElicitationPropertySchema` is now an extensible union, so `schema.type` alone does not narrow known payloads.
3. `enum`, `oneOf`, array `items`, `title`, `description`, and `default` must be read after using the SDK's validated `ElicitationPropertySchema.isString/isNumber/isInteger/isBoolean/isArray` guards.
4. Unknown/custom schema variants must fail closed rather than being treated as ordinary text fields.

No compile errors occurred outside `src/threads/acp.ts`. A separate wire probe initialized published MagPi `0.1.0` successfully from SDK `1.4.0` while advertising both standard and private terminal-auth capabilities, confirming the intended backward-compatible initialize shape.

Do not combine this upgrade with migration to the SDK's app-style API: `ClientSideConnection` remains a supported deprecated compatibility wrapper and replacing it would add unrelated risk. Use its generic `request()` for the new private methods instead of adding more `extMethod()` calls.

## Current failure modes

### P0: old targeted fork silently means something else

Current Mischief calls ACP fork with:

```ts
_meta: { "magpi-acp/client-message-id": messageId }
```

Target MagPi looks only for:

```ts
_meta: { "magpi-acp/fork-entry-id": entryId }
```

With the old key, target MagPi sees no native target and takes the standard metadata-free path: Pi `clone()` at the current leaf. The request can succeed while violating the user's selected fork point. If Mischief then restores the selected older prompt as a child draft, the displayed child state and draft are inconsistent.

This is the release-order reason to ship compatible Mischief before target MagPi.

### P0: rollback method was removed

Current Mischief calls `_magpi-acp/session/rewind`. Target MagPi exposes `_magpi-acp/session/navigate-tree` instead. The old call receives method-not-found and cannot update the Thread.

### P1: MagPi no longer names live Threads

After `58d287d`, a newly created Thread remains `New Thread` unless the Agent later sends an explicit standard title, such as from Pi `/name`. Mischief #28 owns the replacement behavior.

### P1: SDK 1.4 does not compile without ACP adapter changes

The dependency bump cannot be merged independently unless the elicitation handler and schema narrowing change in the same commit.

### P2: terminal auth is still negotiated privately

Mischief currently sends `_meta["terminal-auth"]`; ACP 1.4 standardizes `clientCapabilities.auth.terminal`. Target MagPi still reads the private flag, while MagPi #5 will move to the standard flag. Mischief should advertise both during the compatibility window and parse standard terminal methods first.

## Protocol contract matrix

| Concern | Current Mischief / old MagPi | MagPi target `58d287d` | Required Mischief behavior |
| --- | --- | --- | --- |
| ACP SDK | `^0.26.0` | `^1.4.0` | Upgrade to `^1.4.0`; remain on ACP v1. |
| Prompt completion | MagPi could resolve on `agent_end` | Resolves on `agent_settled` | No protocol change; retain queue regression coverage. |
| Prompt metadata | Sends `magpi-acp/client-message-id` | Ignores and no longer stores it | Remove message ID from `AgentConnection.prompt()` and ACP prompt `_meta`. |
| Transcript IDs | Cross the Agent seam for fork/rollback | Local UI concern only | Keep IDs for React keys, merging, queueing, and optimistic display; never use them as Pi targets. |
| Standard fork without target | Not used by Mischief | Pi `clone()` at current leaf | Preserve as MagPi behavior; Mischief's dedicated action always supplies a picker target. |
| Fork-target discovery | Current transcript rows | `_magpi-acp/session/fork-messages` | Fetch on demand and decode native `{ entryId, text }` values. |
| Targeted fork | Old client-message metadata | `_meta["magpi-acp/fork-entry-id"]` | Send the selected native Pi user-entry ID on `unstable_forkSession`. |
| Assistant fork | Old timestamp/ID bridge attempted support | Unsupported by Pi fork | Do not offer assistant entries in the fork picker. |
| Tree discovery | Transcript rows | `_magpi-acp/session/tree` | Fetch and flatten native Pi tree message entries for a QuickPick. |
| Tree navigation | `_magpi-acp/session/rewind` | `_magpi-acp/session/navigate-tree` | Send native entry ID; reload the same ACP session; create no Thread. |
| Tree summary | Implicit old rewind behavior | No-summary initial path | Do not send summary controls; defer to #27. |
| Tree entry kinds | User/assistant transcript rows | Full Pi tree | Initially expose user/assistant messages only; defer other useful entries to #26. |
| Picker capability | `magpi-acp/tree-rewind` | `magpi-acp/fork-picker`, `magpi-acp/tree-picker` | Strictly consume advertised booleans and gate the two actions. |
| `/tree` | Agent-advertised slash command | Removed in favor of native operation | Add no filter or replacement command; the target Agent simply stops advertising it. |
| Session identity | MagPi mapping file plus Pi discovery | Direct Pi-native session ID discovery | No Mischief schema change; validate existing Threads through load/history before release. |
| Load replay IDs | Optional ACP message IDs used by old bridge | MagPi replay no longer supplies target IDs | Continue supporting optional ACP `messageId` for generic transcript merging, but never require it for operations. |
| Auto naming | MagPi model call and ACP title update | Removed | Generate and persist a deterministic first-prompt name in Mischief. |
| Explicit title | Standard `session_info_update.title` | Still supported, including Pi `/name` | Continue applying it only while `manualName` is false. |
| Elicitation handler | `unstable_createElicitation` | SDK stable `createElicitation` | Rename handler and use validated schema guards. |
| Choice description | Private `_meta.magPiAcp.description` | Standard `description` | Prefer standard field; retain private fallback temporarily. |
| Terminal auth advertisement | Private `_meta["terminal-auth"]` | Target still private; ACP 1.4 standard available | Advertise standard and private flags until MagPi #5 lands. |
| Terminal auth descriptor | Private `_meta` parsing | Standard `type: "terminal"`, `args`, `env`, optional old metadata | Parse standard shape first; keep fallback for old MagPi. |
| Private startup/queue metadata | MagPi emitted values Mischief did not consume | Removed | No work. Do not recreate them. |
| MCP servers | Mischief sends `[]` | Empty array remains accepted | Keep `mcpServers: []`; defer non-empty support to MagPi #8. |
| Session deletion | Unsupported and intentionally absent | Still unsupported | Keep Thread removal as unregister-only; do not add deletion. |

## Target architecture

```text
Composer footer action
  -> id-free Webview message
  -> MischiefView native QuickPick
  -> Threads selected-Thread guard
  -> AgentConnection private ACP boundary
  -> MagPi private picker method
  -> Pi native IDs
  -> selected ID remains in extension host
  -> MagPi validates ID against current Pi session
  -> Pi native fork or tree navigation
```

The direction is deliberate:

- the Webview requests an action but never receives or returns Pi entry IDs;
- `MischiefView` owns VS Code UI only;
- `Threads` owns Thread lifecycle, status, persistence, and stale-selection checks;
- `AcpConnection` owns exact ACP/private method names, metadata, and untrusted payload decoding;
- MagPi owns Pi RPC and validates that a selected ID belongs to the current source session; and
- Pi owns the tree, active leaf, fork semantics, and navigation semantics.

Do not introduce a tree repository, fork service, navigation controller, or cache. These are on-demand operations on the existing Agent connection.

## Proposed internal contracts

The names below are illustrative but the separation is required.

```ts
export interface AgentSessionOperations {
  forkPicker: boolean;
  treePicker: boolean;
}

export interface AgentSession {
  sessionId: string;
  configOptions: ThreadConfigOption[];
  operations: AgentSessionOperations;
}

export interface AgentForkTarget {
  entryId: string;
  text: string;
}

export interface AgentTreeTarget {
  entryId: string;
  role: "user" | "assistant";
  text: string;
  depth: number;
  activeBranch: boolean;
  current: boolean;
}

export interface AgentTreeNavigationResult {
  draft?: string;
}
```

The Agent seam becomes conceptually:

```ts
export interface AgentConnection {
  // Existing create/load/history/cancel/config methods remain.
  forkTargets(sessionId: string): Promise<AgentForkTarget[]>;
  fork(sessionId: string, cwd: string, entryId: string): Promise<AgentSession>;
  treeTargets(sessionId: string): Promise<AgentTreeTarget[]>;
  navigateTree(
    sessionId: string,
    entryId: string
  ): Promise<AgentTreeNavigationResult>;
  prompt(
    sessionId: string,
    text: string,
    images: PromptImage[]
  ): Promise<AgentPromptResult>;
}
```

Delete `rollback()`. Delete the `messageId` parameter from `prompt()` and rename the fork parameter to `entryId` so a transcript ID cannot accidentally cross the seam again.

`Threads` should return picker context with the source Thread ID:

```ts
interface ThreadForkTargets {
  threadId: string;
  targets: AgentForkTarget[];
}

interface ThreadTreeTargets {
  threadId: string;
  targets: AgentTreeTarget[];
}
```

The view passes that captured `threadId` back with the selected host-side item. `Threads` revalidates that the same Thread is still selected, idle, durable, and backed by the same runtime before mutating anything. This prevents a QuickPick left open while the user selects another Thread from applying a native ID to the wrong ACP session.

The regular Webview snapshot needs only optional presentation flags, such as `forkSupported`, `treeNavigationSupported`, and a transient `sessionOperation` busy flag. It must not contain Pi IDs or raw tree data.

## ACP adapter changes

### Initialization and capability capture

Capture the `initialize()` response instead of discarding it. Read only strict booleans:

```text
agentCapabilities._meta["magpi-acp/fork-picker"] === true
agentCapabilities._meta["magpi-acp/tree-picker"] === true
```

Unknown, missing, malformed, or false values mean unsupported. Return the resulting operation flags with every `create()` and `load()` setup. `Threads` stores them in the in-memory runtime only; they do not belong in the Profile Database.

Do not infer support from Agent name/version, probe methods speculatively, or parse semver. Capability advertisement is the contract.

### Private request constants

Keep the exact names in `src/threads/acp.ts`:

```text
magpi-acp/fork-picker
magpi-acp/tree-picker
_magpi-acp/session/fork-messages
_magpi-acp/session/tree
_magpi-acp/session/navigate-tree
magpi-acp/fork-entry-id
```

Use `ClientSideConnection.request<Response, Params>(method, params)` for private methods. Decode the returned `unknown` value before exposing it to `Threads`.

### Fork-target response

Accept only an object with a `messages` array. Every usable element must have:

- a non-empty string `entryId`; and
- string `text`.

Reject a malformed response as one Agent error rather than partially trusting arbitrary entries. Preserve Pi's returned order. Do not join the result to transcript items.

### Tree response

Accept only:

- an object containing `tree` as an array;
- `leafId` as a string or `null`;
- recursively valid nodes with `entry` and `children`; and
- entries with non-empty string IDs.

Traverse in Pi's preorder and expose only entries whose `type` is `message` and whose message role is `user` or `assistant`.

For display text:

- accept a string message body;
- otherwise concatenate text content blocks;
- normalize line breaks/whitespace only for the QuickPick label;
- retain the extracted text for the host-side item detail; and
- use a neutral fallback such as `Image prompt` or `Assistant message` if a message has no text block.

Set `current` when the message entry ID equals `leafId`. Set `activeBranch` for the leaf and its ancestors. If the exact leaf is a filtered non-message entry, the view can mark the deepest visible `activeBranch` target without inventing a selectable ID. Only the separate fork-target response text and tree-navigation response draft may populate composer drafts. Mischief #26 will make useful non-message leaves directly visible later.

Ignore labels, ages, hidden custom entries, model changes, thinking-level changes, and other metadata in this release.

### Targeted fork request

Call `unstable_forkSession()` with:

```ts
{
  cwd,
  sessionId,
  _meta: { "magpi-acp/fork-entry-id": entryId }
}
```

Do not include the old key, transcript item ID, timestamp, role, or text. MagPi performs authoritative validation against `get_fork_messages`.

### Tree navigation request

Call `_magpi-acp/session/navigate-tree` with only:

```ts
await connection.request(NAVIGATE_TREE_METHOD, { sessionId, entryId });
```

Target MagPi owns the `summarize: false` choice and returns the resulting `leafId` plus `draft: string | null`. Decode the result. A non-empty string draft becomes the generated user draft; `null` or empty means no generated draft.

### Prompt request

Change `AcpConnection.prompt()` to construct only the standard prompt request:

```ts
{
  sessionId,
  prompt: await promptContent(...)
}
```

There must be no prompt `_meta` and no Agent-seam message ID. Optimistic transcript IDs remain local to `Threads`.

### ACP SDK 1.4 elicitation

In the same dependency-bump commit:

- replace `unstable_createElicitation` with `createElicitation`;
- use the SDK's value-level `ElicitationPropertySchema` guards for every known variant;
- prefer each standard `oneOf`/`anyOf` option's `description`;
- retain `_meta.magPiAcp.description` only as an old-MagPi fallback;
- preserve current form validation and accepted-content construction; and
- return a decline/cancel response without opening an invalid form if any custom or malformed schema variant cannot be represented.

Add one regression case for an unknown future property type. It must not be rendered as a text field or accepted accidentally.

### Terminal authentication

Advertise both forms during the compatibility window:

```ts
clientCapabilities: {
  auth: { terminal: true },
  _meta: { "terminal-auth": true },
  elicitation: { form: {} },
  plan: {}
}
```

When an auth-required error supplies methods:

1. prefer a standard method with `type === "terminal"`;
2. validate its `args` and `env` as arrays/string maps;
3. reproduce Mischief's configured Agent invocation, appending the method arguments and applying the environment overrides;
4. never pass a terminal method to ACP `authenticate`;
5. observe closure of the exact VS Code terminal Mischief opened;
6. on exit code zero, dispose the failed ACP connection and run the existing retry path so initialization happens again;
7. on nonzero/unknown exit or cancellation, leave the Thread in its retryable authentication error state; and
8. retain the current private metadata parser only as fallback for published MagPi `0.1.0`.

The reconnect step is required before Mischief honestly advertises standard terminal support. Remove the private fallback only after MagPi #5 ships and the supported compatibility window no longer includes `0.1.0`.

## Thread-domain behavior

### Preconditions shared by both actions

`Threads` must require:

- an active Workspace;
- a selected, persisted Thread;
- a non-empty ACP `sessionId`;
- a live runtime and Agent connection;
- `status === "idle"`; and
- the corresponding advertised operation capability.

Check before fetching targets and again after the picker returns. A stale picker, changed selection, running turn, disposed runtime, or changed ACP session must fail before mutation with a useful `Mischief: ...` error.

Do not treat either operation as implicit cancel. The user must stop an active turn first.

### One operation at a time

After the post-picker check and before the mutating ACP call, set one transient runtime flag such as `sessionOperation: "fork" | "navigateTree"`. Clear it in `finally`; do not persist it or overload the Agent turn status.

While that flag is set:

- another fork/tree operation is rejected;
- prompting that same Thread is blocked before the composer text is cleared;
- its Send and session-operation buttons are disabled; and
- selecting or using another Thread remains allowed.

If the user selects another Thread while a fork is in flight, preserve the newer explicit selection. Register the successfully created child, but select it only if the source is still selected. Tree navigation may finish and reload its source runtime in the background without stealing selection. This is the minimum synchronization needed to prevent an Agent prompt and a native tree mutation from overlapping.

### Fork Thread flow

1. The Webview sends `{ type: "forkThread" }` with no row or message ID.
2. `MischiefView` requests fork targets for the selected Thread.
3. `Threads` checks the preconditions and asks the current Agent connection.
4. The adapter calls `_magpi-acp/session/fork-messages` and decodes Pi-native user targets.
5. The view opens **Fork Thread** and keeps the source Thread ID plus each native target in host-side QuickPick items.
6. Escape or hide exits with no side effect.
7. After selection, `Threads` revalidates the source context.
8. The adapter sends the native `entryId` through `magpi-acp/fork-entry-id`.
9. MagPi/Pi creates one child ACP session and leaves the source session/process unchanged.
10. Mischief creates one new persisted Thread record named `<source name> (fork)`, selects it, and loads the child session through a fresh Agent connection.
11. The selected user text becomes one generated draft in the child Thread.
12. The source Thread record, transcript, composer draft, ACP session, and active Pi leaf remain unchanged. The Workspace selection moves to the child only if the source is still selected when the fork returns.

If child load fails after fork creation, keep the child Thread registered with the existing error/retry behavior. Do not attempt to delete the valid Pi child.

### Navigate Thread Tree flow

1. The Webview sends `{ type: "navigateThreadTree" }` with no message ID.
2. `MischiefView` requests tree targets for the selected Thread.
3. The adapter calls `_magpi-acp/session/tree`, validates the response, filters it to user/assistant messages, and flattens it in native preorder.
4. The view opens **Navigate Thread Tree** with the source Thread context stored only in host memory.
5. Escape or hide exits with no side effect.
6. After selection, `Threads` revalidates the source context.
7. The adapter sends the selected native `entryId` to `_magpi-acp/session/navigate-tree`.
8. On success, clear the runtime transcript and replay the same `sessionId` through the existing ACP `session/load` operation.
9. Keep the same Mischief Thread ID, name, `manualName`, creation time, registration, Workspace, and ACP session ID.
10. Update the Thread's `updatedAt`, clear prior recoverable error/auth state, and persist the resulting idle/error status.
11. If MagPi returns a user draft, enqueue it once; assistant selection creates no generated draft.
12. Preserve any text the user had already typed in Mischief's per-Thread local composer. The existing incoming-draft behavior may append the generated user text separated by a blank line; tree navigation must never silently discard an unsent draft.

Clear the old transcript only after native navigation succeeds. The current private `Threads.load()` intentionally returns when a runtime already exists, so navigation must use an explicit reload path (or a small shared load helper) that calls `runtime.connection.load()` for that existing runtime and reapplies returned configuration/capabilities. Do not dispose the source connection before the private navigation request completes.

If navigation fails, the old transcript remains authoritative. If navigation succeeds but replay fails, leave the Thread in the existing retryable error state with no stale pre-navigation transcript; retry reloads the Agent's now-current branch.

Selecting the already-current visible leaf may be treated as a harmless reload. Do not add a special confirmation or destructive warning: Pi preserves the alternate branch and navigation is not deletion.

### Replay and optional message IDs

Do not remove generic optional `messageId` support from `translateSessionUpdate()` or the transcript reducer. Other Agents or live ACP updates may still use IDs to merge chunks. Remove only the operation coupling:

- delete `agentMessageId()`;
- remove transcript lookup from fork/rollback;
- remove prompt client-message metadata; and
- never compare timestamps to discover a Pi target.

### Session identity after `SessionStore` removal

Modern MagPi already used Pi's `state.sessionId` as the ACP session ID and stored the same value in its map. The target simply removes the redundant map and discovers Pi history directly, so current Mischief records need no schema migration.

A historical record created by an old Pi version that did not return `state.sessionId` could contain a synthetic MagPi alias that target MagPi can no longer resolve. Do not make Mischief read the deleted Agent-private mapping. Before rollout, load representative existing Threads against target MagPi. If an alias is encountered, the recoverable path is to remove the stale Mischief registration and reopen the native session from **Thread History**. Document a broader migration only if real aliases are found.

## Native QuickPick specification

### Shared behavior

Both actions use VS Code native QuickPick, not a Webview popup.

- Show a busy loading picker while the Agent target request is pending.
- Hiding the loading picker ignores the eventual response and performs no mutation.
- Fetch fresh targets every time; do not cache native IDs.
- Keep native IDs and source Thread context on QuickPick item objects in the extension host.
- Normalize labels to one line for readability but retain full target text for drafts.
- Use VS Code's native fuzzy filtering.
- Let existing top-level `Mischief: <message>` error handling report failures.

### Fork Thread picker

- Footer title and accessible name: **Fork Thread**.
- Picker title: **Fork Thread**.
- Placeholder: **Select a user message to edit in a new Thread**.
- Entries: user prompts in Pi's returned order.
- Label: compact one-line prompt preview.
- Detail: optional remaining/full text when the prompt spans lines.
- Empty result: `No fork points are available in this Thread.`
- Selection result: one new child Thread and one generated draft.

### Navigate Thread Tree picker

- Footer title and accessible name: **Navigate Thread Tree**.
- Picker title: **Navigate Thread Tree**.
- Placeholder: **Select a message to make active**.
- Entries: user and assistant messages in native preorder.
- Visual structure: indent by visible tree depth; identify role as **You** or **Agent**.
- Current state: mark the exact visible `leafId` as **current leaf**. If the leaf is a deferred non-message entry, mark the deepest visible ancestor as **active branch**.
- Empty result: `No message entries are available in this Thread tree.`
- Selection result: same Thread reloaded at the selected branch.

Do not add branch labels, dates, keyboard-parity shortcuts, a preview editor, or a custom tree widget in this phase.

## Composer-footer and Webview changes

Replace `HistoryControl` with two ordinary icon buttons next to **New Thread**:

- reuse the existing `fork` icon for **Fork Thread**;
- reuse `gitBranch` for **Navigate Thread Tree**;
- use real `<button type="button">` controls;
- set matching `title` and `aria-label` values;
- render only when the Agent advertised the matching capability; and
- disable while the selected Thread is not idle or already has a session operation in flight.

The composer Send action must also be disabled/ignored for that Thread while the transient session-operation flag is set, so its draft cannot be cleared by a prompt that the domain will reject.

The Webview messages are id-free:

```ts
postMessage({ type: "forkThread" });
postMessage({ type: "navigateThreadTree" });
```

Delete:

- `src/webview/threads/detail/composer/controls/history-control.tsx`;
- transcript-row action tests;
- `rollbackThread` protocol messages;
- row-action CSS and popup positioning code; and
- the now-unused `rollback` SVG kind/path.

Keep the Navigator's Workspace-level **Thread History** action and its `history` icon. That feature lists inactive Threads and is unrelated to the deleted composer transcript-history popup.

No explicit client `/tree` code exists today: slash autocomplete renders whatever the Agent advertises. Target MagPi no longer advertises `/tree`, so do not add a command blocklist merely to hide it from old MagPi.

## Automatic Thread naming (Mischief #28)

### Algorithm

Generate the first local name from the first optimistic user item:

1. use prompt text, or `Pasted image` for an image-only prompt;
2. collapse all whitespace runs to one ASCII space;
3. trim leading/trailing whitespace;
4. keep at most 80 Unicode code points including the ellipsis;
5. if longer, keep the first 79 code points, trim trailing whitespace, and append `…`.

Examples:

| First prompt                 | Stored automatic name         |
| ---------------------------- | ----------------------------- |
| `Fix the failing setup test` | `Fix the failing setup test`  |
| `Explain\n\nthis   module`   | `Explain this module`         |
| image only                   | `Pasted image`                |
| more than 80 code points     | first 79 code points plus `…` |

This is deterministic, instant, free, and adequate because Navigator already visually truncates long labels. Do not add a setting, title service, stop-word logic, semantic summarizer, or model call.

### When to apply it

Apply once, when `Threads.prompt()` accepts the first local user prompt and before the initial persistence write for that prompt, only when:

- the current name is exactly `New Thread`;
- `manualName` is not true; and
- the runtime contains no earlier user item.

This gives a failed first attempt a useful persisted name and avoids a second state transition. Retry and later prompts do not rename it.

### Precedence

Name precedence remains:

1. explicit user rename in Mischief (`manualName: true`);
2. standard ACP title updates while no explicit rename exists;
3. Mischief's deterministic first-prompt fallback;
4. `New Thread` before the first prompt.

Therefore:

- a user rename before or after the first prompt is permanent until the user renames again;
- an Agent `session_info_update.title`, including Pi `/name`, may replace the generated fallback;
- an Agent title never replaces an explicit user rename; and
- no client-to-Agent rename RPC is invented.

The generated name already fits the existing Profile Database schema. Add no field and no migration. It is a Mischief display name, not a Pi session rename: after a Thread is removed and later reopened from Agent history, use the Agent's explicit title or first-prompt fallback returned by `session/list`, even if that differs from the prior 80-code-point local name.

## Backlog and issue mapping

### Required for the core migration

| Tracker | Issue | Plan responsibility |
| --- | --- | --- |
| Mischief | **New umbrella migration issue needed** | SDK 1.4, capability consumption, native fork/tree pickers, old-action removal, release coordination. This document may be linked rather than copied in full. |
| Mischief | [#28 — Own automatic Thread naming in Mischief](https://github.com/digital-overground/mischief/issues/28) | Implement the deterministic first-prompt algorithm and precedence above. |
| MagPi | [#1 — Wait for Pi `agent_settled`](https://github.com/digital-overground/magpi-acp/issues/1) | Implemented on `origin/dev` by `98efbd3`; must be included in the release. |
| MagPi | [#3 — Upgrade ACP SDK to 1.4.0](https://github.com/digital-overground/magpi-acp/issues/3) | Implemented on `origin/dev` by `68a65ed`; must be included in the release. |
| MagPi | [#4 — Use Pi-native IDs for fork and tree navigation](https://github.com/digital-overground/magpi-acp/issues/4) | Implemented on `origin/dev` by `03c887c`; this plan implements the Mischief half. |

MagPi #1, #3, and #4 remain open even though the target branch contains their code. Treat merge, issue closure, version bump, publish, and smoke verification as release gates rather than assuming an open issue means the behavior is absent.

### Compatibility preparation, not blockers

| Issue | This migration's treatment |
| --- | --- |
| [MagPi #5 — standard Terminal Auth](https://github.com/digital-overground/magpi-acp/issues/5) | Advertise and parse the standard form now while retaining old private fallback. MagPi may switch later without another Mischief feature release. |
| [MagPi #6 — private picker capability negotiation](https://github.com/digital-overground/magpi-acp/issues/6) | Consume current server capability flags. Do not invent client flags before the coordinated contract is decided. |
| [MagPi #7 — standard session capability audit](https://github.com/digital-overground/magpi-acp/issues/7) | No client work beyond relying on advertised capabilities and metadata-free standard calls. |
| [MagPi #8 — stdio MCP](https://github.com/digital-overground/magpi-acp/issues/8) | Continue sending an empty array. Mischief exposes no MCP configuration. |

### Explicitly deferred

| Mischief issue | Deferred scope |
| --- | --- |
| [#26 — Support non-message entries in Pi tree navigation](https://github.com/digital-overground/mischief/issues/26) | Custom messages, compactions, and branch summaries as selectable targets. |
| [#27 — Add branch-summary controls](https://github.com/digital-overground/mischief/issues/27) | No summary, default summary, and custom-focus summary choices. Initial navigation remains no-summary. |

### Superseded or unrelated

- [Mischief #25](https://github.com/digital-overground/mischief/issues/25) is closed and explicitly superseded. Do not restore quick rollback with narrower guards.
- Workspace **Thread History** is already implemented and remains separate from Pi tree navigation.
- MagPi #2 session deletion remains intentionally deferred; removing a Mischief Thread still unregisters it without deleting Agent/Pi history.

## Implementation phases and TDD order

Keep the migration in one release branch. Individual commits may follow these phases, but do not publish an intermediate build that retains old targeted-fork UI against new MagPi.

### Phase 0 — Canonical tracking and frozen baselines

1. Create/approve one umbrella Mischief issue for the core migration and link this plan.
2. Record the final MagPi release commit and package version when available.
3. Confirm target MagPi still advertises the exact capability/method/key strings.
4. Confirm Pi minimum `0.80.4` in MagPi release notes and Mischief requirements.
5. Preserve the sibling MagPi checkout's unrelated `README.md` edit.

**Exit:** implementation has canonical tracking and no moving contract strings.

### Phase 1 — SDK 1.4 and standard ACP compatibility

1. Bump `@agentclientprotocol/sdk` to `^1.4.0` and regenerate `pnpm-lock.yaml`.
2. Add failing ACP adapter tests for:
   - stable `createElicitation` translation;
   - standard choice descriptions;
   - private description fallback;
   - unknown/custom elicitation schema rejection; and
   - standard terminal auth descriptor parsing.
3. Rename the client handler and replace discriminant-only narrowing with SDK guards.
4. Advertise both standard and legacy terminal-auth capabilities.
5. Add host/domain coverage for successful-terminal reconnect/retry and unsuccessful-terminal no-op, then implement that lifecycle through the existing retry path.
6. Keep `ClientSideConnection`; do not migrate SDK architecture.
7. Run `pnpm typecheck` and focused ACP/auth tests.

**Exit:** SDK `1.4.x` compiles, existing interactions still work, and no feature behavior has changed yet.

### Phase 2 — Native operation boundary and capability state

1. Add failing pure boundary tests for strict capability parsing, fork-target decoding, tree decoding/filtering, leaf marking, and malformed responses.
2. Add `AgentSessionOperations`, native target values, and new `AgentConnection` methods.
3. Capture initialize capabilities and expose them in create/load setup.
4. Implement the three private requests with `request()`.
5. Change targeted fork metadata to `magpi-acp/fork-entry-id`.
6. Remove prompt message ID and metadata.
7. Remove `rollback()` from the Agent seam.
8. Extend the fake Agent in `threads.test.ts` with native targets/navigation.

**Exit:** all private MagPi details are decoded behind one adapter; old message-ID contract strings are absent.

### Phase 3 — Fork Thread vertical slice and old UI deletion

1. Add a failing `Threads` test proving target retrieval is idle/capability gated.
2. Add a failing fork test proving the exact native ID is used, source state is unchanged, one child is persisted/loaded, and one user draft is restored.
3. Add stale-picker and load-failure cases.
4. Replace `Threads.fork(messageId)` with source-context plus native-target behavior.
5. Add failing host tests for loading, cancellation, empty results, picker labels, and selected target forwarding.
6. Add the id-free `forkThread` Webview action and native picker.
7. Add the footer button and capability/status accessibility tests.
8. Delete `HistoryControl`, transcript-row fork/rollback messages, confirmation modal, obsolete CSS, and rollback icon.

**Exit:** fork works only through Pi-native target selection; no transcript row can invoke a session operation.

### Phase 4 — Navigate Thread Tree vertical slice

1. Add a failing `Threads` test proving user navigation:
   - uses the native ID;
   - keeps Thread and ACP session identity;
   - reloads the new active branch;
   - replaces stale transcript state; and
   - queues the returned draft once.
2. Add assistant-selection coverage proving no generated draft.
3. Add guards for running status, unsupported capability, stale picker, navigation failure, and replay failure.
4. Add host tests for loading, cancellation, empty tree, preorder/depth/role/current presentation, and selection.
5. Add the id-free `navigateThreadTree` action and footer button.
6. Verify any pre-existing local composer text is preserved.

**Exit:** one Thread can move through its Pi tree without a new Thread, ACP session, or custom Webview tree.

### Phase 5 — Automatic Thread naming (#28)

1. Add failing domain tests for whitespace normalization, 80-code-point truncation, image-only prompt, and persistence on initial failure.
2. Add precedence tests:
   - second prompt does not rename;
   - pre-prompt explicit rename wins;
   - post-prompt explicit rename survives Agent updates;
   - standard Agent title replaces only the generated fallback.
3. Implement one local helper in `threads.ts` and call it in the existing first-prompt transition.
4. Update `CONTEXT.md`.

**Exit:** every first local prompt gets a useful free fallback name without changing persistence shape.

### Phase 6 — Documentation, integrated validation, and release readiness

1. Update `README.md` with the final minimum MagPi release and Pi `0.80.4` requirement.
2. Document upgrade commands for existing global MagPi installations.
3. Do not add setup version parsing: setup already installs npm's latest when missing, while runtime capabilities are the authoritative feature gate.
4. Run focused tests after each phase, then `pnpm check`.
5. Run local end-to-end validation against MagPi `58d287d` and Pi `0.85.1` or the final released equivalents.
6. Run a compatibility pass against published MagPi `0.1.0`.
7. Record the exact validated versions in the umbrella issue/release notes.

**Exit:** both compatibility directions are understood, all automated checks pass, and publish order is approved.

## Expected file changes

| File | Change |
| --- | --- |
| `package.json` | Bump ACP SDK to `^1.4.0`. |
| `pnpm-lock.yaml` | Regenerate dependency lock. |
| `src/threads/acp.ts` | SDK compatibility, capabilities, auth parsing, private request constants/decoders, native fork/tree calls, metadata-free prompts. |
| `src/threads/acp.test.ts` | Boundary, elicitation, capability, auth, fork/tree decoding coverage. |
| `src/threads/threads.ts` | Native target APIs, status/stale guards, child fork lifecycle, same-Thread replay, generated naming, old rollback deletion. |
| `src/threads/threads.test.ts` | Domain behavior, error paths, stale selection, reload, drafts, naming precedence. |
| `src/view.ts` | Two native QuickPick workflows; remove old row-action routing/modal. |
| `src/view.test.ts` | Picker loading/cancel/empty/selection and exact host-side target checks. |
| `src/webview/protocol.ts` | Two id-free actions; remove message-ID fork/rollback actions. |
| `src/webview/threads/detail/composer/composer.tsx` | Preserve/disable Send while a native session operation is in flight. |
| `src/webview/threads/detail/composer/controls/footer-controls.tsx` | Two capability-gated accessible buttons. |
| `src/webview/threads/detail/composer/controls/footer-controls.test.tsx` | Replace transcript popup/action tests with footer capability/status/action tests. |
| `src/webview/threads/detail/composer/controls/history-control.tsx` | Delete. |
| `src/webview/icon.tsx` | Remove only the unused rollback icon; reuse fork/git-branch icons. |
| `media/webview.css` | Delete popup/row-action styles; size the two footer buttons with existing action rules. |
| `src/webview/app.test.tsx` | Update only fixtures/integration assertions affected by the optional capability fields. |
| `CONTEXT.md` | Replace Agent-owned automatic naming language; describe native footer selectors and same-Thread tree navigation. |
| `README.md` | Final MagPi/Pi minimums and upgrade guidance. |

Files that should not need changes:

- `src/profile-database/profile-database.ts`: existing fields already support generated names and native session IDs.
- `src/threads/transcript.ts`: optional ACP message IDs remain useful locally; no tree logic belongs there.
- `src/setup.ts`: capability gating is more reliable than parsing an unreleased Agent version.
- `src/extension.ts`: connection factory and activation wiring remain unchanged.

## Automated test matrix

### ACP adapter

- SDK `1.4.x` compiles with `createElicitation`.
- Every known elicitation field variant uses the SDK validated guard.
- Unknown/custom property variants are not misrendered.
- Standard option descriptions win; legacy private descriptions still work.
- Standard terminal auth and legacy MagPi terminal metadata produce the same local launch shape.
- Successful terminal exit disposes/reinitializes the ACP connection and retries; unsuccessful exit does not.
- Picker capabilities require literal `true`.
- Valid fork targets preserve order/text/IDs.
- Malformed fork response fails as a whole.
- Tree flattening preserves preorder and visible depth.
- Only user/assistant message entries become first-release targets.
- String/array text extraction and fallback labels are deterministic.
- Exact visible leaf is marked; filtered leaf handling is honest.
- Navigation result accepts `draft` string or null and rejects malformed values.

### Threads domain

- Unsupported or non-idle Thread cannot fetch or invoke either operation.
- Target retrieval requires a durable selected Thread and session.
- A selection change while QuickPick is open invalidates the operation.
- A per-runtime transient lock prevents prompt/fork/tree overlap without changing persisted Thread status.
- A later explicit Thread selection is not stolen when an in-flight operation finishes.
- Fork passes the exact native Pi ID.
- Fork creates exactly one child record/runtime and does not alter source runtime.
- User fork restores one draft; no assistant fork target exists.
- Child load failure remains registered and retryable.
- Tree navigation passes the exact native Pi ID.
- Tree navigation keeps Mischief Thread ID and ACP session ID.
- Successful navigation clears old items and replays only the active branch.
- User navigation queues returned text once; assistant navigation does not.
- Navigation failure preserves old transcript.
- Replay failure removes stale transcript and leaves retryable error.
- Existing local composer draft is not silently discarded.
- Prompt calls no longer receive a local message ID.
- Generated names normalize/truncate exactly once.
- Manual names beat generated and Agent titles; Agent titles beat generated fallback.

### Extension host

- Both requests show cancellable busy state.
- Hiding the loading picker ignores late data.
- Empty messages are exact and no mutation follows.
- Fork picker contains only user targets.
- Tree picker contains user/assistant role, depth, and active marker.
- QuickPick cancellation is side-effect free.
- Selected host item, not browser payload, supplies the native ID.
- Existing `Mischief: <message>` path handles Agent errors.

### Webview

- Buttons render only for advertised capabilities.
- Buttons have exact title and `aria-label`.
- Buttons disable outside idle state.
- Clicks send id-free protocol messages.
- No transcript popup, row fork button, row rollback button, or rollback confirmation remains.
- Workspace **Thread History** remains intact.

### Regression

- create, prompt, cancel, queue/steering, config, permission, elicitation, auth, history, reopen, rename, remove, and transcript restoration remain green.
- Prompt queue starts the next item only after target MagPi's settled response.
- Old sessions with optional ACP message IDs still replay/merge.
- Empty `mcpServers` remains accepted.
- Full `pnpm check` passes.

## Manual validation script

Use an Extension Development Host with target MagPi and a disposable Workspace:

1. Create a Thread and send a multiline first prompt; verify the deterministic name appears immediately.
2. Send enough turns to produce at least two user messages and two assistant replies.
3. Type an unsent composer draft.
4. Open **Fork Thread**, cancel, and verify no state changes.
5. Reopen it, select the first user prompt, and verify:
   - a child Thread is created;
   - the source Thread remains unchanged;
   - the child transcript ends before the selected prompt; and
   - the selected prompt is the child draft.
6. Return to the source Thread and verify its unsent draft remains.
7. Open **Navigate Thread Tree**, cancel, and verify no state changes.
8. Navigate to an earlier user entry; verify the same Thread/session reloads and returned user text is added without losing the unsent draft.
9. Navigate to an assistant entry; verify same-Thread reload and no generated assistant draft.
10. Create an alternate branch, reopen the tree picker, and verify branch ordering/current marker.
11. Start a prompt and verify both actions are disabled until idle.
12. Rename the Thread explicitly, send another prompt, and run Pi `/name`; verify the explicit Mischief name remains.
13. In an unrenamed Thread, run Pi `/name`; verify the standard Agent title replaces the generated fallback.
14. Trigger Terminal Auth, exit the login process successfully, and verify Mischief reconnects/retries; repeat with nonzero exit and verify it stays retryable.
15. Reload VS Code and verify Thread names, registrations, selected branch transcript, and child Thread restoration.
16. Repeat ordinary create/prompt/load/auth/history against published MagPi `0.1.0`; native action buttons should be absent but core Thread behavior should remain safe.

## Release and rollback strategy

### Required publish order

1. **Publish Mischief compatibility first.** It supports old MagPi for ordinary Threads, removes dangerous old targeted operations, and hides native controls when capabilities are absent.
2. **Publish MagPi target second** under a version greater than `0.1.0`, including commits for MagPi #1, #3, and #4.
3. Update Mischief README/release notes with the actual minimum native-navigation MagPi version and upgrade command.
4. Announce that users must update Mischief before updating MagPi if they use fork/rollback in the old release.

This order matters:

| Combination | Result |
| --- | --- |
| New Mischief + old MagPi `0.1.0` | Ordinary Thread flows work; private terminal fallback works; native action buttons are absent. |
| New Mischief + target MagPi | Full native fork/tree and local naming work. |
| Old Mischief + old MagPi | Existing behavior remains unchanged until upgrade. |
| Old Mischief + target MagPi | Unsafe/incompatible: rollback fails and old targeted fork may clone the current leaf. Avoid this rollout state. |

### Rollback

- If target MagPi must be rolled back while new Mischief remains, the capabilities disappear and native controls hide; ordinary Threads continue.
- If new Mischief must be rolled back while target MagPi is live, roll MagPi back first. Never intentionally restore the old Mischief/new MagPi combination.
- Profile data needs no rollback because this plan changes no schema.
- Pi-native forked sessions and navigated branches remain valid Agent history even if the UI release is rolled back.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Stale native ID selected after tree changes | Fetch on every open, revalidate Thread context, and rely on MagPi's authoritative current-session validation. |
| QuickPick applies to a newly selected Thread | Carry source Thread ID host-side and revalidate after selection. |
| Silent old fork semantics | Remove old actions and publish Mischief before MagPi. |
| Navigation succeeds but replay fails | Remove stale transcript, preserve identity, show retryable error, and reload on retry. |
| User loses unsent draft | Preserve Webview per-Thread draft; append only generated user draft. |
| Agent sends malformed private response | Decode `unknown` strictly in `acp.ts`; reject before domain mutation. |
| Capability contract later becomes negotiated | Consume current server flags now; coordinate client flags under MagPi #6 rather than guessing. |
| Non-message current leaf is hidden | Mark visible active ancestor and complete exact support under #26. |
| Very large tree makes picker noisy | One on-demand O(n) flatten is acceptable initially; add filtering/paging only after measured need. |
| Historical synthetic ACP alias no longer resolves | Validate real existing Threads; recover through Thread History rather than reading Agent-private files. |
| Old MagPi terminal auth breaks after standardization | Advertise/parse standard and legacy forms during the compatibility window. |
| Generated name conflicts with later Agent name | Existing precedence intentionally allows standard Agent title to replace only the generated fallback. |
| MagPi target changes before publish | Pin and re-audit the final release commit, method strings, tests, and README. |

## Non-goals

- Assistant-message fork.
- Transcript-row fork or rollback shortcuts.
- Composer `/tree` invocation or a slash-command blocklist.
- A custom Webview tree/popup.
- Client-generated or translated Pi IDs.
- Timestamp matching, prompt markers, or ID maps.
- Direct Pi JSONL reads in Mischief.
- Branch labels, ages, preview editor, or Pi TUI keybinding parity.
- Non-message target selection in the first release (#26).
- Branch summary generation or controls in the first release (#27).
- Model-generated automatic titles.
- Client-to-Agent rename extension.
- ACP session deletion.
- Non-empty MCP server configuration.
- ACP v2 or SDK app-style connection migration.
- A MagPi version parser, update daemon, capability cache, or second storage schema.

## Acceptance criteria

### Protocol and dependency

- [ ] Mischief uses `@agentclientprotocol/sdk` `^1.4.0` and ACP v1.
- [ ] Elicitation uses stable `createElicitation` and validated SDK guards.
- [ ] Standard terminal auth is advertised and parsed with temporary old-MagPi fallback.
- [ ] Mischief consumes strict `fork-picker` and `tree-picker` capability flags.
- [ ] Private method responses are decoded from `unknown` at the adapter boundary.
- [ ] Prompts contain no `magpi-acp/client-message-id` metadata.
- [ ] Targeted fork contains only `magpi-acp/fork-entry-id` with a native Pi user-entry ID.
- [ ] No `_magpi-acp/session/rewind` or `magpi-acp/tree-rewind` reference remains.

### User experience

- [ ] The composer footer has separate accessible **Fork Thread** and **Navigate Thread Tree** actions when supported.
- [ ] Both actions are unavailable while the Thread is not idle or another session operation is in flight.
- [ ] Prompting cannot overlap a native session operation or clear an unsent composer draft.
- [ ] Both use native VS Code QuickPick and are cancellable without side effects.
- [ ] Transcript rows contain no fork or rollback controls.
- [ ] Fork offers only Pi-native user-message targets and creates one child Thread/draft.
- [ ] Tree navigation offers user/assistant message targets and reloads the same Thread/session.
- [ ] User navigation adds the returned user draft; assistant navigation adds none.
- [ ] Existing unsent composer text is preserved.
- [ ] No `/tree` client workflow is added.

### Naming and persistence

- [ ] The first prompt replaces `New Thread` with the specified deterministic name.
- [ ] Image-only first prompts become `Pasted image`.
- [ ] The generated value is persisted without a schema change.
- [ ] Later standard Agent titles may replace the generated fallback.
- [ ] Explicit user-renamed Thread names remain protected.
- [ ] Fork and navigation preserve the intended Thread/session identity rules.

### Quality and rollout

- [ ] Focused ACP, domain, host, and Webview tests cover success, cancellation, stale context, malformed responses, and failures.
- [ ] `pnpm check` passes.
- [ ] Manual validation passes against the final target MagPi/Pi versions.
- [ ] Ordinary Thread compatibility passes against MagPi `0.1.0`.
- [ ] A versioned MagPi release includes the `origin/dev` behavior before it is presented as supported.
- [ ] Mischief is published before the incompatible MagPi release.
- [ ] `README.md`, `CONTEXT.md`, canonical issues, and release notes agree.

## Primary sources

### MagPi source, tests, and issues

- [Target MagPi tree at `58d287d`](https://github.com/digital-overground/magpi-acp/tree/58d287d37d31e52b2e1e89bb49984e59666488fa)
- [MagPi ACP Agent implementation](https://github.com/digital-overground/magpi-acp/blob/58d287d37d31e52b2e1e89bb49984e59666488fa/src/acp/agent.ts)
- [MagPi ACP session implementation](https://github.com/digital-overground/magpi-acp/blob/58d287d37d31e52b2e1e89bb49984e59666488fa/src/acp/session.ts)
- [Pi-tree extension tests](https://github.com/digital-overground/magpi-acp/blob/58d287d37d31e52b2e1e89bb49984e59666488fa/test/unit/pi-tree-extension.test.ts)
- [Fork tests](https://github.com/digital-overground/magpi-acp/blob/58d287d37d31e52b2e1e89bb49984e59666488fa/test/unit/session-fork.test.ts)
- [MagPi README private integration contract](https://github.com/digital-overground/magpi-acp/blob/58d287d37d31e52b2e1e89bb49984e59666488fa/README.md)
- [MagPi #1](https://github.com/digital-overground/magpi-acp/issues/1), [#3](https://github.com/digital-overground/magpi-acp/issues/3), [#4](https://github.com/digital-overground/magpi-acp/issues/4), [#5](https://github.com/digital-overground/magpi-acp/issues/5), [#6](https://github.com/digital-overground/magpi-acp/issues/6), [#7](https://github.com/digital-overground/magpi-acp/issues/7), and [#8](https://github.com/digital-overground/magpi-acp/issues/8)

### ACP and Pi

- [ACP TypeScript SDK `1.4.0` changelog](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.4.0/CHANGELOG.md)
- [ACP SDK `0.26` → `0.27` migration guide](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.4.0/MIGRATION_0.26_0.27.md)
- [ACP v1 terminal authentication](https://agentclientprotocol.com/protocol/v1/authentication)
- [Pi RPC request/response types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts)
- [Pi RPC client native fork/tree methods](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-client.ts)
- Locally inspected package types: `@earendil-works/pi-coding-agent@0.85.1`, `dist/core/session-manager.d.ts` and `dist/modes/rpc/rpc-types.d.ts`.

### Mischief canonical/domain sources

- `CONTEXT.md`
- `docs/agents/domain.md`
- `docs/agents/issue-tracker.md`
- `docs/adr/0001-profile-database.md`
- [Mischief #25](https://github.com/digital-overground/mischief/issues/25), [#26](https://github.com/digital-overground/mischief/issues/26), [#27](https://github.com/digital-overground/mischief/issues/27), and [#28](https://github.com/digital-overground/mischief/issues/28)

## Remaining external inputs

No product or architecture question blocks implementation. Two release-management values must be filled in when MagPi is published:

1. the final MagPi release commit; and
2. the npm version that first contains the native picker contract.
