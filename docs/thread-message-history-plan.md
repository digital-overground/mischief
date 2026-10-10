# Restore Thread message history popup

**Status:** Implemented. Message history supports jump, ACP-identity reconciliation, and row-level Fork/Tree actions. The footer's former Fork/Tree buttons and native-target QuickPick flows were removed; Mischief sends ACP message IDs directly to MagPi. This document preserves the original implementation plan, so references below to native footer pickers are obsolete.

## Delivery order and gates

1. **Browse and jump:** Ship a read-only Message history popup. It works against today's Agent and for restored Threads; it does not need native IDs. No row actions yet. Gate: automated popup, streaming, and scroll tests plus manual narrow-sidebar and live-stream jump checks.
2. **Message identity:** Ship ACP ID reconciliation and keep native picker targets separate from transcript IDs, without changing visible Fork/Tree behavior. Requires the new MagPi build for live integration; unit tests use fake Agent updates. Gate: no duplicate prompt rows or content, correct IDs for consecutive/queued turns and replay, and existing QuickPicks unchanged.
3. **Direct Fork/Tree:** Ship row actions sending Agent-provided ACP IDs to MagPi; MagPi resolves/validates the native target. Depends on 1 and 2 and the new MagPi build for end-to-end acceptance. Gate: wrong or missing IDs never act, native IDs remain exclusive to footer pickers, existing QuickPicks and Workspace Thread History remain intact, `pnpm check` and manual live cases pass.

Each deliverable should be mergeable on its own. Do not expose disabled or misleading Fork/Tree row controls in deliverable 1. Run its focused tests before starting the next deliverable; `pnpm check` is the final gate for each merged deliverable.

## Goal and boundaries

Restore the old **Message history** popup for the selected Mischief **Thread**. Show its visible user prompts and Agent responses in transcript order. Clicking a message closes the popup and scrolls `#chat` to that exact rendered message. In deliverable 3, hovering or keyboard-focusing a row reveals actions that **fork or navigate the Thread tree at that row's message**, without asking the user to select the message again.

This is **not** the Workspace **Thread History** action in `src/webview/navigator-pane.tsx`, which lists _other, unregistered Threads_ and reopens them through `Threads.history()` / `showThreadHistory()`. Do not change or rename that workflow. Do not call the new popup “session history” in the UI; Thread is the user-facing term.

**Scope:** Per-message Fork/Tree must work for a newly created, currently live Thread (including earlier turns in that same Thread). Older/restored Threads still show their transcript and support jump-to-message. Do **not** migrate their IDs or add a persistent version flag: attempt the message-targeted action only for Agent-provided IDs; MagPi rejects unavailable/stale mappings without guessing. An older Thread whose IDs already match may work; age alone is not a reason to reject it.

### Decisions for this implementation

- Keep Message history in the footer; New Thread is on the current Workspace row. `git show 4dcb5c5:src/webview/threads/detail/composer/controls/history-control.tsx` and `git show df7ecf5^:media/webview.css` are **visual/interaction references only**. The old `forkThread`/`rollbackThread` handlers used a transcript ID directly; they are not compatible with the current native target APIs. Do not restore rollback.
- Message history is the only Fork/Tree UI. Each visible transcript row targets its own message; there is no separate native-target picker.
- A row is shown for every rendered user/assistant message (including image-only messages with an appropriate label); not for thoughts, tools, plans, system entries, or branch summaries. The popup lists the visible branch only, not the complete Pi tree.
- Pi's native fork API accepts **user** entries, not assistant entries. Show Fork only on actionable user rows; Tree on actionable user **and** assistant rows. Never silently fork from a nearby prompt when the user clicks an Agent response.
- Clicking the row jumps; clicking its action button **only** performs the action. Tree still presents the existing branch-summary choice (and custom focus input) when applicable, but skips the _target-selection_ QuickPick. Fork skips that QuickPick entirely and still creates/selects a child Thread with the chosen prompt in its draft.
- No new dependency, persistence table, transcript cache, search, full-tree renderer, or separate native target UI in the webview.

## Current code contract (read before changing)

| Concern | Existing behavior / exact seam |
| --- | --- |
| Transcript | `src/threads/threads/threads.ts` owns `ThreadDetail.items`; `src/threads/threads/transcript.ts` builds items from `AgentUpdate.messageId` as `${kind}:${messageId}`, otherwise generates local IDs. Local optimistic user items created in `Threads.prompt()` have a random UUID. |
| Streaming | `src/webview/app.tsx` receives full `state` and incremental `transcript` messages; a `state` clears the incremental buffer. `src/webview/threads/detail/transcript.tsx` hides `plan` entries, suppresses an outdated snapshot tail when streaming updates replace it, and renders committed + streamed items. Do **not** build the popup from `selected.items` alone. |
| Scroll | `#chat` in `src/webview/threads/detail/thread-view.tsx` owns scrolling; its `useLayoutEffect` auto-sticks to bottom when `shouldStick.current` is true. `TranscriptEntry` renders user/assistant `<article class="entry ...">` without a DOM ID today. |
| Footer | `FooterControls` includes Message history, usage, config, and Send; New Thread is on the current Workspace row. |
| Host actions | `src/view.ts` accepts only targeted `forkThread` / `navigateThreadTree` messages. It passes the transcript item's ACP ID to `Threads`; tree actions retain branch-summary choices. |
| ACP boundary | Mischief validates that the selected idle Thread owns the user/assistant transcript item and rechecks its negotiated operation capability. The generic ACP adapter owns standard transport and capability negotiation; MagPi's extension sends the ACP ID through its private request and resolves the Pi target. Other Agents without the advertised extension keep these row actions disabled. Mischief does not fetch native target lists or carry Pi entry IDs. Fork creates a child Thread; Tree reloads the same Thread. |
| Rendering | `src/view.ts` renders Markdown into `item.html` for transcript bodies. History previews should use `item.text` as plain React text, never `html` or `dangerouslySetInnerHTML`. |

**Identity contract after the MagPi handoff:** MagPi emits standard, opaque ACP `messageId` values on live user and assistant chunks, including distinct IDs for identical text; on `session/load`, it replays persisted messages with IDs. Thinking replay has no navigable ID. Native picker `entryId` / `entry.id` values identify Pi structural targets and are **not interchangeable** with ACP IDs. A transcript action sends the ACP ID to MagPi; it never fetches picker targets or matches by entry ID, text, or list position. Mischief's optimistic user UUID is only a temporary UI key; Thread records do **not** persist transcript IDs, so do not reject a Thread solely by age. The [older 0.2.0 research](research/acp-message-identity-2026-09-24.md) is a pre-handoff snapshot, not the new wire contract.

## Deliverable 2 — Message identity (after Browse and jump)

### 2.1 Select the Agent build and confirm the wire contract

1. Confirm which Agent binary `src/extension.ts` launches: configured `mischief.magpiAcpPath`, sibling `../magpi-acp/dist/index.js`, or PATH. The new implementation currently lives in the **`../worktrees/magpi-acp-message-ids`** worktree, not the sibling main checkout. Build/select that binary for integration or wait for it to merge; do not claim a passing MagPi integration test when running old 0.2.0. Handoff shapes: native picker responses remain `{ messages: [{ entryId, text }] }` and `{ tree: [{ entry: { id, ... }, children }], leafId }`; transcript Fork uses `session/fork` with `_meta["magpi-acp/fork-message-id"]`, and transcript Tree uses `_magpi-acp/session/navigate-tree` with `messageId` (instead of `entryId`). MagPi alone resolves ACP IDs to Pi targets.

### 2.2 Keep native picker identity separate

2. Leave `AgentForkTarget` and `AgentTreeTarget` native-only in `src/threads/acp/models.ts`; `decodeForkTargets()` / `decodeTreeTargets()` decode their Pi IDs and existing QuickPick metadata. In `src/threads/acp/acp.ts`, provide separate message-targeted fork (`_meta["magpi-acp/fork-message-id"]`) and tree (`messageId`) methods for deliverable 3; never infer an ACP ID from a native target or vice versa.

### 2.3 Reconcile optimistic and replayed transcript messages

3. In `Threads.handleUpdate()` (before `reduceTranscript` handles a `user` update), reconcile the active **optimistic** user item for this runtime when its active `runtime.pending[0]` receives MagPi's first live `user_message_chunk` carrying `messageId`: replace the item's temporary ID with `` `user:${messageId}` ``; update the matching pending ID used by queue/completion bookkeeping; preserve the optimistic text/images/queued state. Ignore subsequent text/image chunks for **that same echoed user ID** while the pending prompt is active—Mischief already rendered the user's submitted content, so appending echoes would duplicate text or images. Do not equate messages by text, replace a queued-but-not-yet-active prompt, or reconcile a replayed user update when no prompt is pending.
4. On that first ID swap emit a **full Thread state** (not just a streaming `transcript` item): `App` otherwise still holds the snapshot tail under the old UUID and could display the old and new user row at once. Preserve the composer text and drafts. `runPrompt()` holds the original item reference; confirm ID changes do not break `runtime.pending` removal, queued positions, cancellation, retry, or later `updateQueue()` lookups. For loaded Threads with no active pending prompt, use the existing `reduceTranscript` path: replay already has ACP IDs. Existing assistant chunks naturally coalesce through their shared ID; distinct assistant messages with identical text must remain separate.
5. Keep rows jumpable regardless of native identity. For deliverable 3, disable Fork/Tree while a message is queued or the Thread is not idle; once idle, let an enabled action reach the host even if its ACP ID might be unavailable, so the user receives the identity/version-mismatch error. Do not add migration, a separate ID scheme, polling, or startup history refresh.

### 2.4 Verify and ship identity without new UI

6. Tests in `src/threads/threads/threads.test.ts`, `src/threads/threads/transcript.test.ts`, and `src/threads/acp/acp.test.ts`: first user ACP chunk swaps the UUID with **no duplicate** text/images; repeated user text and image chunks do not double content; two queued prompts take their own IDs in send order; cancellation and pending cleanup still work; assistant chunks with the same ID coalesce while identical-text responses with distinct IDs remain separate; replayed user/thought messages behave normally; native target decoders keep Pi IDs separate from ACP identity. No old-surrogate migration test is needed.

> The webview sends its existing **transcript item ID**, never a Pi entry ID or arbitrary target object. The host verifies Thread membership/role and passes the ACP ID to MagPi; MagPi alone performs native target lookup. There are no footer Fork/Tree QuickPicks.

## Deliverable 1 — Browse and jump (first release)

### 1.1 Build the visible message list and popup

1. Add `src/webview/threads/detail/composer/controls/history-control.tsx`, using the old component as a style reference, **not a verbatim copy**. Render a button labeled **Message history** with `aria-expanded`, `aria-controls`, `aria-haspopup`, and a focusable nonmodal popup (`role="dialog"`, `aria-label="Message history"`). Disable it when there is no saved selected Thread or no visible messages; do not show fake setup/draft history. Key it by selected Thread ID so switching Threads closes it. This first version offers only message-jump controls.
2. Thread `historyItems` and `onJumpMessage(itemId)` from `ThreadView` through `Composer` to `FooterControls` and `HistoryControl`. Compute `historyItems` in `ThreadView` from `selected.items` plus `transcriptItems` **for this selected Thread only**, filtering user/assistant and merging by `id` (new streamed versions replace old snapshot versions without moving them; new IDs append). Follow `Transcript`'s committed/streamed tail semantics. Do not hold a second persisted list or derive entries solely from `selected.items`; a streaming Agent response should appear and update without duplicating rows. For an image-only entry use `"Image prompt"` (or the existing user placeholder), not a blank row or base64 text.

### 1.2 Jump to the rendered message without losing scroll position

3. In `TranscriptEntry` (`src/webview/threads/detail/transcript.tsx`) put `data-message-id={item.id}` on the **user/assistant `<article>` only**. Use the existing React `key` unchanged. Do not put synthetic IDs on grouped tools/thoughts or render an extra transcript copy.
4. Implement `onJumpMessage` in `ThreadView`: locate the exact element _within_ `chat.current` by comparing the `data-message-id` value (avoid constructing an unescaped CSS selector from an Agent-controlled ID); set `shouldStick.current = false` **before** scrolling; scroll that element into view within `#chat` (prefer `scrollIntoView({ block: "start" })`, or a container-relative scroll if the webview scrolls the wrong ancestor). Close the popup; optionally focus the target with `tabIndex={-1}` so keyboard users know where they landed. If the target vanished during a state change, close without scrolling another entry. Test that the next streamed update does **not** bounce the view back to the bottom; normal stick-to-bottom must still work when the user scrolls back there or switches Threads.

### 1.3 Style and complete keyboard/pointer interactions

5. Layout in `media/webview.css`: put the popup above the footer, max height about 500px, scroll its list, show one-line ellipsized previews, distinguish user/Agent styling, and position at click X while clamping inside a narrow webview. Scope the CSS under `#history-control`/`#history-list`; reuse VS Code color variables and the `history` SvgIcon. Do not break the existing footer layout or context-usage positioning. In deliverable 3, add right-aligned Fork/Tree buttons, visually revealed on `.history-entry:hover` / `.history-entry:focus-within`, with visible keyboard focus; the jump control must be their sibling, never a nested `<button>`.
6. Interaction details for this deliverable: open with focus in the popup and scroll its list to the latest message (chronological order, newest at bottom); toggle via History button; close on Escape (return focus to History button), outside click, Thread change, or jump. Add action-button closing behavior only in deliverable 3. Clicking inside the popup must not be treated as an outside click. When deliverable 3 adds action buttons, their clicks must not invoke the row's jump handler or accidentally trigger the highlight-to-copy behavior in `#transcript`. Disable those actions when the Thread is running, waiting, errored, unsaved, or executing a session operation, based on `forkSupported` / `treeNavigationSupported`. Do not silently hide/disable an idle row just because its ID might be incompatible; allow the host to show the mismatch error when clicked. Do not hide keyboard focus styles just to achieve hover visuals.

### 1.4 Verify and ship browse-only history

7. Tests in `src/webview/app.test.tsx` (preferred for real `#chat` and streaming) and/or a focused `history-control.test.tsx`: mixed user/assistant/tool messages, snapshot + streamed replacement, newest preview, empty/setup state, toggling/outside/Escape, narrow positioning, click-jump to the exact DOM row, sticky-scroll regression, Thread switch. Verify separate Workspace Thread History still posts `threadHistory`.

## Deliverable 3 — Direct Fork/Tree (after Browse and jump + Message identity)

### 3.1 Add targeted protocol messages and row controls

1. Extend `WebviewToHostMessage` in `src/webview/protocol.ts` with **targeted** variants of `forkThread` and `navigateThreadTree` carrying `{ threadId, messageId }`. Keep the existing _no-payload_ variants for footer QuickPicks. Use a discriminated union rather than making `messageId` optional on unrelated messages.
2. The popup posts `{ type: "forkThread" | "navigateThreadTree", threadId: selected.id, messageId: item.id }` for an enabled action; then closes. No native `entryId` or target text should be supplied by the webview. The row's jump is a local callback and does **not** post a host message.

### 3.2 Validate row identity in the host; let MagPi resolve native targets

3. In `src/view.ts` `handleThreadMessage()`, validate the new fields are nonempty strings with reasonable bounds before dispatch. When no targeted fields are provided, retain existing `showForkThread()` / `showNavigateThreadTree()` behavior. Malformed partial payloads must not fall back to an unqualified QuickPick or execute an action.
4. For targeted Fork, verify the selected Thread and an actual user item in its runtime with `item.id === `user:${messageId}`` where `messageId` was supplied by the Agent (not an optimistic UUID). Call a targeted `Threads.forkMessage(threadId, messageId)` that reuses child creation/selection/draft behavior but calls the ACP adapter's `forkMessage(sessionId, cwd, messageId)` with `_meta["magpi-acp/fork-message-id"]`. Do **not** fetch `forkTargets()` or send `entryId`; MagPi resolves role, active branch and Pi identity, rejecting unmapped/stale IDs. Keep the footer picker on native targets.
5. For targeted Tree, verify the selected Thread and an actual user/assistant item with an Agent-provided ACP ID, then call `Threads.navigateTreeMessage(threadId, messageId, options)` via the ACP adapter's `_magpi-acp/session/navigate-tree` request carrying `messageId` (not `entryId`). Extract branch-summary choice/custom-focus from `showNavigateThreadTree()` for both flows; preserve cancellation, draft restoration, `await this.render()` and operation overlay semantics. A targeted action does **not** open a native target picker. If skip-summary-on-current is still needed, use only an explicit Agent guarantee; never guess current from IDs or list order. The footer picker continues to browse inactive branches with native IDs.
6. Keep authoritative status/capability/selection checks in `Threads.requireSessionOperationContext()` and both native and message-targeted methods; check runtime transcript membership and Agent-provided identity instead of trusting a webview-supplied ID. Recheck after asynchronous summary selection; a Thread switch or tree change must not act on a different Thread. MagPi rejects stale/wrong-role/unmapped/inactive-branch IDs through the existing `MischiefView.handleMessage()` error path; cancelled QuickPicks do nothing.

### 3.3 Verify safe actions and keep existing flows

7. Tests: extend `src/view.test.ts` to show a targeted user Fork bypasses target QuickPick and sends the **ACP `messageId`**, not `entryId`, with different values and duplicate message text; assistant Fork is rejected; targeted assistant/user Tree bypasses target QuickPick yet still asks for applicable branch summary; cancellation does not navigate. Missing/forged/non-Agent IDs, stale Thread selection, and busy/unsupported status must not execute; MagPi rejection of an inactive/unmapped/wrong-role target must surface without acting on a nearby row. Restored Threads with Agent IDs may work without migration; those without IDs stay jumpable. Keep existing footer QuickPick tests green. Extend `src/threads/threads/threads.test.ts` for domain validation; reuse the fake Agent rather than mocking protocol internals.

## Per-deliverable integration and final acceptance

1. Run focused tests as each deliverable lands: `pnpm test -- src/threads/threads/transcript.test.ts src/threads/threads/threads.test.ts src/view.test.ts src/webview/app.test.tsx src/webview/threads/detail/composer/controls/footer-controls.test.tsx` (adjust file list to actual new tests). Then `pnpm format`, `pnpm format:check`, and `pnpm check`. Fix regressions; do not leave the footer QuickPick or Workspace Thread History tests failing.
2. Deliverable 1 can be checked against the current MagPi binary. For deliverables 2 and 3, use a VS Code Extension Development Host configured to run the **new MagPi worktree build** (or a release containing that handoff):
   - Start a new Thread and complete multiple turns. Verify both user and Agent messages appear in order, including identical-text messages and an image-only user prompt; tools/thoughts are omitted. Also open one older/restored Thread: the list and jump should work. When MagPi rejects an unmapped message ID, Fork/Tree should show its error and leave the Thread unchanged; Agent-provided replayed IDs can work without migration.
   - Open the popup in a narrow sidebar; confirm it stays on-screen, focuses correctly, scrolls to newest, and Escape/outside click close it. Click an earlier row in that same Thread while live streaming continues: jump to that exact card and remain there.
   - Hover/focus a user row and fork: new Thread selected, original preserved, that prompt in an editable draft. Hover/focus an Agent row: Tree works; Fork is not offered. Navigate to a user row with and without branch summary, verify the existing summary choices, cancellation, restored draft, and reloaded transcript.
   - While running/waiting or with unsupported Agent capabilities, verify no unsafe row actions fire. Change Thread with the popup open or while target data is loading; verify it cannot act on the other Thread. Existing standalone Fork/Tree QuickPicks and Workspace Thread History must still work.
3. Update `CONTEXT.md` only if the final behavior changes an established domain rule; no ADR or new persistence is needed. MagPi supplies standard ACP IDs in its message-ID worktree; this plan adds no new Mischief ID scheme. Keep the [historical research note](research/acp-message-identity-2026-09-24.md) explicitly understood as a pre-handoff 0.2.0 snapshot.

## Final done when

- In a newly created Thread, the old footer-style popup shows the **actual visible transcript messages**, stays current during streaming, and scrolls to the exact clicked message without auto-scroll snapping back.
- Row controls act on the **same** message: the host validates transcript membership/role and sends only its ACP ID; MagPi resolves/validates native identity. No accidental forks/navigation from duplicate text, optimistic UUIDs, stale Threads, or hidden branches.
- Fork (user) and Tree (user/Agent) preserve today's native semantics, branch-summary flow, and footer QuickPicks; Workspace Thread History remains unchanged.
- Automated checks and manual **live-Thread** cases pass against the new MagPi build; older/restored Threads remain browseable and report a visible identity unavailable/version mismatch on incompatible per-message actions, without ID migration. Missing or unmapped ACP IDs never trigger a guess or fallback to Pi `entryId`.
