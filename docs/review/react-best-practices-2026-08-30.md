# React Best-Practices Review

**Date:** 2026-08-30  
**Guidance:** [Vercel React Best Practices](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md)

## Findings

### P1 — Composer can be pushed outside the Thread pane

**Locations:** `media/webview.css:29-46`, `media/webview.css:425-428`, `media/webview.css:699-703`, `media/webview.css:759-763`, `media/webview.css:823-844`

**Status:** Resolved. Steering and plan now shrink and scroll before displacing the composer.

Steering, plan, and footer are non-shrinking siblings. A headless Chromium reproduction at 320×500 placed the composer at `434–520px` while the Thread ended at `413px`. Removing plan and steering kept the composer visible. This confirms the reported layout regression.

### P1 — Streaming still performs O(history) work per ACP chunk

**Locations:** `src/threads/threads.ts:1070-1101`, `src/view.ts:475-498`, `src/webview/transcript.tsx:230-262`

**Status:** Resolved. Transcript changes now send and render only the changed item while stable history remains memoized.

Every chunk rebuilds the snapshot, renders Markdown for all text items, structured-clones the full state, and reconstructs the complete transcript. Memoization protects peripheral panes but not the primary streaming path.

### P2 — Autocomplete remains synchronous in the worst case

**Locations:** `src/webview/composer.tsx:29-52`, `src/webview/composer.tsx:232-237`

**Status:** Resolved. Candidate matching now runs against a deferred context rather than inside the input event.

Matching stops after 50 results, but selective or no-result queries still scan every candidate during input. Vercel recommends `useDeferredValue` for expensive input-driven rendering.

### P2 — Context inventory is requested twice on startup

**Locations:** `src/webview/app.tsx:31-32`, `src/webview/app.tsx:51-58`, `src/view.ts:441-464`

Both requests can run the 5,000-file scan. The initial unconditional request is redundant because the Workspace-change request covers initialization.

### P2 — Streaming reads layout during React render

**Locations:** `src/webview/thread-view.tsx:42-56`

Reading `scrollHeight`, `scrollTop`, and `clientHeight` during every streamed render can force synchronous layout. Bottom-stickiness should instead be tracked in a scroll-handler ref.

### P3 — Deep memo comparisons allocate on the streaming path

**Locations:** `src/webview/projects-pane.tsx:142-146`, `src/webview/composer.tsx:294-320`, `src/webview/footer-controls.tsx:165-169`

`JSON.stringify` comparators move work out of rendering rather than stabilizing snapshot references.

### P3 — Processing animation still commits React state every 60 ms

**Locations:** `src/webview/thread-view.tsx:11-29`

The animation is isolated, but it can reuse the existing CSS braille animation and avoid React commits.

## Previous-review status

The original review contained no P3 findings. In this review, the P3 findings are the deep memo comparisons and the processing animation.

Previously identified model ordering, usage-popup reset, composer stability, and Thread-list animation issues are addressed. Autocomplete is improved but remains synchronous in its worst case.

## Verification

`pnpm check` passes:

- Lint
- Type checking
- 43 tests
- Production build

The current jsdom tests do not calculate browser layout and therefore do not detect the composer containment regression.

## Ponytail review

**Scope:** React refactor from `ac15fac` through `1708fd3`; unnecessary complexity only.

- `src/webview/transcript.tsx:L75-257: native: React Set state and prop plumbing mirrors each tool's <details> open state. Leave keyed <details> uncontrolled; the DOM already preserves it.`
- `src/webview/plan-control.tsx:L1-21: native: useState and onToggle mirror the plan <details> open state. Use the native open attribute without React state.`
- `src/webview/thread-view.tsx:L11-29: native: interval-driven React state implements a text animation. Reuse the existing CSS braille keyframes with a pseudo-element.`
- `src/webview/threads-pane.tsx:L7-25,L71-89: delete: indicatorKind and repeated attention derivation defend values already guaranteed by ThreadSummary.indicator and needsAttention. Read those fields directly.`
- `src/webview/pane-layout.tsx:L23-178: native: a callback registry manually removes nine DOM listeners. Attach them with one AbortController signal and abort it in the effect cleanup.`
- `src/webview/projects-pane.tsx:L98-146: yagni: a JSON-stringifying memo wrapper protects a cheap pane without measured evidence. Export the component directly until profiling earns custom equality.`
- `src/webview/footer-controls.tsx:L181-205: shrink: UsageControl accepts the entire optional Thread and repeats its parent's usage guard. Pass the already-validated usage object.`
- `src/webview/app.test.tsx:L27-349, src/webview/footer-controls.test.tsx:L39-130: shrink: every test repeats root lookup, render, and unmount ceremony. Use one local render helper per test file.`

`net: -130 lines possible.`
