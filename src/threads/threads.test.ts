import { RequestError } from "@agentclientprotocol/sdk";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import { Threads } from "./threads";
import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentHandlers,
  ThreadsStorage,
} from "./threads";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolver: (() => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => resolver?.(),
  };
};

const memoryStorage = (): ThreadsStorage => {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback: T): T =>
      (values.get(key) as T | undefined) ?? fallback,
    update: (key: string, value: unknown): Promise<void> => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
};

class FakeAgent {
  createCalls = 0;
  initialConfigOptions: SessionConfigOption[] = [];
  failCreate = false;
  createError?: Error;
  replayOnLoad = false;
  askPermission = false;
  askElicitation = false;
  richUpdates = false;
  holdPrompts = false;
  permissionResponse?: unknown;
  elicitationResponse?: unknown;
  configChange?: {
    sessionId: string;
    configId: string;
    value: string | boolean;
  };
  disposed = false;
  private readonly permissionStartedDeferred = deferred();
  private readonly elicitationStartedDeferred = deferred();
  private readonly firstPromptStartedDeferred = deferred();
  private readonly secondPromptStartedDeferred = deferred();
  readonly promptResolvers: ((response: {
    stopReason: "cancelled";
  }) => void)[] = [];
  readonly permissionStarted = this.permissionStartedDeferred.promise;
  readonly elicitationStarted = this.elicitationStartedDeferred.promise;
  readonly firstPromptStarted = this.firstPromptStartedDeferred.promise;
  readonly secondPromptStarted = this.secondPromptStartedDeferred.promise;
  readonly factory: AgentConnectionFactory = (handlers) =>
    this.connection(handlers);

  markPermissionStarted(): void {
    this.permissionStartedDeferred.resolve();
  }

  markElicitationStarted(): void {
    this.elicitationStartedDeferred.resolve();
  }

  markPromptStarted(count: number): void {
    if (count === 1) {
      this.firstPromptStartedDeferred.resolve();
    }
    if (count === 2) {
      this.secondPromptStartedDeferred.resolve();
    }
  }

  private connection(handlers: AgentHandlers): AgentConnection {
    return {
      cancel: () => {
        for (const resolve of this.promptResolvers.splice(0)) {
          resolve({ stopReason: "cancelled" });
        }
        return Promise.resolve();
      },
      create: () => {
        this.createCalls += 1;
        if (this.createError) {
          throw this.createError;
        }
        if (this.failCreate) {
          throw new Error("Agent unavailable");
        }
        return Promise.resolve({
          configOptions: this.initialConfigOptions,
          sessionId: "session-1",
        });
      },
      dispose: () => {
        this.disposed = true;
      },
      load: () => {
        if (this.replayOnLoad) {
          handlers.update({
            content: { text: "Restore me", type: "text" },
            sessionUpdate: "user_message_chunk",
          });
          handlers.update({
            content: { text: "Restored.", type: "text" },
            sessionUpdate: "agent_message_chunk",
          });
        }
        return Promise.resolve({});
      },
      prompt: async () => {
        if (this.holdPrompts) {
          const count = this.promptResolvers.length + 1;
          if (count === 1) {
            handlers.update({
              content: { text: "Partial", type: "text" },
              sessionUpdate: "agent_message_chunk",
            });
          }
          // oxlint-disable-next-line promise/avoid-new
          const result = new Promise<{ stopReason: "cancelled" }>((resolve) => {
            this.promptResolvers.push(resolve);
          });
          this.markPromptStarted(count);
          return result;
        }
        if (this.richUpdates) {
          handlers.update({
            content: { text: "Checking…", type: "text" },
            sessionUpdate: "agent_thought_chunk",
          });
          handlers.update({
            content: [
              {
                newText: "new",
                oldText: "old",
                path: "/workspace/src/a.ts",
                type: "diff",
              },
            ],
            kind: "read",
            locations: [{ line: 2, path: "/workspace/src/a.ts" }],
            rawInput: { path: "src/a.ts" },
            sessionUpdate: "tool_call",
            status: "in_progress",
            title: "Read file",
            toolCallId: "tool-1",
          });
          handlers.update({
            rawOutput: "contents",
            sessionUpdate: "tool_call_update",
            status: "completed",
            toolCallId: "tool-1",
          });
          handlers.update({
            entries: [
              { content: "Inspect", priority: "high", status: "completed" },
              { content: "Fix", priority: "medium", status: "pending" },
            ],
            sessionUpdate: "plan",
          });
          handlers.update({
            configOptions: [
              {
                currentValue: "high",
                id: "thinking",
                name: "Thinking",
                options: [{ name: "High", value: "high" }],
                type: "select",
              },
            ],
            sessionUpdate: "config_option_update",
          });
        }
        if (this.askElicitation) {
          const response = handlers.elicitation({
            message: "Pick one",
            mode: "form",
            requestedSchema: {
              properties: {
                choice: {
                  oneOf: [{ const: "a", title: "Option A" }],
                  title: "Choice",
                  type: "string",
                },
              },
              required: ["choice"],
              type: "object",
            },
            sessionId: "session-1",
          });
          this.markElicitationStarted();
          this.elicitationResponse = await response;
        }
        if (this.askPermission) {
          const response = handlers.permission({
            options: [{ kind: "allow_once", name: "Yes", optionId: "yes" }],
            sessionId: "session-1",
            toolCall: {
              status: "pending",
              title: "Run tests?",
              toolCallId: "tool-1",
            },
          });
          this.markPermissionStarted();
          this.permissionResponse = await response;
        }
        handlers.update({
          content: { text: "Done.", type: "text" },
          sessionUpdate: "agent_message_chunk",
        });
        handlers.update({
          sessionUpdate: "session_info_update",
          title: "Fix tests",
        });
        return { stopReason: "end_turn" };
      },
      setConfig: (sessionId, configId, value) => {
        this.configChange = { configId, sessionId, value };
        return Promise.resolve();
      },
    };
  }
}

describe("threads module", () => {
  test("a user-renamed Thread ignores later automatic titles", async () => {
    const threads = new Threads(memoryStorage(), new FakeAgent().factory);
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
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");
    const prompting = threads.prompt("Keep running");
    await agent.firstPromptStarted;

    await threads.closeWorkspace();
    await prompting;

    expect(threads.snapshot()).toStrictEqual({ threads: [] });
  });

  test("Threads stay newest-first and restore the last selection", async () => {
    const storage = memoryStorage();
    const threads = new Threads(storage, new FakeAgent().factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("First");
    const firstId = threads.snapshot().selected?.id;
    await threads.newThread();
    await threads.prompt("Second");
    const secondId = threads.snapshot().selected?.id;

    expect(threads.snapshot().threads.map((thread) => thread.id)).toStrictEqual(
      [secondId, firstId]
    );
    await threads.select(firstId ?? "");

    const restored = new Threads(storage, new FakeAgent().factory);
    await restored.openWorkspace("/workspace");
    expect(restored.snapshot().selected?.id).toBe(firstId);

    await restored.remove(firstId ?? "");
    expect(restored.snapshot()).toMatchObject({
      selected: { id: secondId },
      threads: [{ id: secondId }],
    });
  });

  test("authentication failures expose the Agent terminal login", async () => {
    const agent = new FakeAgent();
    agent.createError = RequestError.authRequired({
      authMethods: [
        {
          _meta: {
            "terminal-auth": {
              args: ["/magpi/index.js", "--terminal-login"],
              command: "node",
              label: "Launch Pi",
            },
          },
          args: ["--terminal-login"],
          description: "Configure Pi",
          env: {},
          id: "pi",
          name: "Launch Pi",
          type: "terminal",
        },
      ],
    });
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    await threads.prompt("Hello");

    expect(threads.snapshot().selected).toMatchObject({
      authentication: {
        args: ["/magpi/index.js", "--terminal-login"],
        command: "node",
        label: "Launch Pi",
      },
      status: "error",
    });
  });

  test("new Threads start the Agent and expose its configuration", async () => {
    const agent = new FakeAgent();
    agent.initialConfigOptions = [
      {
        currentValue: "high",
        id: "thinking",
        name: "Thinking",
        options: [{ name: "High", value: "high" }],
        type: "select",
      },
    ];
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    await threads.newThread();

    expect(agent.createCalls).toBe(1);
    expect(threads.snapshot().selected).toMatchObject({
      configOptions: [{ currentValue: "high", id: "thinking" }],
      id: expect.any(String),
      status: "idle",
    });
  });

  test("new empty Threads are durable and can be added repeatedly", async () => {
    const storage = memoryStorage();
    const threads = new Threads(storage, new FakeAgent().factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Keep me");

    await threads.newThread();
    const firstId = threads.snapshot().selected?.id;
    await threads.newThread();
    const secondId = threads.snapshot().selected?.id;

    expect(threads.snapshot()).toMatchObject({
      selected: { id: secondId, name: "New Thread", status: "idle" },
      threads: [
        { id: secondId, name: "New Thread" },
        { id: firstId, name: "New Thread" },
        { name: "Fix tests" },
      ],
    });
    const restored = new Threads(storage, new FakeAgent().factory);
    await restored.openWorkspace("/workspace");
    expect(restored.snapshot().selected?.id).toBe(secondId);
  });

  test("stopping a running Thread preserves output and restores queued prompts as drafts", async () => {
    const agent = new FakeAgent();
    agent.holdPrompts = true;
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    const first = threads.prompt("First");
    expect(threads.snapshot().selected).toMatchObject({
      status: "running",
      streaming: false,
    });
    await agent.firstPromptStarted;
    expect(threads.snapshot().selected?.streaming).toBeTruthy();
    const second = threads.prompt("Second");
    await agent.secondPromptStarted;

    expect(threads.snapshot().selected).toMatchObject({
      items: [
        { kind: "user", text: "First" },
        { kind: "assistant", text: "Partial" },
        { kind: "user", queued: 1, text: "Second" },
      ],
      status: "running",
    });

    await threads.cancel();
    await Promise.all([first, second]);

    expect(threads.snapshot().selected).toMatchObject({
      drafts: ["Second"],
      items: [
        { cancelled: true, kind: "user", text: "First" },
        { kind: "assistant", text: "Partial" },
      ],
      status: "idle",
      streaming: false,
    });
  });

  test("ACP thoughts, tools, plans, and configuration update the Thread", async () => {
    const agent = new FakeAgent();
    agent.richUpdates = true;
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    await threads.prompt("Inspect it");
    await threads.setConfig("thinking", "high");

    expect(agent.configChange).toStrictEqual({
      configId: "thinking",
      sessionId: "session-1",
      value: "high",
    });
    expect(threads.snapshot().selected).toMatchObject({
      configOptions: [{ currentValue: "high", id: "thinking" }],
      items: [
        { kind: "user", text: "Inspect it" },
        { kind: "thought", text: "Checking…" },
        {
          diffs: [
            { newText: "new", oldText: "old", path: "/workspace/src/a.ts" },
          ],
          input: '{\n  "path": "src/a.ts"\n}',
          kind: "tool",
          locations: [{ line: 2, path: "/workspace/src/a.ts" }],
          output: "contents",
          status: "completed",
          title: "Read file",
        },
        { kind: "plan", text: "✓ Inspect\n• Fix" },
        { kind: "assistant", text: "Done." },
      ],
    });
  });

  test("elicitation forms wait for an inline Thread response", async () => {
    const agent = new FakeAgent();
    agent.askElicitation = true;
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    const prompting = threads.prompt("Choose a path");
    await agent.elicitationStarted;

    const interaction = threads.snapshot().selected?.interaction;
    expect(interaction).toMatchObject({
      fields: [
        {
          label: "Choice",
          name: "choice",
          options: [{ name: "Option A", value: "a" }],
          type: "select",
        },
      ],
      kind: "elicitation",
      message: "Pick one",
    });
    threads.respond(interaction?.id ?? "", {
      action: "accept",
      values: { choice: "a" },
    });
    await prompting;

    expect(agent.elicitationResponse).toStrictEqual({
      action: "accept",
      content: { choice: "a" },
    });
  });

  test("permission requests wait for an inline Thread response", async () => {
    const agent = new FakeAgent();
    agent.askPermission = true;
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    const prompting = threads.prompt("Run the tests");
    await agent.permissionStarted;

    const interaction = threads.snapshot().selected?.interaction;
    expect(threads.snapshot().selected).toMatchObject({
      interaction: {
        kind: "permission",
        message: "Run tests?",
        options: [{ id: "yes", name: "Yes" }],
      },
      status: "waiting",
    });
    threads.respond(interaction?.id ?? "", {
      action: "select",
      optionId: "yes",
    });
    await prompting;

    expect(agent.permissionResponse).toStrictEqual({
      outcome: { optionId: "yes", outcome: "selected" },
    });
    expect(threads.snapshot().selected?.status).toBe("idle");
  });

  test("opening a durable Thread restores its transcript from ACP", async () => {
    const storage = memoryStorage();
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
    const storage = memoryStorage();
    const failingAgent = new FakeAgent();
    failingAgent.failCreate = true;
    const threads = new Threads(storage, failingAgent.factory);
    await threads.openWorkspace("/workspace");

    await threads.prompt("Try again");

    expect(threads.snapshot()).toMatchObject({
      selected: { error: "Agent unavailable", status: "error" },
      threads: [{ status: "error" }],
    });

    const recovered = new Threads(storage, new FakeAgent().factory);
    await recovered.openWorkspace("/workspace");
    await recovered.retry();

    expect(recovered.snapshot().selected).toMatchObject({
      items: [
        { kind: "user", text: "Try again" },
        { kind: "assistant", text: "Done." },
      ],
      status: "idle",
    });
  });

  test("the first prompt registers a Thread and streams its transcript", async () => {
    const storage = memoryStorage();
    const agent = new FakeAgent();
    const threads = new Threads(storage, agent.factory);
    await threads.openWorkspace("/workspace");

    await threads.prompt("Fix the tests");

    expect(threads.snapshot()).toMatchObject({
      selected: {
        items: [
          { kind: "user", text: "Fix the tests" },
          { kind: "assistant", text: "Done." },
        ],
        name: "Fix tests",
        status: "idle",
      },
      threads: [{ name: "Fix tests", status: "idle" }],
      workspace: "/workspace",
    });
  });
});
