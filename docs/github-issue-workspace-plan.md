# GitHub issue Workspace workflow plan

**Status:** Planned

## Tracking note

This Markdown plan is an explicitly requested, noncanonical working artifact. Repository convention keeps issues and canonical specifications in GitHub Issues, so implementation should begin only after a GitHub issue contains the approved specification. The issue may link back to this artifact for history.

## Goal

Let a user start issue work from a managed Git Project without leaving the Mischief workflow:

1. click an icon-only button on a Project;
2. choose one of that repository's open GitHub issues from a native VS Code picker;
3. optionally open the issue on GitHub;
4. choose the source branch for the work;
5. confirm or edit a generated branch/Workspace name;
6. create a linked Git worktree and new branch from the selected source;
7. open the resulting Workspace in a new VS Code window;
8. focus Mischief; and
9. create a Thread that asks the Agent to read and summarize the issue before planning continues.

The implementation should reuse the existing Project → Workspace → Thread flow. It should not add an embedded issue browser, a GitHub SDK, or a second Workspace-creation path.

## Confirmed decisions

- GitHub access uses the installed `gh` CLI, run with the Project root as its working directory. `gh` owns repository inference and authentication.
- The issue picker uses VS Code's native `QuickPick`.
- Only open issues are listed.
- Pressing Enter on an issue starts work. An inline external-link button opens that issue on GitHub without starting work.
- The source picker lists local branches first and remote-only `origin/*` branches afterward.
- The current local branch appears first. Remaining branches are alphabetical within their group.
- Local branches show their ahead/behind counts relative to the matching existing `origin/<branch>` remote-tracking ref. Branches without a matching `origin/*` ref are marked local-only.
- Mischief does not run `git fetch` implicitly. Ahead/behind values describe the repository's current local remote-tracking refs.
- A remote branch is remote-only when an `origin/<name>` ref exists and no local `<name>` branch exists. Symbolic refs such as `origin/HEAD` are excluded.
- The generated issue name is at most 50 characters for the complete value, including the `issue-<number>_` prefix. This interpretation was confirmed after review.
- Creating a new branch and attaching its worktree remains one Git operation: `git worktree add -b <branch> <path> <source>`.
- Selecting a remote source does not automatically configure an upstream for the new branch.
- The initial Thread prompt is sent automatically, not merely placed in the composer.

## User-visible flow

### Project action

Each Git Project row gains an icon-only **Open GitHub Issues** button alongside the existing New Workspace and Remove Membership buttons. Reuse the existing circle SVG as the issue icon rather than adding an icon dependency.

The button must have both `title="Open GitHub Issues"` and `aria-label="Open GitHub Issues"`. Non-Git standalone Workspaces do not receive the button because issues are scoped to a Git Project.

### Issue picker

On click, Mischief runs this command from the selected Project root:

```text
gh issue list --state open --limit 1000 --json number,title,url
```

After the command succeeds, Mischief opens a native VS Code picker titled `Open Issues · <project name>`. Preserve the order returned by `gh`.

Each selectable row contains:

- label: `#<number> <title>`;
- an external-link item button with tooltip `Open #<number> on GitHub`; and
- the issue number, title, and URL as host-side item data.

Behavior:

- Enter or a normal item click closes the issue picker and continues to the source-branch picker.
- The external-link button calls `vscode.env.openExternal()` with the issue URL and leaves the issue picker open.
- Escape closes the picker without changing Git state.
- An empty result displays `No open GitHub issues for <project name>.` and stops.
- Only an explicit issue acceptance starts the branch flow.

`gh` output is an external-system boundary. Decode the JSON and reject malformed entries rather than casting unchecked data. Require a positive integer `number`, non-empty string `title`, and HTTPS `url`.

### Source-branch picker

After issue selection, request source branches through the existing `Projects` module. The picker is titled `Source Branch for #<number>` and contains these groups:

1. **Local**
   - current branch first;
   - all other local branches alphabetically;
   - matching origin divergence shown as `↑<ahead> ↓<behind>`;
   - branches without `origin/<same-name>` shown as `local only`.
2. **Remote only**
   - `origin/*` refs with no same-name local branch;
   - alphabetical;
   - omit the group entirely when empty.

The current branch is the initial active item, but the user must accept an item. Escape stops without changing Git state.

The branch inventory is read from refs already present locally. Do not fetch, checkout, create branches, or mutate tracking configuration while populating the picker.

### Branch and Workspace name

After source selection, open a native input box:

- title: `New Workspace for #<number>`;
- prompt: `Create a linked worktree and branch from <source>`;
- initial value: the generated issue name.

Generate the initial value as follows:

1. lowercase the issue title;
2. replace each run of characters that is not a Unicode letter or number with `-`;
3. trim leading and trailing `-` characters;
4. prefix with `issue-<number>_`; and
5. truncate the complete value to 50 characters, then remove a trailing `-` if truncation created one.

Example:

```text
#123 Improve Workspace / branch creation!
-> issue-123_improve-workspace-branch-creation
```

If title normalization produces no title segment, use `issue-<number>`.

Continue using the existing Workspace-name rules for edited input: normalize whitespace, reject empty names and slashes in the input box, and let `git check-ref-format --branch` perform authoritative Git validation. Existing branch-name or worktree-path collisions should surface as the Git error; do not invent suffixes.

### Workspace creation

Extend the existing `Projects.createWorkspace()` interface with an optional source ref. Existing New Workspace callers omit the source and retain their current behavior of branching from `HEAD`. The issue flow passes the selected local or `origin/*` ref.

Extend `createGitWorkspace()` similarly. Its command becomes:

```text
git -C <project-root> worktree add -b <new-branch> <workspace-path> <source-ref>
```

When no source is provided, preserve the existing command without a final source argument.

Continue using the existing Workspace path:

```text
<project-parent>/worktrees/<project-name>-<normalized-name>
```

Use `execFile`, not a shell command string, so user-provided names and Git refs remain separate process arguments.

After successful creation:

1. apply Workspace colors through the existing best-effort path;
2. refresh the Projects snapshot;
3. persist a pending Workspace start record containing the path and initial prompt;
4. render the refreshed Project list; and
5. open the Workspace with `vscode.openFolder` and `forceNewWindow: true`.

If worktree creation fails, do not persist a pending start or open another window.

### Cross-window Thread startup

Replace the pending-start storage value from plain Workspace paths to records:

```ts
interface PendingWorkspaceStart {
  path: string;
  prompt?: string;
}
```

A normal New Workspace action stores only `path`. An issue Workspace stores `path` and this prompt, substituting the selected issue number:

```text
start planning work on GitHub issue #123. Read it with gh issue view 123 --comments.  return to the user once you've read the issue and give them a summary of the item
```

The destination extension host already identifies the current Workspace during initialization. When its canonical path matches a pending record, it must:

1. remove that record before starting side effects, preventing duplicate startup on another initialization;
2. execute `workbench.view.extension.mischief`;
3. create exactly one new Thread through `Threads.newThread()`; and
4. when `prompt` is present, send it through `Threads.prompt()`.

A normal pending Workspace without a prompt continues to focus Mischief and create an empty Thread. No `Threads` interface changes are required.

If the Agent cannot create the ACP session or run the prompt, preserve the Thread and use the existing error/retry behavior.

## Module placement and interface changes

### `src/projects/github.ts` — new internal GitHub adapter

Own only GitHub CLI invocation and response decoding. Its function remains behind the `Projects` interface rather than becoming a second test surface.

The adapter runs `gh`, decodes its JSON, and validates issue values. It does not own VS Code UI, issue-name formatting, Git branches, Workspace creation, or Thread startup.

Do not add a generic command runner interface. Tests cross `Projects` and may mock Node's `child_process.execFile` because the process boundary is the external-system seam.

### `src/projects/git.ts`

Add the smallest branch representation needed by the picker:

```ts
interface GitSourceBranch {
  name: string;
  current: boolean;
  remoteOnly: boolean;
  ahead?: number;
  behind?: number;
}
```

Add branch discovery and allow `createGitWorkspace()` to receive an optional source ref. Keep ref parsing, symbolic-ref filtering, origin matching, divergence calculation, and Git commands inside this adapter.

### `src/projects/projects.ts`

Expose issue listing and source branches through the existing deep `Projects` module, keeping GitHub CLI and Git details out of `MischiefView`:

```ts
interface GitHubIssue {
  number: number;
  title: string;
  url: string;
}

issueWorkspaceName(issue: GitHubIssue): string
listOpenIssues(projectRoot: string): Promise<GitHubIssue[]>
sourceBranches(projectRoot: string): Promise<GitSourceBranch[]>
createWorkspace(
  projectRoot: string,
  name: string,
  sourceRef?: string
): Promise<string>
```

The class methods canonicalize and verify that the Project is managed before delegating to the internal GitHub or Git adapter. `issueWorkspaceName()` is a pure Project-module helper like the existing `normalizeWorkspaceName()`.

### `src/view.ts`

Coordinate the user workflow:

- receive the Project's `openIssues` message;
- load and display issues;
- handle the external-link item button;
- display the source picker;
- prompt for the name;
- call the existing Workspace creation flow with the source ref and prompt;
- persist the richer pending-start record; and
- seed the Thread in the destination window.

Keep issue fetching, branch discovery, name validation, creation, and startup sequential so cancellation at any picker exits before mutation.

### Webview protocol and Project row

- `src/webview/protocol.ts`: add `{ type: "openIssues"; path: string }`.
- `src/webview/projects/projects-pane.tsx`: add the accessible icon-only Project action and post the message.
- Reuse `SvgIcon`'s existing `circle` kind.

No issue data crosses into the Webview. The native picker lives entirely in the extension host, so the host-to-Webview state shape does not change.

## TDD seams to confirm before implementation

Approval of this plan should confirm these observable seams as the test surfaces:

1. **Projects interface:** open-issue listing, issue-name generation, source-branch discovery, and source-based Workspace creation. Mock only the external `gh` process boundary; exercise Git behavior against temporary real repositories.
2. **Webview message seam:** clicking the Project issue icon posts the expected typed message.
3. **VS Code host adapter:** issue selection, external opening, branch selection, cancellation, pending-start persistence, window opening, and destination startup are observed through fake VS Code primitives and the existing `Projects`/`Threads` interfaces.
4. **Threads interface:** no new tests unless implementation requires a Thread behavior change; `newThread()` followed by `prompt()` is already supported.

Do not test private parsing helpers, private picker helpers, exact internal call counts unrelated to behavior, or implementation-specific ref commands from view tests.

## Phased red-green implementation

Each phase is a vertical slice. Within a phase, complete one red → green cycle before adding the next failing test. Do not write all tests first, and defer cleanup until the review after a slice is green.

### Phase 1 — Project action and open-issue picker

**Outcome:** A Project can list open issues in a native picker and open one on GitHub. No Git state changes are possible yet.

#### Cycle 1.1 — Project action message

**Red**

Add a Webview test that renders one Project, clicks the icon-only Open GitHub Issues button by accessible label, and expects this message:

```ts
{ type: "openIssues", path: "/project" }
```

**Green**

Add the protocol variant and Project-row button using the existing circle SVG.

**Check**

Run the focused Webview test. Confirm the existing New Workspace and Remove Membership buttons still post their original messages.

#### Cycle 1.2 — Open-issue decoding

**Red**

Add a `Projects` interface test with fixed `gh` JSON containing two known issues. Call `Projects.listOpenIssues()` and expect exact `GitHubIssue` literals. Add one malformed fixture and expect a useful rejection.

The external process fake must also reject unless arguments include `issue list`, `--state open`, and the expected Project working directory. This assertion protects the user-visible open-only and repository-scoping requirements at the external-system seam without testing the internal GitHub adapter directly.

**Green**

Implement the internal GitHub adapter with `execFile`, JSON parsing, and value validation, then expose it through `Projects.listOpenIssues()`.

**Check**

Run the focused `Projects` test. Then manually run the production command in this repository to verify `gh` compatibility without making the test depend on GitHub or credentials.

#### Cycle 1.3 — Native issue picker

**Red**

Add a host test that triggers `openIssues` for a known Project and verifies the native picker receives the issue labels and external-link buttons. Trigger an item's external-link event and expect the corresponding HTTPS URL to be opened while the picker remains available.

Add cancellation and empty-list cases only after the successful case is green:

- Escape causes no branch request or Workspace creation.
- An empty list shows the no-open-issues information message.

**Green**

Implement the smallest `createQuickPick` wrapper needed for item buttons and acceptance. Dispose event subscriptions and the picker when the flow ends.

**Phase acceptance**

- Only Git Projects render the icon.
- Only open issues are requested.
- Issue acceptance is distinct from opening externally.
- No branch or worktree command runs in this phase.

### Phase 2 — Source selection and source-based Workspace creation

**Outcome:** Accepting an issue creates a correctly named branch and linked Workspace from the selected local or remote source.

#### Cycle 2.1 — Source branch inventory

**Red**

Add a `Projects` test using a temporary real Git repository with known refs:

- current local `main`;
- another local branch;
- matching `origin/main` with a known divergence;
- one remote-only `origin/release`; and
- symbolic `origin/HEAD`.

Expect exact branch values proving:

- current local first;
- remaining locals alphabetical;
- known ahead/behind counts;
- remote-only branches after locals;
- no duplicate `origin/main`; and
- no symbolic `origin/HEAD`.

Use fixed commits and literals for expected counts. Do not calculate expected counts with the production parsing logic.

**Green**

Implement branch discovery in `git.ts` and the managed-Project method in `Projects`.

For each local branch with a matching origin ref, calculate divergence with:

```text
git rev-list --left-right --count origin/<name>...<name>
```

Interpret the left count as behind and the right count as ahead.

**Check**

Run `src/projects/projects.test.ts`. Verify repositories without `origin` still return local branches marked local-only.

#### Cycle 2.2 — Generated issue name

**Red**

Add table cases with known literal outputs:

- ordinary words and spaces;
- punctuation and slash replacement;
- repeated separators;
- mixed case;
- an empty normalized title;
- a long title whose complete generated value is exactly 50 characters; and
- truncation that would otherwise leave a trailing hyphen.

**Green**

Implement only the stated normalization and truncation rules.

**Check**

Run the focused `Projects` test. Do not generalize this into a configurable slug system.

#### Cycle 2.3 — Create from selected source

**Red**

Extend the existing real-Git Workspace creation test with a source branch pointing at a commit different from `HEAD`. Create the Workspace through `Projects.createWorkspace(root, name, sourceRef)` and assert:

- the new branch name;
- the existing sibling worktree path; and
- the new Workspace's `HEAD` equals the selected source commit.

**Green**

Pass the optional `sourceRef` through `Projects` and `createGitWorkspace()`, adding the final `git worktree add` argument only when supplied.

**Check**

Keep the existing no-source test green to prove the manual New Workspace flow still starts from `HEAD`.

#### Cycle 2.4 — Picker-to-creation orchestration

**Red**

Extend the host test so accepting an issue:

1. requests Project source branches;
2. shows Local and Remote only picker groups;
3. uses the current local branch as the initial active item;
4. presents the expected generated name;
5. passes the edited name and selected source to `Projects.createWorkspace()`; and
6. opens the returned Workspace only after creation succeeds.

Then add one cancellation case at each pre-mutation step: source picker and name input. Both must leave Workspace creation untouched.

**Green**

Connect the issue acceptance path to branch selection, input, and the existing Workspace creation behavior. Reuse the current color assignment, refresh, render, and open-window code rather than copying it.

**Phase acceptance**

- Local and remote-only grouping matches the confirmed rules.
- Divergence comes from existing origin refs without fetching.
- The initial name follows the exact format and limit.
- The selected source commit becomes the new branch's starting point.
- Existing manual Workspace creation is unchanged.

### Phase 3 — Cross-window seeded Thread

**Outcome:** The new Workspace window focuses Mischief and automatically starts the requested issue-summary Thread exactly once.

#### Cycle 3.1 — Seeded pending start

**Red**

Update the existing `MischiefView` startup test to store a pending record with a known path and prompt. On destination initialization, expect this observable order:

1. pending record removed;
2. Mischief view focus command executed;
3. one Thread created; and
4. the exact prompt sent once.

Use the requested prompt as a literal expected value so punctuation and issue-number substitution cannot drift.

**Green**

Add `PendingWorkspaceStart`, persist the issue prompt, match records by canonical Workspace path, and call the existing `newThread(false)` followed by `threads.prompt(prompt)`.

#### Cycle 3.2 — Preserve ordinary New Workspace startup

**Red**

Add or update the existing no-prompt pending-start case. It must focus Mischief and create one empty Thread without calling `Threads.prompt()`.

**Green**

Make `prompt` optional and branch only at the final send step.

#### Cycle 3.3 — Prevent duplicate startup

**Red**

Initialize again with the already-consumed pending state and assert that neither another Thread nor another prompt is created.

**Green**

Ensure the matching record is removed before focus and Thread creation.

**Phase acceptance**

- The pending record is written before opening the new window.
- The destination creates exactly one Thread.
- The requested prompt is visible as the first user message and starts the Agent.
- Agent failures remain retryable through existing Thread behavior.
- Normal New Workspace startup remains empty and unchanged.

### Phase 4 — Errors, documentation, and complete validation

**Outcome:** Failure modes are understandable, the dependency is documented, and the entire repository remains green.

Add only errors exercised by the earlier behavior tests:

- missing `gh`: explain that GitHub CLI is required;
- invalid or expired `gh` authentication: retain useful stderr and suggest authenticating with `gh auth login` or `gh auth refresh`;
- malformed `gh` output: report that the issue list could not be read;
- no open issues: information message, not an error;
- no source branches: information message and stop;
- invalid or colliding branch/worktree: surface the existing Git error;
- external URL open failure: show a VS Code error without starting work.

Update `README.md` to list `gh` as required for the issue workflow and state that private repositories require an authenticated GitHub CLI session.

Run focused checks after every red-green cycle, then finish with:

```text
pnpm check
```

Perform one Extension Development Host walkthrough:

1. click the icon-only Project action;
2. verify only open issues appear;
3. open one issue externally and confirm the picker stays open;
4. accept an issue;
5. verify local branch ordering and divergence labels;
6. verify remote-only grouping;
7. select a source and edit the generated name;
8. verify the new branch starts at the selected source;
9. verify the linked Workspace path and new VS Code window;
10. verify Mischief receives focus;
11. verify one Thread starts with the exact prompt; and
12. verify the Agent reads the issue and returns a summary rather than beginning implementation.

## Expected file changes

| File | Purpose |
| --- | --- |
| `src/projects/github.ts` | Internal `gh` invocation and issue-response validation |
| `src/projects/git.ts` | Source refs, origin divergence, remote-only filtering, and source-based worktree creation |
| `src/projects/projects.ts` | Managed-Project issue/branch interfaces, issue-name generation, and optional Workspace source ref |
| `src/projects/projects.test.ts` | Project-level issue behavior, name generation, real-Git branch inventory, and source-commit Workspace checks |
| `src/webview/protocol.ts` | Typed `openIssues` Webview message |
| `src/webview/projects/projects-pane.tsx` | Accessible icon-only Project action |
| `src/webview/app.test.tsx` | Project action message check |
| `src/view.ts` | Native pickers, orchestration, pending-start payload, and Thread seeding |
| `src/view.test.ts` | VS Code workflow, cancellation, external opening, and destination startup checks |
| `README.md` | `gh` prerequisite and issue workflow documentation |

Do not add dependencies, configuration keys, commands, an `issues/` domain module, an embedded issue view, or a generic process abstraction.

## Definition of done

- The Open GitHub Issues Project action is icon-only, keyboard reachable, and accessible by name.
- It lists only open issues for the selected Project's inferred GitHub repository.
- Any listed issue can be opened on GitHub without starting work.
- Accepting an issue requires explicit source-branch and name confirmation before mutation.
- Local branches precede remote-only origin branches and show accurate locally-known divergence.
- The default issue branch/Workspace name follows the specified normalization and 50-character limit.
- The linked worktree and new branch are created from the selected source ref.
- The new Workspace opens in a separate VS Code window and Mischief receives focus.
- Exactly one new Thread sends the exact issue-reading prompt.
- Cancellation before creation has no Git or Thread side effects.
- Existing New Workspace behavior remains green.
- `pnpm check` passes.

## Plan review record

- **Ponytail review:** no unnecessary complexity or over-engineering findings.
- **Standards review:** moved GitHub behavior tests to the `Projects` interface, renamed ambiguous `source` parameters to `sourceRef`, named the branch discriminator `remoteOnly`, and made this requested Markdown file explicitly noncanonical because the approved specification must live in a GitHub Issue.
- **Spec review:** restored the exact two-space prompt literal. The user confirmed that the 50-character cap applies to the complete generated name. Origin-only remote grouping follows the earlier explicit branch-picker decision. The 1,000-item `gh` limit is a practical picker ceiling, not a claim that every issue in an unbounded repository is loaded.

## Deliberate non-goals

- Rendering issue bodies or comments inside Mischief.
- Listing closed issues, pull requests, projects, or discussions.
- Editing, assigning, labeling, commenting on, or closing issues.
- Automatically fetching remotes.
- Supporting remotes other than `origin` in the first version.
- Automatically setting the new branch's upstream.
- Resolving branch/worktree collisions by renaming.
- Storing GitHub credentials or calling GitHub REST/GraphQL directly.
- Starting implementation before the Agent returns the requested issue summary.
