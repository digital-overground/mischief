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

  // oxlint-disable-next-line complexity -- fake protocol handles each command variant in one place.
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
        configOptions: [
          {
            currentValue: true,
            id: "thinking",
            name: "Thinking",
            type: "boolean",
          },
        ],
        id: THREAD_ID,
        sessionId: "session-1",
        workspace: "/work",
      });
    }
    if (action === "threadFork") {
      return await Promise.resolve({
        agentId: "codex-acp",
        id: fields?.forkId,
        operations: {
          branchSummary: false,
          forkMessage: true,
          treeNavigation: false,
        },
        sessionId: "fork-session",
        workspace: "/work",
      });
    }
    if (action === "agentHistory") {
      return await Promise.resolve([
        { cwd: "/work", sessionId: "old-session", title: "Previous" },
      ]);
    }
    if (action === "threadAdopt") {
      return await Promise.resolve({
        agentId: "codex-acp",
        id: fields?.threadId,
        sessionId: fields?.sessionId,
        workspace: "/work",
      });
    }
    if (action === "threadLoad") {
      const id = fields?.threadId;
      return await Promise.resolve({
        agentId: "codex-acp",
        id,
        sessionId: id === THREAD_ID ? "adopted-session" : "session-2",
        workspace: "/work",
      });
    }
    if (action === "threadTranscript") {
      return await Promise.resolve({
        cursor: fields?.cursor === undefined ? 1 : null,
        events: [
          {
            agentId: "codex-acp",
            sessionId: "adopted-session",
            threadId: fields?.threadId,
            type: "acpUpdate",
            update: {
              content: {
                text:
                  fields?.cursor === undefined
                    ? "Earlier answer"
                    : "Older answer",
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
          },
        ],
      });
    }
    if (action === "threadPrompt") {
      if (fields?.text === "image" && !Array.isArray(fields.images)) {
        throw new Error("Missing images");
      }
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
  test("dismisses an elicitation answered by another client without answering it again", async () => {
    const host = new FakeHost();
    const agentHandlers = handlers();
    let answer: (() => void) | undefined;
    vi.mocked(agentHandlers.elicitation).mockImplementation(
      async () =>
        // oxlint-disable-next-line promise/avoid-new -- hold the local UI until the remote completion arrives.
        await new Promise<{ action: "cancel" }>((resolve) => {
          answer = () => {
            resolve({ action: "cancel" });
          };
        })
    );
    const resolved = vi.fn<(id: string) => void>(() => {
      answer?.();
    });
    const connection = hostConnectionFactory(host)(
      { ...agentHandlers, interactionResolved: resolved },
      "codex-acp"
    );
    await connection.create("/work", THREAD_ID);
    host.emit({
      interactionId: "question-1",
      request: {
        message: "Choose",
        mode: "form",
        requestedSchema: { properties: {}, type: "object" },
        sessionId: "session-1",
      },
      threadId: THREAD_ID,
      type: "acpElicitation",
    });
    host.emit({
      interactionId: "question-1",
      threadId: THREAD_ID,
      type: "acpInteractionResolved",
    });
    await vi.waitFor(() => {
      expect(resolved).toHaveBeenCalledWith("question-1");
    });
    expect(
      host.requests.filter(({ action }) => action === "acpRespondElicitation")
    ).toStrictEqual([]);
    expect(agentHandlers.error).not.toHaveBeenCalled();
    connection.dispose();
  });

  test("does not restore an interaction completed before its Thread was attached", async () => {
    const host = new FakeHost();
    const factory = hostConnectionFactory(host);
    host.emit({
      interactionId: "old-question",
      request: {
        message: "Choose",
        mode: "form",
        requestedSchema: { properties: {}, type: "object" },
        sessionId: "session-1",
      },
      threadId: THREAD_ID,
      type: "acpElicitation",
    });
    host.emit({
      interactionId: "old-question",
      threadId: THREAD_ID,
      type: "acpInteractionResolved",
    });
    const agentHandlers = handlers();
    const connection = factory(agentHandlers, "codex-acp");
    await connection.create("/work", THREAD_ID);
    expect(agentHandlers.elicitation).not.toHaveBeenCalled();
    connection.dispose();
  });

  test("dismisses a permission answered elsewhere without sending a cancellation", async () => {
    const host = new FakeHost();
    const agentHandlers = handlers();
    let answer: (() => void) | undefined;
    vi.mocked(agentHandlers.permission).mockImplementation(
      async () =>
        // oxlint-disable-next-line promise/avoid-new -- the UI stays pending until another client resolves it.
        await new Promise<{ cancelled: true }>((resolve) => {
          answer = () => {
            resolve({ cancelled: true });
          };
        })
    );
    const resolved = vi.fn<(id: string) => void>(() => {
      answer?.();
    });
    const connection = hostConnectionFactory(host)(
      { ...agentHandlers, interactionResolved: resolved },
      "codex-acp"
    );
    await connection.create("/work", THREAD_ID);
    host.emit({
      interactionId: "permission-1",
      request: {
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId: "session-1",
        toolCall: { title: "Test", toolCallId: "tool-1" },
      },
      threadId: THREAD_ID,
      type: "acpPermission",
    });
    host.emit({
      interactionId: "permission-1",
      threadId: THREAD_ID,
      type: "acpInteractionResolved",
    });
    await vi.waitFor(() => {
      expect(resolved).toHaveBeenCalledWith("permission-1");
    });
    expect(
      host.requests.filter(({ action }) => action === "acpRespondPermission")
    ).toStrictEqual([]);
    expect(agentHandlers.error).not.toHaveBeenCalled();
    connection.dispose();
  });

  test("applies Host model and thinking snapshots to an attached Thread", async () => {
    const host = new FakeHost();
    const agentHandlers = handlers();
    const connection = hostConnectionFactory(host)(agentHandlers, "codex-acp");
    await connection.create("/work", THREAD_ID);
    const options = [
      {
        currentValue: "deep",
        id: "model",
        name: "Model",
        options: [{ name: "Deep", value: "deep" }],
        type: "select",
      },
      {
        currentValue: "high",
        id: "thinking",
        name: "Thinking",
        options: [{ name: "High", value: "high" }],
        type: "select",
      },
    ];
    host.emit({
      threads: [
        {
          agentId: "codex-acp",
          configOptions: options,
          id: THREAD_ID,
          sessionId: "session-1",
          workspace: "/work",
        },
      ],
      type: "threads",
    });
    expect(agentHandlers.update).toHaveBeenCalledWith({
      options,
      type: "config",
    });
    await connection.setConfig("session-1", "thinking", "low");
    expect(host.requests).toContainEqual({
      action: "threadSetConfig",
      fields: { configId: "thinking", threadId: THREAD_ID, value: "low" },
    });
    expect(agentHandlers.update).toHaveBeenLastCalledWith({
      options,
      type: "config",
    });
    connection.dispose();
  });

  test("creates, prompts, translates updates, and answers permissions", async () => {
    const host = new FakeHost();
    const agentHandlers = handlers();
    const connection = hostConnectionFactory(host)(agentHandlers, "codex-acp");

    await expect(connection.create("/work", THREAD_ID)).resolves.toStrictEqual({
      configOptions: [
        {
          currentValue: true,
          id: "thinking",
          name: "Thinking",
          type: "boolean",
        },
      ],
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
      Promise.all([
        connection.prompt("session-1", "image", [
          { data: "data", mimeType: "image/png" },
        ]),
        connection.setConfig("session-1", "model", "fast"),
        connection.authenticate?.("login"),
        connection.history("/work"),
      ])
    ).resolves.toStrictEqual([
      { stopReason: "completed" },
      undefined,
      undefined,
      [
        {
          cwd: "/work",
          owner: "host",
          sessionId: "old-session",
          title: "Previous",
        },
      ],
    ]);
  });

  test("forks a Host-owned Thread using the caller's canonical ID", async () => {
    const host = new FakeHost();
    const connection = hostConnectionFactory(host)(handlers(), "codex-acp", {
      owner: "host",
      threadId: THREAD_ID,
    });
    await connection.load("adopted-session", "/work");
    const forkId = "123e4567-e89b-4d3a-a456-426614174001";
    await expect(
      connection.forkMessage("adopted-session", "/work", "message-1", forkId)
    ).resolves.toMatchObject({
      operations: { forkMessage: true },
      sessionId: "fork-session",
    });
    expect(host.requests).toContainEqual({
      action: "threadFork",
      fields: { forkId, messageId: "message-1", threadId: THREAD_ID },
    });
  });

  test("publishes Host rename and removal snapshots to its client", () => {
    const host = new FakeHost();
    const metadata = vi.fn<NonNullable<AgentHandlers["metadata"]>>();
    const agentHandlers = { ...handlers(), metadata };
    const connection = hostConnectionFactory(host)(agentHandlers, "codex-acp", {
      owner: "host",
      threadId: THREAD_ID,
    });

    host.emit({
      name: "Renamed elsewhere",
      threadId: THREAD_ID,
      type: "threadRenamed",
    });
    host.emit({ threadId: THREAD_ID, type: "threadRemoved" });
    void connection.rename?.("Renamed");
    void connection.remove?.();

    expect(metadata).toHaveBeenNthCalledWith(1, {
      manualName: true,
      name: "Renamed elsewhere",
    });
    expect(metadata).toHaveBeenNthCalledWith(2, { removed: true });
    expect(host.requests).toContainEqual({
      action: "threadRename",
      fields: { name: "Renamed", threadId: THREAD_ID },
    });
    expect(host.requests).toContainEqual({
      action: "threadRemove",
      fields: { threadId: THREAD_ID },
    });
  });

  test("syncs Agent titles and manual rename state from Host snapshots", () => {
    const host = new FakeHost();
    const metadata = vi.fn<NonNullable<AgentHandlers["metadata"]>>();
    hostConnectionFactory(host)({ ...handlers(), metadata }, "magpi-acp", {
      owner: "host",
      threadId: THREAD_ID,
    });
    host.emit({
      threads: [
        {
          agentId: "magpi-acp",
          id: THREAD_ID,
          manualName: false,
          name: "Agent title",
          workspace: "/work",
        },
      ],
      type: "threads",
    });
    expect(metadata).toHaveBeenCalledWith({
      manualName: false,
      name: "Agent title",
    });
  });

  test("adopts Host history using the canonical VS Code Thread ID", async () => {
    const host = new FakeHost();
    const connection = hostConnectionFactory(host)(handlers(), "codex-acp", {
      owner: "host",
      threadId: THREAD_ID,
    });

    await expect(
      connection.load("adopted-session", "/work")
    ).resolves.toMatchObject({ sessionId: "adopted-session" });
    expect(host.requests).toContainEqual({
      action: "threadAdopt",
      fields: {
        agentId: "codex-acp",
        cwd: "/work",
        sessionId: "adopted-session",
        threadId: THREAD_ID,
      },
    });
  });

  test("replays the Host transcript when loading an already-owned Thread", async () => {
    const host = new FakeHost();
    const factory = hostConnectionFactory(host);
    host.emit({
      threads: [
        {
          agentId: "codex-acp",
          id: THREAD_ID,
          sessionId: "adopted-session",
          workspace: "/work",
        },
      ],
      type: "threads",
    });
    const agentHandlers = handlers();
    const connection = factory(agentHandlers, "codex-acp", {
      threadId: THREAD_ID,
    });

    await connection.load("adopted-session", "/work");

    expect(host.requests).toContainEqual({
      action: "threadTranscript",
      fields: { threadId: THREAD_ID },
    });
    expect(agentHandlers.update).toHaveBeenCalledWith({
      kind: "assistant",
      text: "Earlier answer",
      type: "message",
    });
    expect(connection.hasOlder?.()).toBeTruthy();
    await expect(connection.older?.()).resolves.toStrictEqual({
      hasOlder: false,
      updates: [{ kind: "assistant", text: "Older answer", type: "message" }],
    });
    expect({
      hasOlder: connection.hasOlder?.(),
      request: host.requests.at(-1),
    }).toStrictEqual({
      hasOlder: false,
      request: {
        action: "threadTranscript",
        fields: { cursor: 1, threadId: THREAD_ID },
      },
    });
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
