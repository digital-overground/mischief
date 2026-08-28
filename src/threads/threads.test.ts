import { describe, expect, test } from "vitest";

import { Threads } from "./threads";
import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentHandlers,
  AgentPromptResult,
  PromptImage,
  ThreadConfigOption,
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
  initialConfigOptions: ThreadConfigOption[] = [];
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
  readonly promptResolvers: ((response: AgentPromptResult) => void)[] = [];
  promptImages: PromptImage[] = [];
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
            kind: "user",
            text: "Restore me",
            type: "message",
          });
          handlers.update({
            kind: "assistant",
            text: "Restored.",
            type: "message",
          });
        }
        return Promise.resolve({ configOptions: [], sessionId: "session-1" });
      },
      prompt: async (_sessionId, _text, _messageId, images) => {
        this.promptImages = images;
        if (this.holdPrompts) {
          const count = this.promptResolvers.length + 1;
          if (count === 1) {
            handlers.update({
              kind: "assistant",
              text: "Partial",
              type: "message",
            });
          }
          // oxlint-disable-next-line promise/avoid-new
          const result = new Promise<AgentPromptResult>((resolve) => {
            this.promptResolvers.push(resolve);
          });
          this.markPromptStarted(count);
          return result;
        }
        if (this.richUpdates) {
          handlers.update({
            kind: "thought",
            text: "Checking…",
            type: "message",
          });
          handlers.update({
            diffs: [
              {
                newText: "new",
                oldText: "old",
                path: "/workspace/src/a.ts",
              },
            ],
            input: '{\n  "path": "src/a.ts"\n}',
            locations: [{ line: 2, path: "/workspace/src/a.ts" }],
            status: "in_progress",
            title: "Read file",
            toolCallId: "tool-1",
            type: "tool",
          });
          handlers.update({
            output: "contents",
            status: "completed",
            toolCallId: "tool-1",
            type: "tool",
          });
          handlers.update({ text: "✓ Inspect\n• Fix", type: "plan" });
          handlers.update({
            type: "usage",
            usage: { size: 245_000, used: 125_000 },
          });
          handlers.update({
            options: [
              {
                currentValue: "high",
                id: "thinking",
                name: "Thinking",
                options: [{ name: "High", value: "high" }],
                type: "select",
              },
            ],
            type: "config",
          });
        }
        if (this.askElicitation) {
          const response = handlers.elicitation({
            fields: [
              {
                label: "Choice",
                name: "choice",
                options: [{ name: "Option A", value: "a" }],
                required: true,
                type: "select",
              },
            ],
            message: "Pick one",
          });
          this.markElicitationStarted();
          this.elicitationResponse = await response;
        }
        if (this.askPermission) {
          const response = handlers.permission({
            message: "Run tests?",
            options: [{ id: "yes", kind: "allow_once", name: "Yes" }],
          });
          this.markPermissionStarted();
          this.permissionResponse = await response;
        }
        handlers.update({ kind: "assistant", text: "Done.", type: "message" });
        handlers.update({ title: "Fix tests", type: "sessionInfo" });
        return { stopReason: "completed" };
      },
      setConfig: (sessionId, configId, value) => {
        this.configChange = { configId, sessionId, value };
        return Promise.resolve();
      },
    };
  }
}

describe("threads module", () => {
  test("sends a pasted image without requiring text", async () => {
    const agent = new FakeAgent();
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    await threads.prompt("", [
      { data: "c2NyZWVuc2hvdA==", mimeType: "image/png" },
    ]);

    expect(agent.promptImages).toStrictEqual([
      { data: "c2NyZWVuc2hvdA==", mimeType: "image/png" },
    ]);
    expect(
      threads.snapshot().selected?.items.find((item) => item.kind === "user")
    ).toMatchObject({
      images: [{ data: "c2NyZWVuc2hvdA==", mimeType: "image/png" }],
      text: "Pasted image",
    });
  });

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

    expect(threads.snapshot()).toStrictEqual({
      attentionCount: 0,
      threads: [],
    });
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
    agent.createError = Object.assign(new Error("Authentication required"), {
      authentication: {
        args: ["/magpi/index.js", "--terminal-login"],
        command: "node",
        label: "Launch Pi",
      },
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
      usage: { size: 245_000, used: 125_000 },
    });
  });

  test("context usage survives a Thread reload", async () => {
    const storage = memoryStorage();
    const agent = new FakeAgent();
    agent.richUpdates = true;
    const threads = new Threads(storage, agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Inspect it");

    const restored = new Threads(storage, new FakeAgent().factory);
    await restored.openWorkspace("/workspace");

    expect(restored.snapshot().selected?.usage).toStrictEqual({
      size: 245_000,
      used: 125_000,
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
      values: { choice: "a" },
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
    expect(threads.snapshot()).toMatchObject({
      attentionCount: 1,
      selected: {
        interaction: {
          kind: "permission",
          message: "Run tests?",
          options: [{ id: "yes", name: "Yes" }],
        },
        status: "waiting",
      },
      threads: [
        {
          indicator: "waiting",
          needsAttention: true,
          status: "waiting",
        },
      ],
    });
    threads.respond(interaction?.id ?? "", {
      action: "select",
      optionId: "yes",
    });
    await prompting;

    expect(agent.permissionResponse).toStrictEqual({ optionId: "yes" });
    expect(threads.snapshot()).toMatchObject({
      attentionCount: 0,
      selected: { status: "idle" },
      threads: [{ indicator: "idle", needsAttention: false, status: "idle" }],
    });
  });

  test("completed background Threads stay green until viewed", async () => {
    const agent = new FakeAgent();
    agent.holdPrompts = true;
    const threads = new Threads(memoryStorage(), agent.factory);
    await threads.openWorkspace("/workspace");

    const firstPrompt = threads.prompt("First");
    await agent.firstPromptStarted;
    const firstId = threads.snapshot().selected?.id;
    await threads.newThread();
    agent.promptResolvers[0]?.({ stopReason: "completed" });
    await firstPrompt;

    expect(threads.snapshot()).toMatchObject({
      attentionCount: 1,
      threads: [
        { indicator: "idle", needsAttention: false },
        { id: firstId, indicator: "completed", needsAttention: true },
      ],
    });

    await threads.select(firstId ?? "");

    expect(threads.snapshot()).toMatchObject({
      attentionCount: 0,
      threads: [
        { indicator: "idle", needsAttention: false },
        { id: firstId, indicator: "idle", needsAttention: false },
      ],
    });
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
