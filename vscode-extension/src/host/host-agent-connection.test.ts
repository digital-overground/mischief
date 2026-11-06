import { describe, expect, test, vi } from "vitest";

import type { AgentHandlers } from "../threads/model";
import { hostConnectionFactory } from "./host-agent-connection";
import type { HostEvent } from "./host-client";

const THREAD_ID = "123e4567-e89b-4d3a-a456-426614174000";

class FakeHost {
  readonly requests: { action: string; fields?: Record<string, unknown> }[] =
    [];
  private listener?: (event: HostEvent) => void;

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: HostEvent): void {
    this.listener?.(event);
  }

  async request(
    action: string,
    fields?: Record<string, unknown>
  ): Promise<unknown> {
    this.requests.push({ action, ...(fields === undefined ? {} : { fields }) });
    if (action === "threadCreate") {
      if (fields?.threadId !== THREAD_ID) {
        throw new Error("Missing canonical Thread ID");
      }
      return await Promise.resolve({
        agentId: "codex-acp",
        id: THREAD_ID,
        sessionId: "session-1",
        workspace: "/work",
      });
    }
    if (action === "threadLoad") {
      return await Promise.resolve({
        agentId: "codex-acp",
        id: "thread-2",
        sessionId: "session-2",
        workspace: "/work",
      });
    }
    if (action === "threadPrompt") {
      this.emit({
        promptId: "prompt-1",
        stopReason: "completed",
        threadId: THREAD_ID,
        type: "threadPromptComplete",
      });
      return await Promise.resolve({ position: 1, promptId: "prompt-1" });
    }
    return await Promise.resolve({});
  }
}

const handlers = (): AgentHandlers => ({
  elicitation: vi.fn<AgentHandlers["elicitation"]>(
    async () => await Promise.resolve({ action: "cancel" })
  ),
  error: vi.fn<AgentHandlers["error"]>(),
  permission: vi.fn<AgentHandlers["permission"]>(
    async () => await Promise.resolve({ optionId: "allow-once" })
  ),
  update: vi.fn<AgentHandlers["update"]>(),
});

describe("Host Agent connection", () => {
  test("creates, prompts, translates updates, and answers permissions", async () => {
    const host = new FakeHost();
    const agentHandlers = handlers();
    const connection = hostConnectionFactory(host)(agentHandlers, "codex-acp");

    await expect(connection.create("/work", THREAD_ID)).resolves.toStrictEqual({
      configOptions: [],
      operations: {
        branchSummary: false,
        forkMessage: false,
        treeNavigation: false,
      },
      sessionId: "session-1",
    });
    await expect(
      connection.prompt("session-1", "hello", [])
    ).resolves.toStrictEqual({ stopReason: "completed" });

    host.emit({
      agentId: "codex-acp",
      sessionId: "session-1",
      threadId: THREAD_ID,
      type: "acpUpdate",
      update: {
        content: { text: "answer", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
    expect(agentHandlers.update).toHaveBeenCalledWith({
      kind: "assistant",
      text: "answer",
      type: "message",
    });

    host.emit({
      agentId: "codex-acp",
      interactionId: "permission-1",
      request: {
        options: [
          {
            kind: "allow_once",
            name: "Allow once",
            optionId: "allow-once",
          },
        ],
        sessionId: "session-1",
        toolCall: { title: "Run command", toolCallId: "tool-1" },
      },
      type: "acpPermission",
    });
    await vi.waitFor(() => {
      expect(host.requests).toContainEqual({
        action: "acpRespondPermission",
        fields: {
          interactionId: "permission-1",
          response: {
            outcome: { optionId: "allow-once", outcome: "selected" },
          },
        },
      });
    });
    await expect(
      connection.prompt("session-1", "image", [
        { data: "data", mimeType: "image/png" },
      ])
    ).rejects.toThrow("image prompts");
  });

  test("loads only Threads present in the Host snapshot", async () => {
    const host = new FakeHost();
    const factory = hostConnectionFactory(host);
    host.emit({
      threads: [
        {
          agentId: "codex-acp",
          id: "thread-2",
          sessionId: "session-2",
          workspace: "/work",
        },
      ],
      type: "threads",
    });
    host.emit({
      agentId: "codex-acp",
      interactionId: "replayed-permission",
      request: {
        options: [
          {
            kind: "allow_once",
            name: "Allow once",
            optionId: "allow-once",
          },
        ],
        sessionId: "session-2",
        toolCall: { title: "Run command", toolCallId: "tool-2" },
      },
      type: "acpPermission",
    });
    const connection = factory(handlers(), "codex-acp");

    await expect(connection.load("session-2", "/work")).resolves.toMatchObject({
      sessionId: "session-2",
    });
    await expect(connection.load("unknown", "/work")).rejects.toThrow(
      "not owned"
    );
    await vi.waitFor(() => {
      expect(host.requests).toContainEqual({
        action: "acpRespondPermission",
        fields: {
          interactionId: "replayed-permission",
          response: {
            outcome: { optionId: "allow-once", outcome: "selected" },
          },
        },
      });
    });
  });
});
