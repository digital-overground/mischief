# MagPi non-destructive steering research

## Question

Can MagPi expose Pi's live steering so Mischief can send a queued message into an active Thread without cancelling the Agent's current turn?

## Conclusion

**Yes.** Pi 1.2.0 already has the required behavior in both its SDK and RPC protocol. MagPi currently hides it behind a second, adapter-owned queue, and Mischief's “Send immediately” implementation explicitly cancels the ACP turn.

The smallest safe product shape is a capability-gated MagPi ACP extension method. For MagPi Threads, the queue action can become **Steer now** and call Pi's `steer` RPC command. Other ACP Agents should keep a separately named **Interrupt and send** action only if cancellation is still desired.

This cannot be implemented portably over ACP v1: standard ACP v1 has `session/prompt` and `session/cancel`, but no steering request. ACP v2 changes prompt lifetime and permits Agents to accept prompts while work is active, but explicitly does not require that support. MagPi currently negotiates protocol version 1.

## What Pi supports

Pi distinguishes two non-destructive queue semantics:

- **Steering**: delivered after the current assistant response and its tool calls, before the next model request.
- **Follow-up**: delivered after the active run has finished all pending work.

The SDK exposes `AgentSession.steer()` and `AgentSession.followUp()`. A `prompt()` submitted during streaming must choose `streamingBehavior: "steer" | "followUp"`; Pi rejects the call rather than guessing. See the bundled Pi 1.2.0 [SDK prompting reference](../../../magpi-acp/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md#prompting).

Pi's RPC mode exposes the same operations directly:

- `{ "type": "steer", "message": ... }`
- `{ "type": "follow_up", "message": ... }`
- `{ "type": "clear_queue" }`
- `prompt` with `streamingBehavior`

The canonical behavior is documented in Pi's bundled [RPC command reference](../../../magpi-acp/node_modules/@earendil-works/pi-coding-agent/docs/rpc-commands.md#steer). The installed declarations include these commands and their queue dispositions in [`rpc-types.d.ts`](../../../magpi-acp/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts). The RPC dispatcher calls `session.steer(...)` directly in [`rpc-mode.js`](../../../magpi-acp/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js).

Pi also emits `queue_update` events containing the complete steering and follow-up queues. When a queued user message begins, Pi removes it from the appropriate queue before emitting the user `message_start`, so a client can distinguish “accepted but waiting” from “now part of the transcript.” See the bundled [JSON event reference](../../../magpi-acp/node_modules/@earendil-works/pi-coding-agent/docs/json.md#queue-and-state-events) and [`agent-session.js`](../../../magpi-acp/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js).

Steering is non-destructive, but it is not instantaneous injection into a running model response or tool call. It waits for the current assistant turn and its tool calls to reach a safe boundary, then becomes a user message before the next model call.

## What MagPi does today

MagPi launches one `pi --mode rpc` subprocess per live ACP session. [`PiRpcProcess`](../../../magpi-acp/src/pi-rpc/process.ts) defines wrappers for `prompt`, `abort`, and steering/follow-up delivery-mode settings, but its command union and methods omit Pi's `steer`, `follow_up`, `clear_queue`, and `prompt.streamingBehavior` operations.

[`MagPiAcpSession.prompt()`](../../../magpi-acp/src/acp/magpi-session.ts) owns a separate FIFO `turnQueue`. When an ACP prompt arrives during an active turn, MagPi queues it itself. It sends the next item to Pi only after Pi emits `agent_settled`. Therefore Pi never sees that item while streaming and never gets a chance to apply native steering semantics.

[`MagPiAcpSession.cancel()`](../../../magpi-acp/src/acp/magpi-session.ts) clears MagPi's adapter queue and calls Pi `abort`. This is the cancellation behavior Mischief currently reaches.

Mischief then adds another queue above MagPi. [`Threads.sendSteering()`](../../src/threads/threads/threads.ts) moves the chosen local message to the front and calls ACP `session/cancel`; once cancellation settles, Mischief submits that message as the next ordinary ACP prompt. The current name “steering” therefore describes local queue management, not Pi steering.

## ACP constraints

ACP v1's standard Agent methods expose `session/prompt` and `session/cancel`, with no standard steer/follow-up method. This is visible in the installed ACP 1.4 SDK method declarations at [`node_modules/@agentclientprotocol/sdk/dist/acp.d.ts`](../../node_modules/@agentclientprotocol/sdk/dist/acp.d.ts) and in the official [ACP v1 prompt-turn specification](https://agentclientprotocol.com/protocol/v1/prompt-turn).

MagPi already uses capability-advertised private ACP behavior for message-target actions and `_magpi-acp/session/navigate-tree`; see MagPi's [`initialize()` and `extMethod()`](../../../magpi-acp/src/acp/agent.ts), its request registration in [`src/index.ts`](../../../magpi-acp/src/index.ts), and Mischief's [`magpiAcpExtension`](../../src/threads/acp/magpi-acp.ts). Steering can follow that established seam instead of pretending all ACP Agents support it.

ACP v2's [prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle) makes a future standard implementation possible: `session/prompt` lasts until insertion of the user message rather than the whole turn, and an Agent may accept prompts during active work. The specification explicitly says this does not require Agents to support prompts while work is active. MagPi's current [`initialize()`](../../../magpi-acp/src/acp/agent.ts) pins protocol version 1, so v2 is not the short path.

## Recommended implementation

### 1. MagPi: expose native steering

Add a private, advertised operation, for example:

- Capability: `magpi-acp/non-destructive-steering`
- Request: `_magpi-acp/session/steer`
- Parameters: `sessionId` plus ACP content blocks or validated text/images
- Response: accepted/handled disposition

Add `steer(message, images)` and `clearQueue()` wrappers to `PiRpcProcess`. The steer request should call Pi's dedicated `steer` RPC operation, not abort and not MagPi's `turnQueue`.

Only accept steering while a Pi run is active. A request racing with `agent_settled` needs deterministic behavior: either reject it so Mischief leaves the message in its ordinary follow-up queue, or use Pi's `prompt` with `streamingBehavior: "steer"` and carefully test the idle transition. Dedicated `steer` is easier to reason about and intentionally rejects extension commands.

### 2. Mischief: capability-gate the action

Extend `AgentSessionOperations` and `AgentConnection` with optional steering support. `magpiAcpExtension` should decode the advertised capability and issue the private request.

For a supported MagPi Thread, the queue action should:

1. Ask MagPi to steer the selected content.
2. Remove it from Mischief's ordinary pending-turn queue only after MagPi accepts it.
3. **Not** call `session/cancel` and **not** later submit the same content through ordinary `session/prompt`.
4. Let MagPi's forwarded Pi `user_message_chunk` add the message to the transcript when Pi actually consumes it.

The existing MagPi message-identity collector spans the Pi run until `agent_settled` and already records multiple user/assistant message boundaries, so native steering should fit its correlation model. This still needs a regression test with one initial user message, one steered user message, and both assistant segments; message IDs must remain distinct and targetable.

For Agents without the capability, do not silently preserve the current misleading action. Either hide **Steer now**, or expose a distinct **Interrupt and send** action that states it cancels work.

### 3. Preserve stop-and-restore semantics

This is the main edge case. Today Mischief can restore locally queued messages as drafts because it still owns them. Once MagPi hands a message to Pi's steering queue, cancellation must account for Pi's queue too.

Pi provides `clear_queue`, returning removed steering/follow-up text, and recommends clearing before abort when a client wants Esc-style restoration. MagPi should use that primitive and surface enough information for Mischief to restore messages that Pi accepted but had not consumed. Text equality is not a safe long-term identity mechanism, especially for duplicate messages and images; the private request should carry a client message ID, and MagPi should track that ID until Pi's queue event/message start proves consumption.

Do not ship native steering without tests for:

- steer during assistant text generation;
- steer while a tool is running (delivery only after the tool boundary);
- duplicate steering texts and images;
- cancellation before and after the steered user message is consumed;
- race with `agent_settled`;
- removal from Mischief's local queue without a later duplicate prompt;
- message identity, fork, and rollback after a steered turn;
- unsupported Agents retaining ordinary queue behavior.

## Decision

Implement the private MagPi steering capability rather than changing all ACP prompts or waiting for ACP v2. Pi already supplies the hard behavior; the work is exposing it through MagPi and reconciling queue ownership in Mischief.

The implementation should keep two concepts explicit in the UI:

- **Steer now** — non-destructive, waits for Pi's next safe model boundary.
- **Interrupt and send** — destructive cancellation followed by a new turn, if retained at all.
