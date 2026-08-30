# React Best-Practices Re-review

**Date:** 2026-08-30

**Guidance:** [Vercel React Best Practices v1.0.0](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md) and its full compiled `AGENTS.md`

**Scope:** React refactor from `ac15fac` through `c41dff7`

## Findings

### P1 — Background Thread chunks can hide the selected Thread's streamed output

**Locations:** `src/webview/app.tsx:20-48`, `src/webview/thread-view.tsx:38-39`

`App` keeps one transcript overlay. Any chunk from a different concurrently running Thread replaces that overlay and changes its `threadId`; `ThreadView` then supplies an empty overlay for the selected Thread. Its streamed output disappears until another selected-Thread chunk or full snapshot arrives. Ignore non-selected transcript messages or store overlays by Thread ID.

### P2 — Active-plan lookup still scans full history on every selected-Thread chunk

**Location:** `src/webview/thread-view.tsx:52-54`

When the current streamed items contain no plan—the common case—every chunk runs `selected.items.find(...)` across the complete transcript. This leaves an O(history) operation on the primary streaming path. Memoize the base plan from `selected.items`; only inspect the small streamed overlay per chunk. This follows Vercel's `rerender-memo` and `js-cache-function-results` guidance.

### P2 — Peripheral panes still do list work for every selected-Thread chunk

**Locations:** `src/webview/projects-pane.tsx:96-140`, `src/webview/threads-pane.tsx:183-203`

Each transcript delta rerenders `App`. Projects reconstructs every Project/Workspace row, while the Threads custom memo comparator walks every Thread even though both snapshot references are unchanged. Shallow `memo(ProjectsPaneView)` and `memo(ThreadsPaneView)` give O(1) bailouts now that transcript updates use a separate message. This follows `rerender-memo`.

### P3 — Directory autocomplete allocates an array per candidate

**Location:** `src/webview/composer.tsx:44-51`

`remainder.split("/").filter(Boolean)` allocates twice for every candidate in selective or no-result directory queries. Deferred rendering keeps this out of the input event, but the scan still does unnecessary work. Check for another slash directly instead, following `js-combine-iterations` and `js-early-exit`.

## Prior-finding verification

| Prior finding | Result | Evidence |
| --- | --- | --- |
| Composer escaped the Thread pane | Resolved in code | Steering and plan now shrink/scroll; the CSS regression assertion passes. No layout-capable browser test is installed, so the original 320×500 Chromium reproduction was not rerun. |
| Every ACP chunk rebuilt and cloned full history | Resolved | Transcript updates use a changed-item protocol and stable history memoization. The remaining plan scan is reported above. |
| Autocomplete blocked input in the worst case | Resolved | The 5,000-candidate test records zero candidate reads inside the input event; matching uses `useDeferredValue`. |
| Context inventory scanned twice on startup | Resolved | Mount sends only `ready`; Workspace initialization sends one inventory request. Opening `@` requests an on-demand refresh. |
| Streaming read layout during render | Resolved | Bottom-stickiness is updated by `onScroll`; the streaming test observes zero layout reads during render. |
| Deep memo comparisons allocated on the streaming path | Resolved | No `JSON.stringify` comparator remains under `src/webview`. |
| Processing animation committed React state every 60 ms | Resolved | The inline and Thread-list braille indicators share CSS keyframes; no React animation timer remains. |

## Category summary

- **Eliminating waterfalls / server rules:** not applicable to this client-only VS Code webview.
- **Bundle size:** no actionable finding; React is the UI runtime and icons are local static JSX.
- **Client-side data fetching:** no network-fetch pattern is present.
- **Re-rendering:** two findings above.
- **Rendering:** prior content-visibility, layout-read, and CSS-animation findings are addressed.
- **JavaScript hot paths:** plan lookup and directory matching remain.

## Verification

`pnpm check` passes:

- Lint
- Type checking
- 43 tests
- Production build

## Ponytail review

**Scope:** `ac15fac...c41dff7`; unnecessary complexity only.

- `src/webview/plan-control.tsx:L1-21: native: React state mirrors one <details> open flag. Leave the keyed <details open> uncontrolled.`
- `src/webview/threads-pane.tsx:L7-25,L71-89: delete: indicatorKind and fallback attention derivation defend fields already guaranteed by ThreadSummary. Read indicator and needsAttention directly.`
- `src/webview/threads-pane.tsx:L183-203: shrink: a 21-line comparator walks every Thread to protect against obsolete full streaming snapshots. Use default shallow memo now that chunks are separate messages.`
- `src/webview/pane-layout.tsx:L23,L111-166: native: a callback registry manually removes nine DOM listeners. Attach them with one AbortController signal and abort once.`
- `src/webview/footer-controls.tsx:L165: yagni: ConfigControl memo cannot help when full snapshots clone configs, and Composer already blocks transcript-delta rerenders. Export the component directly.`
- `src/webview/footer-controls.tsx:L177-200,L277-279: shrink: UsageControl accepts an optional whole Thread and repeats its parent's usage guard. Pass the validated usage object.`
- `src/webview/thread-control.tsx:L3-32: yagni: a polymorphic header abstracts exactly one <summary> and one <div> while callers still supply every ID, class, icon, title, and action. Inline both headers and delete the file.`
- `src/webview/projects-pane.tsx:L96-140: shrink: ProjectsPaneView plus a pass-through export is residue from the removed custom memo. Export ProjectsPane directly.`
- `src/webview/app.test.tsx:L28-399,src/webview/footer-controls.test.tsx:L39-130: shrink: root lookup, render, and unmount ceremony is repeated in every test. Use one local render helper per file.`

`net: -160 lines possible.`
