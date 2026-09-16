# HumanLayer Theme Settings Plan

## Status

Planned.

## Goal

Let the user select any HumanLayer theme from the existing Mischief Settings dialog. Apply the selected palette immediately across the entire Mischief webview and persist the choice globally across reloads and VS Code windows.

Tokyo Night Storm remains the default, preserving the current appearance for users who never change the setting.

## Source of truth

Port the theme definitions from the checked-out HumanLayer repository:

- Repository: `/Users/kyle.humphrey/Projects/_external/humanlayer-pro-0.20.0`
- Palettes: `humanlayer-wui/src/App.css`
- Theme IDs: `humanlayer-wui/src/contexts/ThemeContext.tsx`
- Labels: `humanlayer-wui/src/components/ThemeSelector.tsx`
- License: Apache-2.0

Add a source/version comment beside the imported palette data. Do not read from the external checkout at build time or runtime; the extension package must remain self-contained.

HumanLayer's `Theme` type and CSS define 19 themes. Its current `ThemeSelector` lists only 18 because it omits `launch`. Mischief should include all 19:

1. Solarized Dark
2. Solarized Light
3. Cappuccino
4. Catppuccin
5. High Contrast
6. Framer Dark
7. Framer Light
8. Gruvbox Dark
9. Gruvbox Light
10. Monokai
11. Launch
12. Rosé Pine
13. Rosé Pine Dawn
14. Rosé Pine Moon
15. Tokyo Night
16. Tokyo Night Storm
17. Bubblegum
18. L33t
19. Vesper

## Scope

### Included

- A Theme selector in the existing Settings dialog.
- All 19 HumanLayer themes.
- Immediate preview when the selection changes.
- Global persistence through VS Code configuration.
- Synchronization between open Mischief webviews.
- Theme application to Navigator, Thread transcript, composer, dialogs, menus, buttons, selections, statuses, and tool-group accents.
- Validation and fallback for invalid persisted values.

### Not included

- Importing HumanLayer's React context, Tailwind setup, custom dropdown, icons, or keyboard shortcuts.
- A separate automatic light/dark mode.
- Following the active VS Code color theme.
- Changing VS Code window/title-bar colors. `mischief.assignWorkspaceColors` remains based on the active VS Code color theme.
- Importing unused ANSI terminal colors unless Mischief later renders ANSI-colored terminal output.

## Design

### One shared theme module

Create `src/themes.ts` as the single theme seam used by the extension host and webview.

Its interface should remain small:

```ts
export type ThemeId = (typeof themes)[number]["id"];

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  colors: ThemeColors;
}

export const DEFAULT_THEME: ThemeId;
export const themes: readonly ThemeDefinition[];
export const resolveTheme: (value: unknown) => ThemeDefinition;
export const applyTheme: (
  theme: ThemeDefinition,
  target: Pick<CSSStyleDeclaration, "setProperty">
) => void;
```

`resolveTheme()` hides validation and always returns a usable definition. Callers should not duplicate theme-ID checks or fallback behavior.

`applyTheme()` maps a palette to the existing `--hl-*` CSS properties. Accepting a `setProperty` target keeps the behavior testable without a browser.

### Palette shape

Port the HumanLayer UI tokens Mischief actually consumes:

```ts
interface ThemeColors {
  background: string;
  backgroundAlt: string;
  foreground: string;
  foregroundDim: string;
  accent: string;
  accentDim: string;
  accentAlt: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  selection: string;
  cyan: string;
}
```

Map these from HumanLayer as follows:

| Mischief token  | HumanLayer source       |
| --------------- | ----------------------- |
| `background`    | `--terminal-bg`         |
| `backgroundAlt` | `--terminal-bg-alt`     |
| `foreground`    | `--terminal-fg`         |
| `foregroundDim` | `--terminal-fg-dim`     |
| `accent`        | `--terminal-accent`     |
| `accentDim`     | `--terminal-accent-dim` |
| `accentAlt`     | `--terminal-accent-alt` |
| `border`        | `--terminal-border`     |
| `success`       | `--terminal-success`    |
| `warning`       | `--terminal-warning`    |
| `error`         | `--terminal-error`      |
| `selection`     | `--terminal-selection`  |
| `cyan`          | `--terminal-color-6`    |

Keep shadow opacity fixed. Derive hover color with CSS `color-mix()` from the active background and accent rather than copying another ANSI color.

### CSS application

`media/webview.css` should keep using semantic `--hl-*` variables. The current Tokyo Night Storm values remain in `:root` as a safe pre-hydration fallback.

When the host state arrives, the webview applies the selected palette to `document.documentElement.style`. Existing aliases from `--vscode-*` variables to `--hl-*` values can remain temporarily, but no visible Mischief color may resolve from the active VS Code theme.

Preserve the transcript semantics across every palette:

| Transcript element     | Palette role |
| ---------------------- | ------------ |
| Terminal group         | `success`    |
| File operations group  | `accent`     |
| Web group              | `cyan`       |
| Tools group            | `accentAlt`  |
| Thinking               | `accentAlt`  |
| Questions and warnings | `warning`    |
| Errors and failures    | `error`      |
| Completed states       | `success`    |
| Pending/running states | `accent`     |

## Persistence and synchronization

Use VS Code configuration as the only durable source of truth. Do not add `localStorage`, which would create a second state source and diverge between webviews.

Add this setting to `package.json`:

```json
"mischief.theme": {
  "type": "string",
  "default": "tokyo-night-storm",
  "enum": ["...all 19 IDs..."],
  "enumDescriptions": ["...matching labels..."],
  "description": "Color theme used by the Mischief webview."
}
```

Persist Settings-dialog changes with `vscode.ConfigurationTarget.Global`. Global scope matches the expectation that the extension has one visual theme across Projects and Workspaces.

Unknown values must resolve to `tokyo-night-storm` without crashing. Do not rewrite an invalid value automatically; falling back is sufficient.

## Protocol changes

Update `src/webview/protocol.ts`:

- Add `theme: ThemeId` to the `state` host message.
- Add `{ type: "setTheme"; value: ThemeId }` to webview-to-host messages.

The normal state message should carry the selected theme because it already synchronizes extension configuration into the webview. The `showSettings` message does not need a second copy.

## Extension-host changes

### `src/view.ts`

Add a small configuration reader:

```ts
const configuredTheme = (): ThemeDefinition =>
  resolveTheme(vscode.workspace.getConfiguration("mischief").get("theme"));
```

Then:

1. Include `configuredTheme().id` in every full `state` message.
2. Handle `setTheme` in `handleWorkspaceMessage()`.
3. Validate through `resolveTheme()` before persisting.
4. Update `mischief.theme` at `ConfigurationTarget.Global`.

Do not let arbitrary strings reach CSS properties or configuration writes.

### `src/extension.ts`

Extend the existing configuration-change listener:

```ts
if (
  event.affectsConfiguration("mischief.fontFamily") ||
  event.affectsConfiguration("mischief.theme")
) {
  view.configurationChanged();
}
```

This makes changes from VS Code Settings and other extension-host instances flow into the webview.

## Webview changes

### State handling

Update `src/webview/app.tsx`:

1. Add `theme: DEFAULT_THEME` to `initialState`.
2. When a `state` message arrives, store the resolved theme ID with the snapshot.
3. Add an effect that calls `applyTheme(resolveTheme(snapshot.theme), document.documentElement.style)`.
4. On Settings selection, update local state immediately before posting `setTheme`. This avoids waiting for the configuration round trip and gives an instant preview.
5. Accept the subsequent host state as authoritative so configuration changes from another window win.

A brief default-theme render during first webview hydration is acceptable for the first implementation. Avoid adding inline boot scripts, duplicated local storage, or CSP exceptions unless a visible flash is demonstrated.

### Settings dialog

Add a native `<select>` to the existing `#settings-dialog`:

```text
Theme
[ Tokyo Night Storm ▾ ]
Choose the color theme used by Mischief.
```

Use `themes.map()` for options. A native select provides keyboard navigation, screen-reader semantics, and platform behavior without porting HumanLayer's custom dropdown.

Add a small CSS modifier such as `.settings-option.theme-option` so the label/description and select fit the existing settings layout.

Update the Workspace-color description to remove ambiguity:

> Automatically assigns colors from the active VS Code color theme to Workspace windows that do not already define them.

## Implementation sequence

### Phase 1: Theme data

1. Add a failing `src/themes.test.ts`.
2. Add `src/themes.ts` with all 19 definitions.
3. Copy only the required HumanLayer values and source attribution.
4. Verify IDs are unique and each palette is complete.
5. Verify unknown input resolves to Tokyo Night Storm.

### Phase 2: Persistent host setting

1. Add `mischief.theme` to `package.json`.
2. Extend protocol types.
3. Include the theme in full state snapshots.
4. Handle and persist validated `setTheme` messages.
5. React to external configuration changes.

### Phase 3: Webview application

1. Apply the selected palette through `--hl-*` properties.
2. Preserve Tokyo Night Storm as the CSS fallback.
3. Replace the fixed `--hl-hover` value with a derived color.
4. Verify all visual states continue to use semantic theme roles.

### Phase 4: Settings UI

1. Add the native Theme select.
2. Populate all 19 options from the shared module.
3. Apply changes immediately and post `setTheme`.
4. Adjust Settings layout CSS.
5. Clarify the Workspace-color description.

### Phase 5: Verification

Run focused tests after each phase, then run:

```text
pnpm check
```

## Test plan

### Theme module tests

Add `src/themes.test.ts` covering:

- Exactly 19 themes exist.
- IDs and labels are unique.
- Every required palette property is a non-empty CSS color value.
- `tokyo-night-storm` is the default.
- Every known ID resolves to itself.
- Unknown, missing, and non-string input resolve to Tokyo Night Storm.
- `applyTheme()` writes every expected `--hl-*` property.

Do not snapshot the entire palette object. Assert representative source values for several themes plus completeness for all themes, so tests catch transcription mistakes without becoming an unreadable duplicate of the implementation.

### Webview tests

Extend `src/webview/app.test.tsx` to verify:

- The Settings dialog renders 19 options.
- The selected option matches host state.
- Changing the select updates root CSS variables immediately.
- Changing the select posts exactly one `setTheme` message.
- A later host state updates the selected option and palette.
- The Workspace-color checkbox still behaves unchanged.

Use at least one dark theme and one light theme in the test to prove backgrounds and foregrounds both change.

### Host tests

Extend `src/view.test.ts` to verify:

- State messages include the configured theme.
- `setTheme` writes a validated value globally.
- Invalid values are not persisted and resolve to the default.
- `showSettings()` remains focused on opening the dialog and Workspace-color state.

Extend extension/configuration tests to verify that changing `mischief.theme` triggers `configurationChanged()`.

### Manifest and styling tests

Verify:

- `package.json` exposes all 19 enum values and defaults to Tokyo Night Storm.
- `media/webview.css` retains semantic group mappings.
- No UI color accidentally falls back to a VS Code theme color.
- Light themes have readable text, controls, borders, hover states, and selected rows.

## Manual verification matrix

At minimum, inspect these themes in an Extension Development Host:

| Theme             | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| Tokyo Night Storm | Default and migration behavior                 |
| Solarized Light   | Light-background readability                   |
| Catppuccin        | Pastel dark palette                            |
| High Contrast     | Strong contrast and focus visibility           |
| Launch            | Theme omitted by HumanLayer's current selector |
| L33t              | Extreme accent colors                          |

For each theme, check:

- Navigator rows and selected Thread
- Transcript user/assistant entries
- Terminal, File operations, Web, and Tools groups
- Pending, completed, and failed statuses
- Markdown code blocks and links
- Composer and configuration controls
- Settings dialog and theme selector
- Hover, focus, and text selection states

## Migration

No explicit migration is needed:

- Existing installations have no `mischief.theme` value.
- The manifest default resolves to Tokyo Night Storm.
- Tokyo Night Storm matches the currently hard-coded palette.
- Existing `mischief.assignWorkspaceColors` and `mischief.fontFamily` values remain untouched.

## Risks and mitigations

### Palette transcription errors

Mitigation: copy values directly from HumanLayer `App.css`, keep the source/version comment, and test representative exact values.

### Light-theme contrast problems

Mitigation: test at least Solarized Light, Framer Light, Gruvbox Light, Rosé Pine Dawn, Launch, and Bubblegum manually. Keep semantic roles rather than reusing one fixed dark-theme color.

### Multiple state sources

Mitigation: persist only in VS Code configuration. Local React state is an immediate preview, not durable state; the next host snapshot is authoritative.

### Theme drift from HumanLayer

Mitigation: treat the imported palettes as a versioned snapshot. Future updates should be deliberate ports from a named HumanLayer release, not runtime coupling to another checkout.

### Settings naming ambiguity

Mitigation: call the new setting `Theme` and explicitly call the existing window-color source the `VS Code color theme`.

## Acceptance criteria

- The Settings dialog lists all 19 HumanLayer themes.
- The current theme is selected when Settings opens.
- Selecting a theme updates the entire Mischief webview immediately.
- The selection persists globally across reloads and VS Code windows.
- Configuration changes made outside the dialog update open Mischief views.
- Invalid configured values safely fall back to Tokyo Night Storm.
- Tokyo Night Storm remains the default.
- Transcript grouping remains visually distinct in every palette.
- Workspace window-color assignment remains independent.
- No new runtime dependency is added.
- `pnpm check` passes.
