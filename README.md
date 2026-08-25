# Mischief

A VS Code extension for managing Projects, Workspaces, and graphical Agent Threads powered by MagPi ACP.

The project is intentionally starting clean. Its domain hierarchy is:

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

Press **F5** from VS Code after adding a launch configuration, or run `pnpm build` and package the extension with `vsce package`.

## Tooling

Mischief is TypeScript-based and uses Ultracite's Oxlint + Oxfmt provider:

- `pnpm format` formats supported files.
- `pnpm format:check` verifies formatting.
- `pnpm lint` runs Oxlint.
- `pnpm typecheck` runs TypeScript.
- `pnpm test` runs tests.
- `pnpm check` runs every validation step and builds the extension.
