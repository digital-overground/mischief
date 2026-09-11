# Mischief

A VS Code extension for managing Projects, Workspaces, and graphical Agent Threads powered by MagPi ACP.

Mischief provides a profile-wide Project/Workspace browser plus durable MagPi-backed Threads with streamed messages, thinking, tools, plans, inline interaction requests, Agent configuration, cancellation, and transcript restoration.

Its domain hierarchy is:

```text
Project
  Workspace / linked worktree
    Thread
```

## GitHub issue Workspaces

Starting a Workspace from a GitHub issue requires the GitHub CLI (`gh`). Authenticate with `gh auth login`; private repositories require an authenticated CLI session. Use `gh auth refresh` when credentials expire.

## Development

Requires Node.js 20+ and pnpm.

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
