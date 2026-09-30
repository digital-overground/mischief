# Recommended Pi Add-ons Settings Plan

## Status

Planned.

## Goal

Keep the first-Thread recommendation for optional Pi add-ons and add a **Recommended Pi add-ons** section to Mischief Settings. Users can install an add-on they initially skipped or uninstall one they no longer want.

The managed recommendations remain:

1. Todo
2. Ponytail
3. Matt Pocock Skills

Ask User is not listed because MagPi bundles it. Todo enables structured ACP plan/checklist updates; it does not provide question elicitation. Bundled Ask User provides structured ACP question elicitation.

## Decisions

- Keep all three current recommendations in first-Thread setup.
- Call the Settings section **Recommended Pi add-ons**, because only Todo is strictly an extension.
- Checked means the add-on will be globally installed in Pi after saving; unchecked means it will be globally uninstalled.
- Treat add-on checkbox changes as a local draft until the user explicitly selects **Save add-on changes**.
- Keep the existing Workspace-color checkbox immediate; only the add-on section is transactional.
- Execute Pi directly with argument arrays, never a webview-provided command or shell string.
- Disable the add-on controls while a save is running.
- Re-read Pi settings after every save; Pi settings remain the only durable source of truth.
- Changes apply to new Pi processes. Running Threads keep their current tools and skills.
- Manage only global packages. Project-local `.pi/settings.json` files remain outside this UI.

## User experience

The initial setup flow remains unchanged: all missing recommendations appear selected by default, and the user may deselect any before continuing. The one-time `mischief.addonsOffered` flag still prevents the setup prompt from returning.

Settings adds:

```text
Recommended Pi add-ons

[x] Todo
    Shows agent plans as live, persistent checklists in Mischief.

[ ] Ponytail
    Keeps implementations minimal and avoids over-engineering.

[x] Matt Pocock Skills
    Engineering workflows for debugging, TDD, reviews, and design.

Changes apply to new Threads. Running Threads keep their current add-ons.

                         [Save add-on changes]
```

Changing a checkbox updates only the local draft and marks the section as having unsaved changes. No package command runs yet. **Save add-on changes** is disabled until the draft differs from the state received from the host.

When the user selects **Save add-on changes**:

1. Treat that click as explicit confirmation of every drafted install and uninstall.
2. Disable the add-on checkboxes and save button.
3. Show `Installing…` or `Uninstalling…` on each changed row.
4. Run the allowlisted Pi commands sequentially.
5. Re-read settings and replace both the baseline and draft with authoritative state.
6. On failure, stop, show a VS Code error, and replace the draft with the actual state, including any earlier commands that succeeded.

Closing Settings before saving discards the add-on draft. Closing it during a save does not cancel commands. Reopening Settings always reads current Pi settings.

## Shared add-on behavior

Keep the existing catalog in `src/setup.ts`; it does not need a new module yet. Extend its interface with installed-state and single-add-on command helpers:

```ts
export interface RecommendedAddon extends SetupOption {
  installed: boolean;
}

export const recommendedAddons: (agentDir?: string) => RecommendedAddon[];

export const addonCommand: (
  id: string,
  installed: boolean
) => { command: "pi"; args: ["install" | "remove", string] } | undefined;
```

`setup.ts` continues to own:

- the three-item catalog and display order;
- package source identifiers;
- reading `PI_CODING_AGENT_DIR` or `~/.pi/agent/settings.json`;
- matching string, `{ source }`, and pinned package entries;
- the package ID allowlist;
- software prerequisite detection.

`missingRecommendedAddons()` becomes a thin filter over `recommendedAddons()`. `addOnInstallCommand()` remains for the current terminal-based initial setup.

Do not create a generic Pi package manager. If package management later grows beyond these three recommendations, the add-on code can earn its own module then.

## Extension-host seam

Inject one small interface into `MischiefView` beside `ThreadSetup`:

```ts
export interface AddonSettings {
  list: () => RecommendedAddon[];
  setInstalled: (id: string, installed: boolean) => Promise<void>;
}
```

`extension.ts` provides the real adapter:

1. Validate each ID through `addonCommand()`.
2. Execute `pi install <source>` or `pi remove <source>` with the existing `exec()` helper.
3. Preserve concise stderr when reporting failure.

Tests inject an in-memory adapter; they never change the developer's Pi packages.

On save, `MischiefView` validates at most one change per known add-on, executes changes sequentially, and posts one fresh `list()` result. It keeps one private in-flight flag so a second save request is ignored. On failure it stops remaining commands, posts the actual list, then uses the existing `Mischief: <message>` error path.

Do not route reusable Settings changes through the one-time setup state machine.

## Protocol

Add a settings-safe shape without exposing package source strings:

```ts
export interface RecommendedAddonSetting {
  id: string;
  label: string;
  description: string;
  installed: boolean;
}
```

Extend `showSettings`:

```ts
{
  type: "showSettings";
  assignWorkspaceColors: boolean;
  addons: RecommendedAddonSetting[];
}
```

Add:

```ts
{ type: "recommendedAddons"; addons: RecommendedAddonSetting[] }
{
  type: "saveRecommendedAddons";
  changes: { id: string; installed: boolean }[];
}
```

`showSettings()` sends the latest list when opening the dialog. `saveRecommendedAddons` is sent only after explicit confirmation. The host validates IDs, booleans, duplicates, and the three-item maximum. `recommendedAddons` replaces draft state after the save.

## Webview

In `src/webview/app.tsx`:

- store separate baseline and draft add-on lists plus whether a save is pending;
- render one native checkbox per add-on below the Workspace-color setting;
- update only the draft when a checkbox changes;
- enable **Save add-on changes** only when the draft differs from the baseline;
- post one `saveRecommendedAddons` message containing only changed IDs after the button is selected;
- disable add-on checkboxes and the save button while saving;
- render per-row operation text with `aria-live="polite"`;
- accept the next host list as authoritative and replace both baseline and draft;
- discard an unsaved draft when Settings closes or reopens.

Reuse `.settings-option`. Add only minimal section, status, and note styles. Do not add custom switches, package logos, version selectors, or another settings page.

## Failure behavior

- **Pi missing:** restore state and show a clear error; prerequisite setup still owns Pi installation.
- **Install/remove fails:** stop the save, include useful stderr, re-read settings, and show actual checkbox values. Earlier successful changes remain installed or removed.
- **Settings missing or invalid:** treat recommendations as uninstalled, matching current setup behavior.
- **External package change:** reflect it the next time Settings opens.
- **Dialog closes during work:** let the command finish.
- **Existing Thread has stale add-ons:** leave it running and rely on the new-Thread note.

## Implementation sequence

### 1. Extend setup helpers

1. Add installed state to the shared catalog.
2. Add allowlisted install/remove argument generation.
3. Keep first-Thread setup behavior unchanged.
4. Add focused setup tests.

### 2. Add host behavior

1. Add the injected `AddonSettings` interface.
2. Build its concrete adapter in `extension.ts` with `exec()`.
3. Include add-on state in `showSettings()`.
4. Handle validated save batches, sequential commands, success refresh, and partial-failure refresh.

### 3. Add Settings UI

1. Extend protocol messages.
2. Render the add-on section and explicit Save button.
3. Add baseline/draft state, dirty detection, disabled/progress behavior, and authoritative refresh.
4. Discard unsaved drafts when the dialog closes or reopens.
5. Add the new-Thread lifecycle note.

### 4. Document and verify

1. Update README setup documentation to point users to Settings when they change their mind.
2. Explain that Todo supplies ACP plans while bundled Ask User supplies ACP elicitation.
3. Test real installation only with a temporary `PI_CODING_AGENT_DIR`.
4. Run `pnpm check`.

## Tests

### `src/setup.test.ts`

- Catalog order remains Todo, Ponytail, Matt Pocock Skills.
- Missing settings marks all recommendations uninstalled.
- String, object, and pinned sources are recognized.
- Similar unknown sources do not match.
- Known IDs produce exact `pi install` and `pi remove` arguments.
- Unknown IDs produce no command.
- Existing ordered setup commands remain unchanged.

### `src/view.test.ts`

- Opening Settings includes installed states.
- Checkbox edits alone call no package operation.
- A valid save calls `setInstalled()` sequentially for only changed add-ons.
- Duplicate, unknown, malformed, or oversized change lists are rejected.
- Success posts one authoritative `recommendedAddons` update.
- Partial failure stops remaining changes, posts actual state, and surfaces an error.
- A second save is ignored while one is active.
- Workspace-color settings remain unchanged.

### `src/webview/app.test.tsx`

- All three recommendations render with host-provided states.
- Checking or unchecking changes only the local draft and posts nothing.
- Save is disabled for a clean draft and enabled for a dirty draft.
- Save posts one message containing only changed add-ons.
- All add-on controls disable during the save.
- Installing/Uninstalling is announced for changed rows.
- A host update replaces baseline and draft, then re-enables controls.
- Closing or reopening Settings discards an unsaved draft.
- The new-Thread note is visible.

### Manual

With a temporary `PI_CODING_AGENT_DIR`:

1. Check Todo and verify no package change occurs before Save.
2. Save, then verify `settings.json` plus ACP plan updates in a new Thread.
3. Uncheck Todo, close Settings without saving, and verify Todo remains installed.
4. Reopen, uncheck, save, and verify a subsequent Thread has no Todo tool while conversation and bundled Ask User still work.
5. Confirm the already-running Thread is not restarted.
6. Save multiple changes and verify commands run sequentially.
7. Force the second command to fail and verify actual partial state plus error display.

## Expected files

| File                       | Change                                         |
| -------------------------- | ---------------------------------------------- |
| `src/setup.ts`             | Add installed-state and install/remove helpers |
| `src/setup.test.ts`        | Cover catalog state and commands               |
| `src/extension.ts`         | Provide the Pi command adapter                 |
| `src/view.ts`              | Send settings state and handle toggles         |
| `src/view.test.ts`         | Test host behavior                             |
| `src/webview/protocol.ts`  | Add add-on settings messages                   |
| `src/webview/app.tsx`      | Render and operate checkboxes                  |
| `src/webview/app.test.tsx` | Test settings interactions                     |
| `media/webview.css`        | Add minimal section/progress styling           |
| `README.md`                | Explain setup and later changes                |

No MagPi, ACP translation, Profile Database, or Thread persistence changes are required.

## Acceptance criteria

- First-Thread setup still recommends every missing add-on, including Todo.
- Ask User is not separately recommended.
- Settings accurately shows global installation state for all three recommendations.
- Checkbox edits run no package commands until **Save add-on changes** is selected.
- Saving installs checked packages and removes unchecked packages that changed.
- Closing without saving discards the draft.
- One dialog cannot start overlapping saves.
- Progress is visible and accessible.
- Failures restore authoritative state and show a useful error.
- Reopening Settings reflects external changes.
- Running Threads are never terminated or silently reloaded.
- Documentation distinguishes Todo plans from Ask User elicitation.
- No second package-state store, generic package manager, or new dependency is added.
- `pnpm check` passes.

## Non-goals

- Bundling Todo into MagPi.
- Managing arbitrary or project-local Pi packages.
- Selecting, pinning, or updating package versions.
- Automatically restarting active Threads.
- Replacing the prerequisite setup flow.
- Adding Ask User to the recommendations.
