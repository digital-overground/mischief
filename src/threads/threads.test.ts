import { RequestError } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import {
  Threads,
  type AgentConnection,
  type AgentConnectionFactory,
  type AgentHandlers,
  type ThreadsStorage,
} from "./threads";

test("a user-renamed Thread ignores later automatic titles", async () => {
  const threads = new Threads(new MemoryStorage(), new FakeAgent().factory);
  await threads.openWorkspace("/workspace");
  await threads.prompt("Name me");
  const id = threads.snapshot().selected?.id;

  await threads.rename(id ?? "", "My Thread");
  await threads.prompt("Keep the name");

  expect(threads.snapshot().selected?.name).toBe("My Thread");
});

test("closing a Workspace cancels its running Threads and hides them", async () => {
  const agent = new FakeAgent();
  agent.holdPrompts = true;
  const threads = new Threads(new MemoryStorage(), agent.factory);
  await threads.openWorkspace("/workspace");
  const prompting = threads.prompt("Keep running");
  await agent.firstPromptStarted;

  await threads.closeWorkspace();
  await prompting;

  expect(threads.snapshot()).toEqual({ threads: [] });
});

test("Threads stay newest-first and restore the last selection", async () => {
  const storage = new MemoryStorage();
  const threads = new Threads(storage, new FakeAgent().factory);
  await threads.openWorkspace("/workspace");
  await threads.prompt("First");
  const firstId = threads.snapshot().selected?.id;
  threads.newThread();
  await threads.prompt("Second");
  const secondId = threads.snapshot().selected?.id;

  expect(threads.snapshot().threads.map((thread) => thread.id)).toEqual([secondId, firstId]);
  await threads.select(firstId ?? "");

  const restored = new Threads(storage, new FakeAgent().factory);
  await restored.openWorkspace("/workspace");
  expect(restored.snapshot().selected?.id).toBe(firstId);

  await restored.remove(firstId ?? "");
  expect(restored.snapshot()).toMatchObject({
    threads: [{ id: secondId }],
    selected: { id: secondId },
  });
});

test("authentication failures expose the Agent terminal login", async () => {
  const agent = new FakeAgent();
  agent.createError = RequestError.authRequired({
    authMethods: [
      {
        id: "pi",
        name: "Launch Pi",
        description: "Configure Pi",
        type: "terminal",
        args: ["--terminal-login"],
        env: {},
        _meta: {
          "terminal-auth": {
            command: "node",
            args: ["/magpi/index.js", "--terminal-login"],
            label: "Launch Pi",
          },
        },
      },
    ],
  });
  const threads = new Threads(new MemoryStorage(), agent.factory);
  await threads.openWorkspace("/workspace");

  await threads.prompt("Hello");

  expect(threads.snapshot().selected).toMatchObject({
    status: "error",
    authentication: {
      command: "node",
      args: ["/magpi/index.js", "--terminal-login"],
      label: "Launch Pi",
    },
  });
});

test("an empty New Thread is not durable", async () => {
  const storage = new MemoryStorage();
  const threads = new Threads(storage, new FakeAgent().factory);
  await threads.openWorkspace("/workspace");
  await threads.prompt("Keep me");

  threads.newThread();

  expect(threads.snapshot()).toMatchObject({
    threads: [{}],
    selected: { id: null, name: "New Thread" },
  });
  const restored = new Threads(storage, new FakeAgent().factory);
  await restored.openWorkspace("/workspace");
  expect(restored.snapshot().selected?.id).not.toBeNull();
});

test("stopping a running Thread preserves output and restores queued prompts as drafts", async () => {
  const agent = new FakeAgent();
  agent.holdPrompts = true;
  const threads = new Threads(new MemoryStorage(), agent.factory);
  await threads.openWorkspace("/workspace");

  const first = threads.prompt("First");
  await agent.firstPromptStarted;
  const second = threads.prompt("Second");
  await agent.secondPromptStarted;

  expect(threads.snapshot().selected).toMatchObject({
    status: "running",
    items: [
      { kind: "user", text: "First" },
      { kind: "assistant", text: "Partial" },
      { kind: "user", text: "Second", queued: 1 },
    ],
  });

  await threads.cancel();
  await Promise.all([first, second]);

  expect(threads.snapshot().selected).toMatchObject({
    status: "idle",
    drafts: ["Second"],
    items: [
      { kind: "user", text: "First", cancelled: true },
      { kind: "assistant", text: "Partial" },
    ],
  });
});

test("ACP thoughts, tools, plans, and configuration update the Thread", async () => {
  const agent = new FakeAgent();
  agent.richUpdates = true;
  const threads = new Threads(new MemoryStorage(), agent.factory);
  await threads.openWorkspace("/workspace");

  await threads.prompt("Inspect it");
  await threads.setConfig("thinking", "high");

  expect(agent.configChange).toEqual({
    sessionId: "session-1",
    configId: "thinking",
    value: "high",
  });
  expect(threads.snapshot().selected).toMatchObject({
    items: [
      { kind: "user", text: "Inspect it" },
      { kind: "thought", text: "Checking…" },
      {
        kind: "tool",
        title: "Read file",
        status: "completed",
        input: '{\n  "path": "src/a.ts"\n}',
        output: "contents",
        locations: [{ path: "/workspace/src/a.ts", line: 2 }],
        diffs: [{ path: "/workspace/src/a.ts", oldText: "old", newText: "new" }],
      },
      { kind: "plan", text: "✓ Inspect\n• Fix" },
      { kind: "assistant", text: "Done." },
    ],
    configOptions: [{ id: "thinking", currentValue: "high" }],
  });
});

test("elicitation forms wait for an inline Thread response", async () => {
  const agent = new FakeAgent();
  agent.askElicitation = true;
  const threads = new Threads(new MemoryStorage(), agent.factory);
  await threads.openWorkspace("/workspace");

  const prompting = threads.prompt("Choose a path");
  await agent.elicitationStarted;

  const interaction = threads.snapshot().selected?.interaction;
  expect(interaction).toMatchObject({
    kind: "elicitation",
    message: "Pick one",
    fields: [
      {
        name: "choice",
        label: "Choice",
        type: "select",
        options: [{ value: "a", name: "Option A" }],
      },
    ],
  });
  await threads.respond(interaction?.id ?? "", {
    action: "accept",
    values: { choice: "a" },
  });
  await prompting;

  expect(agent.elicitationResponse).toEqual({
    action: "accept",
    content: { choice: "a" },
  });
});

test("permission requests wait for an inline Thread response", async () => {
  const agent = new FakeAgent();
  agent.askPermission = true;
  const threads = new Threads(new MemoryStorage(), agent.factory);
  await threads.openWorkspace("/workspace");

  const prompting = threads.prompt("Run the tests");
  await agent.permissionStarted;

  const interaction = threads.snapshot().selected?.interaction;
  expect(threads.snapshot().selected).toMatchObject({
    status: "waiting",
    interaction: {
      kind: "permission",
      message: "Run tests?",
      options: [{ id: "yes", name: "Yes" }],
    },
  });
  await threads.respond(interaction?.id ?? "", { action: "select", optionId: "yes" });
  await prompting;

  expect(agent.permissionResponse).toEqual({
    outcome: { outcome: "selected", optionId: "yes" },
  });
  expect(threads.snapshot().selected?.status).toBe("idle");
});

test("opening a durable Thread restores its transcript from ACP", async () => {
  const storage = new MemoryStorage();
  const original = new Threads(storage, new FakeAgent().factory);
  await original.openWorkspace("/workspace");
  await original.prompt("Restore me");

  const loadingAgent = new FakeAgent();
  loadingAgent.replayOnLoad = true;
  const restored = new Threads(storage, loadingAgent.factory);
  await restored.openWorkspace("/workspace");

  expect(restored.snapshot().selected?.items).toMatchObject([
    { kind: "user", text: "Restore me" },
    { kind: "assistant", text: "Restored." },
  ]);
});

test("a failed first prompt remains durable and can be retried", async () => {
  const storage = new MemoryStorage();
  const failingAgent = new FakeAgent();
  failingAgent.failCreate = true;
  const threads = new Threads(storage, failingAgent.factory);
  await threads.openWorkspace("/workspace");

  await threads.prompt("Try again");

  expect(threads.snapshot()).toMatchObject({
    threads: [{ status: "error" }],
    selected: { status: "error", error: "Agent unavailable" },
  });

  const recovered = new Threads(storage, new FakeAgent().factory);
  await recovered.openWorkspace("/workspace");
  await recovered.retry();

  expect(recovered.snapshot().selected).toMatchObject({
    status: "idle",
    items: [
      { kind: "user", text: "Try again" },
      { kind: "assistant", text: "Done." },
    ],
  });
});

test("the first prompt registers a Thread and streams its transcript", async () => {
  const storage = new MemoryStorage();
  const agent = new FakeAgent();
  const threads = new Threads(storage, agent.factory);
  await threads.openWorkspace("/workspace");

  await threads.prompt("Fix the tests");

  expect(threads.snapshot()).toMatchObject({
    workspace: "/workspace",
    threads: [{ name: "Fix tests", status: "idle" }],
    selected: {
      name: "Fix tests",
      status: "idle",
      items: [
        { kind: "user", text: "Fix the tests" },
        { kind: "assistant", text: "Done." },
      ],
    },
  });
});

class FakeAgent {
  failCreate = false;
  createError?: Error;
  replayOnLoad = false;
  askPermission = false;
  askElicitation = false;
  richUpdates = false;
  holdPrompts = false;
  permissionResponse?: unknown;
  elicitationResponse?: unknown;
  configChange?: { sessionId: string; configId: string; value: string | boolean };
  private permissionStartedResolve?: () => void;
  private elicitationStartedResolve?: () => void;
  private firstPromptStartedResolve?: () => void;
  private secondPromptStartedResolve?: () => void;
  readonly promptResolvers: Array<(response: { stopReason: "cancelled" }) => void> = [];
  readonly permissionStarted = new Promise<void>((resolve) => {
    this.permissionStartedResolve = resolve;
  });
  readonly elicitationStarted = new Promise<void>((resolve) => {
    this.elicitationStartedResolve = resolve;
  });
  readonly firstPromptStarted = new Promise<void>((resolve) => {
    this.firstPromptStartedResolve = resolve;
  });
  readonly secondPromptStarted = new Promise<void>((resolve) => {
    this.secondPromptStartedResolve = resolve;
  });
  readonly factory: AgentConnectionFactory = (handlers) => new FakeConnection(this, handlers);

  markPermissionStarted(): void {
    this.permissionStartedResolve?.();
  }

  markElicitationStarted(): void {
    this.elicitationStartedResolve?.();
  }

  markPromptStarted(count: number): void {
    if (count === 1) this.firstPromptStartedResolve?.();
    if (count === 2) this.secondPromptStartedResolve?.();
  }
}

class FakeConnection implements AgentConnection {
  constructor(
    private readonly agent: FakeAgent,
    private readonly handlers: AgentHandlers,
  ) {}

  async create(): Promise<{ sessionId: string }> {
    if (this.agent.createError) throw this.agent.createError;
    if (this.agent.failCreate) throw new Error("Agent unavailable");
    return { sessionId: "session-1" };
  }

  async load(): Promise<{}> {
    if (this.agent.replayOnLoad) {
      this.handlers.update({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "Restore me" },
      });
      this.handlers.update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Restored." },
      });
    }
    return {};
  }

  async prompt(): Promise<{ stopReason: "end_turn" | "cancelled" }> {
    if (this.agent.holdPrompts) {
      const count = this.agent.promptResolvers.length + 1;
      if (count === 1) {
        this.handlers.update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Partial" },
        });
      }
      const result = new Promise<{ stopReason: "cancelled" }>((resolve) => {
        this.agent.promptResolvers.push(resolve);
      });
      this.agent.markPromptStarted(count);
      return result;
    }
    if (this.agent.richUpdates) {
      this.handlers.update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Checking…" },
      });
      this.handlers.update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "src/a.ts" },
        locations: [{ path: "/workspace/src/a.ts", line: 2 }],
        content: [
          {
            type: "diff",
            path: "/workspace/src/a.ts",
            oldText: "old",
            newText: "new",
          },
        ],
      });
      this.handlers.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: "contents",
      });
      this.handlers.update({
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect", priority: "high", status: "completed" },
          { content: "Fix", priority: "medium", status: "pending" },
        ],
      });
      this.handlers.update({
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            type: "select",
            id: "thinking",
            name: "Thinking",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
          },
        ],
      });
    }
    if (this.agent.askElicitation) {
      const response = this.handlers.elicitation({
        sessionId: "session-1",
        mode: "form",
        message: "Pick one",
        requestedSchema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              title: "Choice",
              oneOf: [{ const: "a", title: "Option A" }],
            },
          },
          required: ["choice"],
        },
      });
      this.agent.markElicitationStarted();
      this.agent.elicitationResponse = await response;
    }
    if (this.agent.askPermission) {
      const response = this.handlers.permission({
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          title: "Run tests?",
          status: "pending",
        },
        options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
      });
      this.agent.markPermissionStarted();
      this.agent.permissionResponse = await response;
    }
    this.handlers.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Done." },
    });
    this.handlers.update({
      sessionUpdate: "session_info_update",
      title: "Fix tests",
    });
    return { stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {
    for (const resolve of this.agent.promptResolvers.splice(0)) {
      resolve({ stopReason: "cancelled" });
    }
  }

  async setConfig(sessionId: string, configId: string, value: string | boolean): Promise<void> {
    this.agent.configChange = { sessionId, configId, value };
  }

  dispose(): void {}
}

class MemoryStorage implements ThreadsStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}
