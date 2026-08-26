# Mischief

A VS Code extension for managing Projects, Workspaces, and graphical Agent Threads powered by MagPi ACP.

The first working slice provides a profile-wide Project/Workspace browser with Git worktree discovery, Git status, membership controls, and Workspace navigation. Thread support comes next.

Its domain hierarchy is:

```text
Project
  Workspace / linked worktree
    Thread
```

## Development

Requires Node.js 20+ and pnpm.

```text
pnpm install
pnpm check
```

Press **F5** in VS Code to launch the extension development host, or run `pnpm build` and package the extension with `vsce package`.

## Tooling

Mischief is TypeScript-based and uses Ultracite's Oxlint + Oxfmt provider:

- `pnpm format` formats supported files.
- `pnpm format:check` verifies formatting.
- `pnpm lint` runs Oxlint.
- `pnpm typecheck` runs TypeScript.
- `pnpm test` runs tests.
- `pnpm check` runs every validation step and builds the extension.
