# Mischief

A VS Code extension for managing Projects, Workspaces, and graphical Agent Threads powered by MagPi ACP.

Mischief provides a profile-wide Project/Workspace browser plus durable MagPi-backed Threads with streamed messages, thinking, tools, plans, inline interaction requests, Agent configuration, cancellation, and transcript restoration.

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
- [Node.js](https://nodejs.org/) 22 or newer. `npm` is included with Node.js.
- [Pi](https://github.com/earendil-works/pi-mono), installed as `pi` on `PATH` and configured with a model provider.
- [MagPi ACP](https://github.com/digital-overground/magpi-acp), installed as `magpi-acp` on `PATH` or selected with the `mischief.magpiAcpPath` setting.

[Git](https://git-scm.com/) is required for Git Projects, linked worktree discovery, status, and worktree creation. Without Git, Mischief can still manage folders as ungrouped Workspaces.

When using Remote SSH, Dev Containers, or WSL, install Node.js, Pi, MagPi ACP, and Git in that remote environment because Mischief runs there.

Before creating a Thread, Mischief checks for Node.js, Git, Pi, and MagPi ACP in the transcript. Press Enter to open the Node.js or Git installation page, or to install Pi and MagPi ACP in a visible terminal. After each step finishes, return to the transcript and press Enter to check again.

Mischief then offers four recommended Pi add-ons: Todo, Ask User, Ponytail, and Matt Pocock Skills. All are selected by default; deselect anything you do not want, then press Enter to install the selection.

## GitHub issue Workspaces

Starting a Workspace from a GitHub issue requires the GitHub CLI (`gh`). Authenticate with `gh auth login`; private repositories require an authenticated CLI session. Use `gh auth refresh` when credentials expire.

The first time you open issues for a Project, Mischief asks for the GitHub issue repository as `owner/repo`, defaulting to the Project's `origin`. The choice is stored in that Project's local Git config as `mischief.githubIssueRepo`, so linked Workspaces use it too. This allows a Project's code and issues to live in different repositories. Remove the key with `git config --local --unset mischief.githubIssueRepo` to choose again.

## Security and compatibility

Mischief, MagPi ACP, and Pi run locally with the same filesystem and process access as the VS Code extension host. Review Agent permission requests before approving them. Mischief supports desktop VS Code with local or remote folders; untrusted and virtual Workspaces are not supported.

## Development

Development additionally requires pnpm.

```text
pnpm install
pnpm check
```

Press **F5** in VS Code to launch the extension development host, or run `pnpm build` and package the extension with `vsce package`.

Development automatically uses `../magpi-acp/dist/index.js` when present. Otherwise install `magpi-acp` on `PATH` or set `mischief.magpiAcpPath` to its executable or built `index.js`.

## Tooling

Mischief is TypeScript-based and uses Ultracite's Oxlint + Oxfmt provider:

- `pnpm format` formats supported files.
- `pnpm format:check` verifies formatting.
- `pnpm lint` runs Ultracite's Oxlint + Oxfmt checks.
- `pnpm typecheck` runs TypeScript.
- `pnpm test` runs tests.
- `pnpm check` runs every validation step and builds the extension.
