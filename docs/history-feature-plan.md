# Thread message history

**Status:** Planned

## Scope

Add a footer History button that opens the user messages in the selected Thread. Fork and rollback are deferred to Phase 2.

## Phase 1: History popup

- Add a **History** button beside the existing footer controls.
- Derive entries from `selected.items` where `kind === "user"`.
- Preserve transcript order, with the newest message at the bottom.
- Render each message on one line with no wrapping and CSS ellipsis truncation.
- Limit the list height to `500px` and scroll it to the bottom when opened.
- Position the popup at the mouse `clientX` when the button is clicked.
- Size it to end `10px` from the Webview's right edge, with a minimum width of `500px`.
- Close it on Escape and outside clicks.
- Include keyboard and accessibility behavior.
- Add focused Webview tests.

### Width edge case

If the button is clicked within 500px of the right edge, these requirements conflict:

- start exactly at the pointer;
- end 10px from the right edge; and
- have a minimum width of 500px.

Default behavior: preserve the 500px minimum and allow the popup to extend left of the pointer only when necessary.

## Phase 2: Fork and rollback

The current `Threads`/ACP seam does not expose these operations.

### Fork

Extend MagPi ACP to:

1. map the selected Mischief user-message ID to the Pi session entry;
2. create a new Pi session from that entry using Pi's native fork/session machinery;
3. return the new session ID; and
4. register and select the resulting Mischief Thread.

Do not implement this by manually replaying prompts.

### Rollback

MagPi ACP already has a private rewind capability:

```text
_magpi-acp/session/rewind
```

It maps client message IDs to Pi user messages and navigates the native Pi tree. Mischief needs a typed Agent operation for rollback, followed by reloading the current transcript from ACP.

Rollback should:

- cancel any active turn first;
- require explicit confirmation;
- invoke native Pi tree navigation;
- reload the active branch;
- remove abandoned messages from the visible transcript; and
- preserve Pi's underlying tree history.

## Implementation order

1. Implement the Phase 1 history popup.
2. Add message-ID-safe history data and tests.
3. Add the ACP fork API in MagPi.
4. Add the rollback API using MagPi rewind.
5. Add the fork/rollback action menu and confirmation UI.

## Deliberate non-goals

Do not import Pi session files or replay prompts manually unless MagPi cannot provide native session operations.
