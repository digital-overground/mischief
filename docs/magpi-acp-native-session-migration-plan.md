# MagPi ACP 1.4 and Pi-native session operations migration

**Status:** Implemented; this plan is superseded by the code and canonical GitHub issues.

The original implementation plan was prepared on 2026-09-17 against Mischief `01141fe` and MagPi `58d287d`. Git history retains that plan. This note records only the resulting compatibility contract.

## Current contract

- Mischief uses `@agentclientprotocol/sdk` `^1.4.0` and the SDK app-style `client()` API.
- `src/threads/acp.ts` is the sole adapter for ACP and MagPi-private protocol details.
- Fork targets come from `_magpi-acp/session/fork-messages` and use native Pi entry IDs.
- Targeted forks send `_meta["magpi-acp/fork-entry-id"]` on the ACP fork request.
- Tree targets come from `_magpi-acp/session/tree`.
- Tree navigation uses `_magpi-acp/session/navigate-tree` and reloads the same Thread.
- The Webview requests actions but never receives Pi entry IDs; native VS Code QuickPicks keep those IDs in the extension host.
- Private response payloads are decoded at the ACP adapter boundary.
- Terminal authentication supports the standard ACP shape plus the temporary MagPi compatibility metadata.
- No Profile Database migration or second persistence layer was required.

## Thread naming

MagPi owns automatic Thread naming and sends standard ACP title updates. Mischief accepts those updates, preserves explicit user-renamed Thread names, and uses Agent-provided history titles. Mischief does not generate a deterministic first-prompt title or make a separate title-model call.

Canonical decision: [Mischief #28](https://github.com/digital-overground/mischief/issues/28).

## Remaining work

Open follow-up behavior belongs in canonical GitHub issues, including [#26](https://github.com/digital-overground/mischief/issues/26). Do not extend this historical plan with new requirements.
