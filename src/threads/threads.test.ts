import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ProfileDatabase } from "../profile-database/profile-database";
import { Threads } from "./threads";
import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentHandlers,
  AgentPromptResult,
  PromptImage,
  ThreadConfigOption,
  ThreadsChange,
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

class FakeAgent {
  createCalls = 0;
  loadCalls = 0;
  initialConfigOptions: ThreadConfigOption[] = [];
  failCreate = false;
  createError?: Error;
  replayOnLoad = false;
  askPermission = false;
  askElicitation = false;
  richUpdates = false;
  completePlan = false;
  holdPrompts = false;
  permissionResponse?: unknown;
  elicitationResponse?: unknown;
  configChange?: {
    sessionId: string;
    configId: string;
    value: string | boolean;
  };
  disposed = false;
  forkCalls: { sessionId: string; cwd: string; messageId: string }[] = [];
  rollbackCalls: { sessionId: string; messageId: string }[] = [];
  update?: AgentHandlers["update"];
  private readonly permissionStartedDeferred = deferred();
  private readonly elicitationStartedDeferred = deferred();
  private readonly firstPromptStartedDeferred = deferred();
  private readonly secondPromptStartedDeferred = deferred();
  readonly promptResolvers: ((response: AgentPromptResult) => void)[] = [];
  promptImages: PromptImage[] = [];
  promptCalls = 0;
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
    this.update = handlers.update;
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
      fork: (sessionId, cwd, messageId) => {
        this.forkCalls.push({ cwd, messageId, sessionId });
        return Promise.resolve({
          configOptions: [],
          sessionId: "forked-session",
        });
      },
      load: (sessionId) => {
        this.loadCalls += 1;
        if (this.replayOnLoad) {
          handlers.update({
            kind: "user",
            messageId: "pi-user-1",
            text: "Restore me",
            type: "message",
          });
          handlers.update({
            kind: "assistant",
            text: "Restored.",
            type: "message",
          });
        }
        return Promise.resolve({ configOptions: [], sessionId });
      },
      prompt: async (_sessionId, _text, _messageId, images) => {
        this.promptImages = images;
        if (this.holdPrompts) {
          this.promptCalls += 1;
          if (this.promptCalls === 1) {
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
          this.markPromptStarted(this.promptCalls);
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
          handlers.update({
            allCompleted: this.completePlan,
            entries: [
              { content: "Inspect", status: "completed" },
              {
                content: "Fix",
                status: this.completePlan ? "completed" : "in_progress",
              },
            ],
            text: this.completePlan ? "✓ Inspect\n✓ Fix" : "✓ Inspect\n• Fix",
            type: "plan",
          });
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
      rollback: (sessionId, messageId) => {
        this.rollbackCalls.push({ messageId, sessionId });
        return Promise.resolve();
      },
      setConfig: (sessionId, configId, value) => {
        this.configChange = { configId, sessionId, value };
        return Promise.resolve();
      },
    };
  }
}

describe("threads module", () => {
  let database: ProfileDatabase;
  let profileDirectory: string;
  let instances: Threads[];

  beforeEach(async () => {
    profileDirectory = await mkdtemp(path.join(tmpdir(), "mischief-threads-"));
    database = await ProfileDatabase.open({
      currentWorkspace: "/workspace",
      instanceId: "00000000-0000-4000-8000-000000000001",
      log: vi.fn<(message: string) => void>(),
      profileDirectory,
    });
    instances = [];
  });

  afterEach(async () => {
    await Promise.all(instances.map((threads) => threads.dispose()));
    await database.dispose();
    await rm(profileDirectory, { force: true, recursive: true });
  });

  const createThreads = (factory: AgentConnectionFactory): Threads => {
    const threads = new Threads(database, factory);
    instances.push(threads);
    return threads;
  };

  test("exposes profile-wide Thread summaries with owning Workspaces", async () => {
    const createdAt = "2026-09-11T12:00:00.000Z";
    await database.apply({
      thread: {
        createdAt,
        id: "10000000-0000-4000-8000-000000000001",
        name: "Waiting",
        status: "waiting",
        updatedAt: createdAt,
        workspace: "/workspace",
      },
      type: "putThread",
    });
    const threads = createThreads(new FakeAgent().factory);

    expect(threads.snapshot().threads).toStrictEqual([
      {
        createdAt,
        id: "10000000-0000-4000-8000-000000000001",
        indicator: "waiting",
        name: "Waiting",
        needsAttention: true,
        status: "waiting",
        updatedAt: createdAt,
        workspace: "/workspace",
      },
    ]);
  });

  test("remote selection is restored only by the owning Workspace", async () => {
    const remoteDatabase = await ProfileDatabase.open({
      currentWorkspace: "/remote",
      instanceId: "00000000-0000-4000-8000-000000000002",
      log: vi.fn<(message: string) => void>(),
      profileDirectory,
    });
    const createdAt = "2026-09-11T12:00:00.000Z";
    const firstId = "10000000-0000-4000-8000-000000000001";
    const secondId = "10000000-0000-4000-8000-000000000002";
    await Promise.all(
      (
        [
          [firstId, "first-session"],
          [secondId, "second-session"],
        ] as const
      ).map(([id, sessionId]) =>
        remoteDatabase.apply({
          thread: {
            createdAt,
            id,
            name: sessionId,
            sessionId,
            status: "idle",
            updatedAt: createdAt,
            workspace: "/remote",
          },
          type: "putThread",
        })
      )
    );
    await remoteDatabase.apply({
      threadId: firstId,
      type: "selectThread",
      workspace: "/remote",
    });
    await vi.waitFor(
      () => expect(database.snapshot().threads).toHaveLength(2),
      { timeout: 2000 }
    );
    const sourceAgent = new FakeAgent();
    const ownerAgent = new FakeAgent();
    const source = createThreads(sourceAgent.factory);
    const owner = new Threads(remoteDatabase, ownerAgent.factory);
    instances.push(owner);
    await owner.openWorkspace("/remote");

    await expect(source.select(secondId)).resolves.toBe("/remote");
    await vi.waitFor(
      () => {
        expect(owner.snapshot().selected?.id).toBe(secondId);
      },
      { timeout: 2000 }
    );

    expect(sourceAgent.loadCalls).toBe(0);
    expect(sourceAgent.createCalls).toBe(0);
    expect(ownerAgent.loadCalls).toBe(2);
    await remoteDatabase.dispose();
  });

  test("opening a Workspace clears stale live Thread statuses", async () => {
    const createdAt = "2026-09-11T12:00:00.000Z";
    await Promise.all(
      (["running", "waiting"] as const).map((status, index) =>
        database.apply({
          thread: {
            createdAt,
            id: `10000000-0000-4000-8000-00000000000${index + 1}`,
            name: status,
            status,
            updatedAt: createdAt,
            workspace: "/workspace",
          },
          type: "putThread",
        })
      )
    );
    const threads = createThreads(new FakeAgent().factory);

    await threads.openWorkspace("/workspace");

    expect(
      database.snapshot().threads.map((thread) => thread.status)
    ).toStrictEqual(["idle", "idle"]);
  });

  test("sends a pasted image without requiring text", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
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

  test("ignores invalid Agent Thread metadata", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.newThread();
    const updatedAt = threads.snapshot().threads[0]?.updatedAt;

    agent.update?.({
      title: "Invalid\nThread",
      type: "sessionInfo",
      updatedAt: "not-a-timestamp",
    });

    expect(threads.snapshot()).toMatchObject({
      selected: { name: "New Thread" },
      threads: [{ updatedAt }],
    });
  });

  test("a user-renamed Thread ignores later automatic titles", async () => {
    const threads = createThreads(new FakeAgent().factory);
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
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    const prompting = threads.prompt("Keep running");
    await agent.firstPromptStarted;

    await threads.closeWorkspace();
    await prompting;

    expect(threads.snapshot()).toMatchObject({
      threads: [{ status: "idle", workspace: "/workspace" }],
    });
  });

  test("removing a running Thread cannot resurrect its registration", async () => {
    const agent = new FakeAgent();
    agent.holdPrompts = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    const prompting = threads.prompt("Remove me");
    await agent.firstPromptStarted;
    const id = threads.snapshot().selected?.id;

    await threads.remove(id ?? "");
    await prompting;

    expect(database.snapshot().threads).toStrictEqual([]);
    expect(threads.snapshot().threads).toStrictEqual([]);
  });

  test("Threads stay newest-first and restore the last selection", async () => {
    const threads = createThreads(new FakeAgent().factory);
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

    const restored = createThreads(new FakeAgent().factory);
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
    const threads = createThreads(agent.factory);
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
    const threads = createThreads(agent.factory);
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
    const threads = createThreads(new FakeAgent().factory);
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
    const restored = createThreads(new FakeAgent().factory);
    await restored.openWorkspace("/workspace");
    expect(restored.snapshot().selected?.id).toBe(secondId);
  });

  test("forks before a user message and restores it as an editable draft", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Fork from here");
    const message = threads
      .snapshot()
      .selected?.items.find((item) => item.kind === "user");
    if (!message) {
      throw new Error("Missing user message");
    }

    await threads.fork(message.id);

    expect(agent.forkCalls).toStrictEqual([
      {
        cwd: "/workspace",
        messageId: message.id,
        sessionId: "session-1",
      },
    ]);
    expect(threads.snapshot().selected).toMatchObject({
      drafts: ["Fork from here"],
      id: expect.any(String),
      items: [],
      name: "Fix tests (fork)",
    });
  });

  test("rolls back before the selected user message and restores its draft", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Restore me");
    await threads.prompt("Later message");
    const message = threads
      .snapshot()
      .selected?.items.find(
        (item) => item.kind === "user" && item.text === "Restore me"
      );
    if (!message) {
      throw new Error("Missing user message");
    }
    agent.replayOnLoad = true;

    await threads.rollback(message.id);

    expect(agent.rollbackCalls).toStrictEqual([
      { messageId: message.id, sessionId: "session-1" },
    ]);
    expect(threads.snapshot().selected).toMatchObject({
      drafts: ["Restore me"],
      items: [],
    });
  });

  test("stopping a running Thread preserves output and restores queued prompts as drafts", async () => {
    const agent = new FakeAgent();
    agent.holdPrompts = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    const changes: (ThreadsChange | undefined)[] = [];
    threads.onChange((change) => changes.push(change));

    const first = threads.prompt("First");
    expect(threads.snapshot().selected).toMatchObject({
      status: "running",
      streaming: false,
    });
    await agent.firstPromptStarted;
    expect(threads.snapshot().selected?.streaming).toBeTruthy();
    expect(changes).toContainEqual(
      expect.objectContaining({
        item: expect.objectContaining({ kind: "assistant", text: "Partial" }),
        streaming: true,
        type: "transcript",
      })
    );
    const second = threads.prompt("Second");

    expect(threads.snapshot().selected).toMatchObject({
      items: [
        { kind: "user", text: "First" },
        { kind: "assistant", text: "Partial" },
        { kind: "user", queued: 1, text: "Second" },
      ],
      status: "running",
      steering: [{ text: "Second" }],
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

  test("queued steering messages can be removed or sent immediately", async () => {
    const agent = new FakeAgent();
    agent.holdPrompts = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");

    const first = threads.prompt("First");
    await agent.firstPromptStarted;
    await threads.prompt("Remove me");
    await threads.prompt("Send me now");
    const steering = threads.snapshot().selected?.steering ?? [];

    threads.removeSteering(steering[0]?.id ?? "");
    await threads.sendSteering(steering[1]?.id ?? "");
    await agent.secondPromptStarted;

    expect(threads.snapshot().selected).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          cancelled: true,
          kind: "user",
          text: "First",
        }),
        expect.objectContaining({ kind: "user", text: "Send me now" }),
      ]),
      steering: [],
    });
    agent.promptResolvers[0]?.({ stopReason: "completed" });
    await first;
  });

  test("ACP thoughts, tools, plans, and configuration update the Thread", async () => {
    const agent = new FakeAgent();
    agent.richUpdates = true;
    const threads = createThreads(agent.factory);
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

    threads.clearPlan();

    expect(
      threads.snapshot().selected?.items.some((item) => item.kind === "plan")
    ).toBeFalsy();
  });

  test("moves an all-completed plan into the transcript", async () => {
    const agent = new FakeAgent();
    agent.richUpdates = true;
    agent.completePlan = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");

    await threads.prompt("Inspect it");

    expect(threads.snapshot().selected?.items).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "completedPlan",
          text: "✓ Inspect\n✓ Fix",
        }),
      ])
    );
    expect(
      threads.snapshot().selected?.items.some((item) => item.kind === "plan")
    ).toBeFalsy();
  });

  test("replaces advertised commands, including with an empty list", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.newThread();

    agent.update?.({
      commands: [
        { description: "Run checks", inputHint: "[files]", name: "check" },
      ],
      type: "commands",
    });
    expect(threads.snapshot().selected?.commands).toStrictEqual([
      { description: "Run checks", inputHint: "[files]", name: "check" },
    ]);

    agent.update?.({ commands: [], type: "commands" });
    expect(threads.snapshot().selected?.commands).toStrictEqual([]);
  });

  test("context usage survives a Thread reload", async () => {
    const agent = new FakeAgent();
    agent.richUpdates = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Inspect it");

    const restored = createThreads(new FakeAgent().factory);
    await restored.openWorkspace("/workspace");

    expect(restored.snapshot().selected?.usage).toStrictEqual({
      size: 245_000,
      used: 125_000,
    });
  });

  test("elicitation forms wait for an inline Thread response", async () => {
    const agent = new FakeAgent();
    agent.askElicitation = true;
    const threads = createThreads(agent.factory);
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
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");

    const prompting = threads.prompt("Run the tests");
    await agent.permissionStarted;

    const interaction = threads.snapshot().selected?.interaction;
    expect(threads.snapshot()).toMatchObject({
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
    await vi.waitFor(() => {
      expect(database.snapshot().threads[0]?.status).toBe("waiting");
    });
    threads.respond(interaction?.id ?? "", {
      action: "select",
      optionId: "yes",
    });
    await prompting;

    expect(agent.permissionResponse).toStrictEqual({ optionId: "yes" });
    expect(database.snapshot().threads[0]?.status).toBe("idle");
    expect(threads.snapshot()).toMatchObject({
      selected: { status: "idle" },
      threads: [{ indicator: "idle", needsAttention: false, status: "idle" }],
    });
  });

  test("completed background Threads stay green until viewed", async () => {
    const agent = new FakeAgent();
    agent.holdPrompts = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");

    const firstPrompt = threads.prompt("First");
    await agent.firstPromptStarted;
    const firstId = threads.snapshot().selected?.id;
    await threads.newThread();
    agent.promptResolvers[0]?.({ stopReason: "completed" });
    await firstPrompt;

    expect(threads.snapshot()).toMatchObject({
      threads: [
        { indicator: "idle", needsAttention: false },
        { id: firstId, indicator: "completed", needsAttention: true },
      ],
    });

    await threads.select(firstId ?? "");

    expect(threads.snapshot()).toMatchObject({
      threads: [
        { indicator: "idle", needsAttention: false },
        { id: firstId, indicator: "idle", needsAttention: false },
      ],
    });
  });

  test("opening a durable Thread restores its transcript from ACP", async () => {
    const original = createThreads(new FakeAgent().factory);
    await original.openWorkspace("/workspace");
    await original.prompt("Restore me");

    const loadingAgent = new FakeAgent();
    loadingAgent.replayOnLoad = true;
    const restored = createThreads(loadingAgent.factory);
    await restored.openWorkspace("/workspace");

    expect(restored.snapshot().selected?.items).toMatchObject([
      { id: "user:pi-user-1", kind: "user", text: "Restore me" },
      { kind: "assistant", text: "Restored." },
    ]);

    await restored.rollback("user:pi-user-1");
    expect(loadingAgent.rollbackCalls).toStrictEqual([
      { messageId: "pi-user-1", sessionId: "session-1" },
    ]);

    const forkingAgent = new FakeAgent();
    forkingAgent.replayOnLoad = true;
    const forking = createThreads(forkingAgent.factory);
    await forking.openWorkspace("/workspace");
    await forking.fork("user:pi-user-1");
    expect(forkingAgent.forkCalls).toStrictEqual([
      {
        cwd: "/workspace",
        messageId: "pi-user-1",
        sessionId: "session-1",
      },
    ]);
  });

  test("a failed first prompt remains durable and can be retried", async () => {
    const failingAgent = new FakeAgent();
    failingAgent.failCreate = true;
    const threads = createThreads(failingAgent.factory);
    await threads.openWorkspace("/workspace");

    await threads.prompt("Try again");

    expect(threads.snapshot()).toMatchObject({
      selected: { error: "Agent unavailable", status: "error" },
      threads: [{ status: "error" }],
    });

    const recovered = createThreads(new FakeAgent().factory);
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
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
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
