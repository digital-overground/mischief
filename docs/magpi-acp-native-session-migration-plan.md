# MagPi ACP 1.4 and Pi-native session operations migration

**Status:** Implemented; this plan is superseded by the code and canonical GitHub issues.

The original implementation plan was prepared on 2026-09-17 against Mischief `01141fe` and MagPi `58d287d`. Git history retains that plan. This note records only the resulting compatibility contract.

## Current contract

- Mischief uses `@agentclientprotocol/sdk` `^1.4.0` and the SDK app-style `client()` API.
- `src/threads/acp/acp.ts` is the sole adapter for ACP and MagPi-private protocol details.
- Transcript-row forks send ACP message IDs through `_meta["magpi-acp/fork-message-id"]`.
- Transcript-row tree navigation sends ACP message IDs to `_magpi-acp/session/navigate-tree` and reloads the same Thread.
- MagPi resolves native Pi targets; Mischief no longer requests native fork/tree target lists or shows footer Fork/Tree QuickPicks.
- Private response payloads are decoded at the ACP adapter boundary.
- Terminal authentication supports the standard ACP shape plus the temporary MagPi compatibility metadata.
- No Profile Database migration or second persistence layer was required.

## Thread naming

MagPi owns automatic Thread naming and sends standard ACP title updates. Mischief accepts those updates, preserves explicit user-renamed Thread names, and uses Agent-provided history titles. Mischief does not generate a deterministic first-prompt title or make a separate title-model call.

Canonical decision: [Mischief #28](https://github.com/digital-overground/mischief/issues/28).

## Remaining work

Open follow-up behavior belongs in canonical GitHub issues, including [#26](https://github.com/digital-overground/mischief/issues/26). Do not extend this historical plan with new requirements.
