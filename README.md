# Mischief

A VS Code extension for managing Projects, Workspaces, and graphical Agent Threads powered by MagPi, Claude Agent, or Codex over ACP.

Mischief provides a profile-wide Project/Workspace browser plus durable Threads with streamed messages, thinking, tools, plans, inline interaction requests, Agent configuration, cancellation, and transcript restoration.

Its domain hierarchy is:

```text
Project
  Workspace / linked worktree
    Thread
```

## Install

In VS Code, open **Extensions**, search for **Mischief**, and select **Install**. The first Thread walks through the remaining setup.

## Requirements

Install these on the machine where the VS Code extension host runs:

- [VS Code desktop](https://code.visualstudio.com/) 1.85 or newer.
- [Node.js](https://nodejs.org/) 22.19 or newer. `npm` is included with Node.js.
- Agent credentials or a configured model provider for the Agent you choose.

[Git](https://git-scm.com/) is required for Git Projects, linked worktree discovery, status, and worktree creation. Without Git, Mischief can still manage folders as ungrouped Workspaces.

When using Remote SSH, Dev Containers, or WSL, install Node.js and Git in that remote environment because Mischief runs there.

**MagPi**, **Claude Agent**, and **Codex** are available in Mischief Settings → Agents. At least one must be available; MagPi itself is optional. Choose an Agent when starting a Thread, or from the empty New Thread composer. An Agent cannot be changed after the Thread begins; previous MagPi Threads remain MagPi Threads. Thread History is scoped to the chosen Workspace and Agent.

Before installing an Agent, Mischief asks for approval and names the exact npm package. It installs only these three approved packages in VS Code profile storage, not globally. Once approved, it checks for and installs subsequent npm `latest` releases automatically. New connections use the verified update; running Threads keep their existing process. Settings shows installed and latest versions, status, and a manual update check. Failed updates keep the previous version available. MagPi includes Pi; a separate global Pi install is not required. `mischief.magpiAcpPath` still takes precedence for an explicitly configured development build, as does MagPi's `MAGPI_ACP_PI_COMMAND` override.

For a first Thread, Mischief checks Node.js, Git, and whether at least one Agent is available. If none is available, press Enter to choose which Agent to install, then approve the managed install. Starting a MagPi Thread also offers three optional Pi add-ons: Todo, Ponytail, and Matt Pocock Skills. Structured Ask User support is bundled with MagPi.

## GitHub issue Workspaces

Starting a Workspace from a GitHub issue requires the GitHub CLI (`gh`). Authenticate with `gh auth login`; private repositories require an authenticated CLI session. Use `gh auth refresh` when credentials expire.

The first time you open issues for a Project, Mischief asks for the GitHub issue repository as `owner/repo`, defaulting to the Project's `origin`. The choice is stored in that Project's local Git config as `mischief.githubIssueRepo`, so linked Workspaces use it too. This allows a Project's code and issues to live in different repositories. Remove the key with `git config --local --unset mischief.githubIssueRepo` to choose again.

## Security and compatibility

Mischief and the selected Agent run locally with the same filesystem and process access as the VS Code extension host. Review Agent permission requests before approving them. Mischief supports desktop VS Code with local or remote folders; untrusted and virtual Workspaces are not supported.

## Development

Development additionally requires pnpm.

```text
pnpm install
pnpm check
```

Press **F5** in VS Code to launch the extension development host, or run `pnpm build` and package the extension with `vsce package`.

Development automatically uses `../magpi-acp/dist/index.js` when present. `mischief.magpiAcpPath` explicitly overrides MagPi's launch; without either, Mischief uses its approved managed installation, falling back to `magpi-acp` on `PATH` for existing users.

## Tooling

Mischief is TypeScript-based and uses Ultracite's Oxlint + Oxfmt provider:

- `pnpm format` formats supported files.
- `pnpm format:check` verifies formatting.
- `pnpm lint` runs Ultracite's Oxlint + Oxfmt checks.
- `pnpm typecheck` runs TypeScript.
- `pnpm test` runs tests.
- `pnpm check` runs every validation step and builds the extension.
