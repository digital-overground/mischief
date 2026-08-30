# Slash command support plan

**Status:** Implemented

## Decision

Mischief will target Pi through MagPi ACP while keeping ACP details inside the existing Agent adapter. The slash-command namespace belongs to the Agent.

Remove Mischief's local `/new` interception. New Threads remain available through the existing button and VS Code command.

## Protocol findings

ACP v1 already defines slash-command discovery and invocation:

- An Agent advertises the current command list with a `session/update` notification whose `sessionUpdate` is `available_commands_update`.
- Each command has a name, description, and optional unstructured-input hint.
- A later update replaces the available list, allowing commands to change during a session.
- A command runs as an ordinary prompt containing `/name args`; there is no separate command-execution method.

MagPi ACP already converts Pi's RPC `get_commands` result into `available_commands_update`. It currently advertises Pi prompt templates, enabled skills, and a curated set of headless commands. Mischief receives but discards that update in `src/threads/acp.ts`.

## Scope

The first version will:

- autocomplete commands advertised by the active Agent;
- show command names, descriptions, and input hints;
- support keyboard and mouse selection;
- pass selected or manually typed slash commands through the existing prompt path;
- apply dynamic command-list replacements, including an empty list; and
- remove the local `/new` alias.

It will not hard-code Pi's interactive TUI command list, read Pi command files directly, add a separate command executor, or reject unadvertised slash text.

## Design

### ACP adapter

In `src/threads/acp.ts`, translate `available_commands_update` into a Thread-owned value:

```ts
interface ThreadCommand {
  name: string;
  description: string;
  inputHint?: string;
}
```

Add a command-list variant to `AgentUpdate`. Raw ACP types and future protocol-version differences remain inside the adapter.

### Threads module

In `src/threads/threads.ts`:

- initialize each Thread runtime with an empty command list;
- replace the complete list whenever a command update arrives;
- expose the list through `ThreadDetail`; and
- do not persist it, because the Agent advertises it after Thread session creation or loading.

No new interface or command-execution method is needed. Commands use the existing `Threads.prompt()` flow.

### Webview composer

In `src/webview/composer.tsx`:

- remove the `/new` special case;
- detect a slash query only at the beginning of the prompt;
- filter advertised commands by command-name prefix while preserving Agent order;
- reuse the existing suggestion popup and its arrow, Tab, Enter, Escape, and mouse behavior;
- render `/name`, the optional input hint, and the description;
- insert `/${name}` on selection, adding a trailing space when input is expected; and
- allow unmatched slash text to be sent unchanged.

No dependency or new Webview module is required.

## Data flow

```text
Pi get_commands
  -> MagPi ACP available_commands_update
  -> src/threads/acp.ts translation
  -> Threads runtime / ThreadDetail
  -> composer autocomplete
  -> existing prompt path with "/name args"
```

## Tests

Add focused checks to the existing suites:

1. `src/threads/acp.test.ts`
   - translates command names, descriptions, and input hints;
   - ignores unsupported input metadata without dropping the command.
2. `src/threads/threads.test.ts`
   - exposes advertised commands in the selected Thread;
   - replaces the previous list and clears it on an empty update.
3. Webview test
   - opens and filters suggestions from `/` input;
   - supports keyboard and mouse selection;
   - inserts the expected command text;
   - sends `/new` as an Agent prompt rather than creating a Thread.

## Acceptance criteria

- Typing `/` at the start of the composer shows the active Thread's advertised commands.
- Suggestions show name, description, and input hint when present.
- Arrow keys change selection; Tab or Enter accepts it; Escape closes it; clicking accepts it.
- Dynamic updates fully replace the visible command list.
- Unknown slash text is still sent unchanged.
- `/new` no longer creates a Thread from the composer.
- The Webview and `Threads` module import no ACP or Pi-specific types.
- Existing prompt queueing, images, cancellation, and New Thread controls continue to work.

## Future compatibility

Another ACP v1 Agent should work without a slash-command refactor. ACP v2 keeps `available_commands_update` but adds an input-type discriminator, so migration should remain an adapter-only change.

A non-ACP Agent would require another implementation of the existing Agent connection seam, but the Thread command shape and composer would not need to change.

Expanding which Pi commands MagPi can execute is a MagPi concern. Mischief should continue to render only what the Agent advertises.

## Sources

- [ACP v1: Slash Commands](https://agentclientprotocol.com/protocol/v1/slash-commands)
- [ACP v2 migration: Slash commands](https://agentclientprotocol.com/protocol/v2/migration#slash-commands)
- Pi RPC documentation: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md` (`get_commands`)
