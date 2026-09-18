import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isDefined, isNonEmpty } from "../present";
import { ProfileDatabase } from "../profile-database/profile-database";
import { testValue } from "../test-value";
import { Threads } from "./threads";
import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentHandlers,
  AgentPromptResult,
  AgentTreeTarget,
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
  loadRequests: { sessionId: string; cwd: string }[] = [];
  initialConfigOptions: ThreadConfigOption[] = [];
  operations = { forkPicker: true, treePicker: true };
  failCreate = false;
  createError?: Error;
  replayOnLoad = false;
  failLoad = false;
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
  historyEntries: {
    sessionId: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
    preview?: string;
    previewRole?: "user" | "assistant";
  }[] = [];
  historyCalls: string[] = [];
  forkCalls: { sessionId: string; cwd: string; entryId: string }[] = [];
  forkTargetCalls: string[] = [];
  forkTargetEntries = [{ entryId: "pi-user-1", text: "Fork from here" }];
  forkGate?: Deferred;
  treeTargetCalls: string[] = [];
  treeTargetEntries: AgentTreeTarget[] = [
    {
      activeBranch: true,
      current: true,
      depth: 0,
      entryId: "pi-user-1",
      role: "user",
      text: "Try this again",
    },
  ];
  navigateTreeCalls: { sessionId: string; entryId: string }[] = [];
  navigationResult: { draft?: string } = { draft: "Try this again" };
  navigationError?: Error;
  navigationGate?: Deferred;
  update?: AgentHandlers["update"];
  private readonly permissionStartedDeferred = deferred();
  private readonly elicitationStartedDeferred = deferred();
  private readonly firstPromptStartedDeferred = deferred();
  private readonly secondPromptStartedDeferred = deferred();
  readonly promptResolvers: ((response: AgentPromptResult) => void)[] = [];
  promptImages: PromptImage[] = [];
  promptCalls = 0;
  responseCount = 0;
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
      cancel: async () => {
        await Promise.resolve();
        for (const resolve of this.promptResolvers.splice(0)) {
          resolve({ stopReason: "cancelled" });
        }
      },
      create: async () => {
        await Promise.resolve();
        this.createCalls += 1;
        if (this.createError) {
          throw this.createError;
        }
        if (this.failCreate) {
          throw new Error("Agent unavailable");
        }
        return {
          configOptions: this.initialConfigOptions,
          operations: this.operations,
          sessionId: "session-1",
        };
      },
      dispose: () => {
        this.disposed = true;
      },
      fork: async (sessionId, cwd, entryId) => {
        this.forkCalls.push({ cwd, entryId, sessionId });
        await this.forkGate?.promise;
        return {
          configOptions: [],
          operations: this.operations,
          sessionId: "forked-session",
        };
      },
      forkTargets: async (sessionId) => {
        await Promise.resolve();
        this.forkTargetCalls.push(sessionId);
        return this.forkTargetEntries;
      },
      history: async (cwd) => {
        await Promise.resolve();
        this.historyCalls.push(cwd);
        return this.historyEntries;
      },
      load: async (sessionId, cwd) => {
        await Promise.resolve();
        this.loadCalls += 1;
        this.loadRequests.push({ cwd, sessionId });
        if (this.failLoad) {
          throw new Error("Load failed");
        }
        if (this.replayOnLoad) {
          handlers.update({
            kind: "user",
            messageId: "pi-user-1",
            text: "Restore me",
            type: "message",
          });
          handlers.update({
            kind: "assistant",
            messageId: "pi-assistant-1",
            text: "Restored.",
            type: "message",
          });
        }
        return {
          configOptions: [],
          operations: this.operations,
          sessionId,
        };
      },
      navigateTree: async (sessionId, entryId) => {
        this.navigateTreeCalls.push({ entryId, sessionId });
        if (this.navigationError) {
          throw this.navigationError;
        }
        await this.navigationGate?.promise;
        return this.navigationResult;
      },
      prompt: async (_sessionId, _text, images) => {
        this.promptImages = images;
        if (this.holdPrompts) {
          this.promptCalls += 1;
          if (this.promptCalls === 1) {
            handlers.update({
              kind: "assistant",
              messageId: "pi-assistant-held-1",
              text: "Partial",
              type: "message",
            });
          }
          // oxlint-disable-next-line promise/avoid-new
          const result = new Promise<AgentPromptResult>((resolve) => {
            this.promptResolvers.push(resolve);
          });
          this.markPromptStarted(this.promptCalls);
          return await result;
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
        this.responseCount += 1;
        handlers.update({
          kind: "assistant",
          messageId: `pi-assistant-${this.responseCount}`,
          text: "Done.",
          type: "message",
        });
        handlers.update({ title: "Fix tests", type: "sessionInfo" });
        return { stopReason: "completed" };
      },
      setConfig: async (sessionId, configId, value) => {
        await Promise.resolve();
        this.configChange = { configId, sessionId, value };
      },
      treeTargets: async (sessionId) => {
        await Promise.resolve();
        this.treeTargetCalls.push(sessionId);
        return this.treeTargetEntries;
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
    await Promise.all(
      instances.map(async (threads) => {
        await threads.dispose();
      })
    );
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
      ).map(async ([id, sessionId]) => {
        await remoteDatabase.apply({
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
        });
      })
    );
    await remoteDatabase.apply({
      threadId: firstId,
      type: "selectThread",
      workspace: "/remote",
    });
    await vi.waitFor(
      () => {
        expect(database.snapshot().threads).toHaveLength(2);
      },
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
      (["running", "waiting"] as const).map(async (status, index) => {
        await database.apply({
          thread: {
            createdAt,
            id: `10000000-0000-4000-8000-00000000000${index + 1}`,
            name: status,
            status,
            updatedAt: createdAt,
            workspace: "/workspace",
          },
          type: "putThread",
        });
      })
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
      id: testValue<unknown>(expect.any(String)),
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

  test("forks from a native target without changing the source Thread", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Fork from here");
    const source = threads.snapshot().selected;
    if (!isNonEmpty(source?.id)) {
      throw new Error("Missing source Thread");
    }
    const context = await threads.forkTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing fork target");
    }

    await threads.fork(context.threadId, target);

    expect(agent.forkTargetCalls).toStrictEqual(["session-1"]);
    expect(agent.forkCalls).toStrictEqual([
      {
        cwd: "/workspace",
        entryId: "pi-user-1",
        sessionId: "session-1",
      },
    ]);
    expect(threads.snapshot().selected).toMatchObject({
      drafts: ["Fork from here"],
      id: testValue<unknown>(expect.not.stringMatching(source.id)),
      items: [],
      name: "Fix tests (fork)",
    });
    expect(threads.snapshot().threads).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: source.id, name: "Fix tests" }),
      ])
    );
  });

  test("rejects unavailable and stale fork pickers", async () => {
    const agent = new FakeAgent();
    agent.operations.forkPicker = false;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("First Thread");

    await expect(threads.forkTargets()).rejects.toThrow(
      "does not support Fork Thread"
    );

    agent.operations.forkPicker = true;
    agent.holdPrompts = true;
    const running = threads.prompt("Still running");
    await agent.firstPromptStarted;
    await expect(threads.forkTargets()).rejects.toThrow(
      "current turn to finish"
    );
    await threads.cancel();
    await running;

    await threads.newThread();
    const context = await threads.forkTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing fork target");
    }
    await threads.newThread();

    await expect(threads.fork(context.threadId, target)).rejects.toThrow(
      "selected Thread changed"
    );
    expect(agent.forkCalls).toStrictEqual([]);
  });

  test("blocks source prompts without stealing a newer selection during fork", async () => {
    const agent = new FakeAgent();
    agent.forkGate = deferred();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Source Thread");
    const sourceId = threads.snapshot().selected?.id;
    if (!isNonEmpty(sourceId)) {
      throw new Error("Missing source Thread");
    }
    await threads.newThread();
    const otherId = threads.snapshot().selected?.id;
    if (!isNonEmpty(otherId)) {
      throw new Error("Missing other Thread");
    }
    await threads.select(sourceId);
    const context = await threads.forkTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing fork target");
    }

    const forking = threads.fork(context.threadId, target);
    expect(threads.snapshot().selected?.sessionOperation).toBeTruthy();
    await expect(threads.prompt("Too soon")).rejects.toThrow(
      "Thread operation to finish"
    );
    await threads.select(otherId);
    agent.forkGate.resolve();
    await forking;

    expect(threads.snapshot().selected?.id).toBe(otherId);
    expect(threads.snapshot().threads.map((thread) => thread.name)).toContain(
      "Fix tests (fork)"
    );
  });

  test("keeps a fork child registered when replay fails", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Fork from here");
    const context = await threads.forkTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing fork target");
    }
    agent.failLoad = true;

    await threads.fork(context.threadId, target);

    expect(threads.snapshot().selected).toMatchObject({
      error: "Load failed",
      status: "error",
    });
    expect(threads.snapshot().threads).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Fix tests (fork)", status: "error" }),
      ])
    );
  });

  test("navigates to a native tree target and reloads the same Thread", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Old branch");
    const [source] = threads.snapshot().threads;
    if (!isDefined(source)) {
      throw new Error("Missing source Thread");
    }
    const context = await threads.treeTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing tree target");
    }
    agent.replayOnLoad = true;

    await threads.navigateTree(context.threadId, target);

    expect(agent.treeTargetCalls).toStrictEqual(["session-1"]);
    expect(agent.navigateTreeCalls).toStrictEqual([
      { entryId: "pi-user-1", sessionId: "session-1" },
    ]);
    expect(agent.loadRequests).toContainEqual({
      cwd: "/workspace",
      sessionId: "session-1",
    });
    expect(threads.snapshot()).toMatchObject({
      selected: {
        drafts: ["Try this again"],
        id: source.id,
        items: [
          { kind: "user", text: "Restore me" },
          { kind: "assistant", text: "Restored." },
        ],
      },
      threads: [{ createdAt: source.createdAt, id: source.id }],
    });
  });

  test("assistant tree navigation adds no draft and preserves existing drafts", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Old branch");
    const first = await threads.treeTargets();
    const [userTarget] = first.targets;
    if (!isDefined(userTarget)) {
      throw new Error("Missing user tree target");
    }
    await threads.navigateTree(first.threadId, userTarget);
    agent.navigationResult = { draft: "Do not restore an assistant message" };
    agent.treeTargetEntries = [
      {
        activeBranch: true,
        current: true,
        depth: 1,
        entryId: "pi-assistant-1",
        role: "assistant",
        text: "Done",
      },
    ];
    const second = await threads.treeTargets();
    const [assistantTarget] = second.targets;
    if (!isDefined(assistantTarget)) {
      throw new Error("Missing assistant tree target");
    }

    await threads.navigateTree(second.threadId, assistantTarget);

    expect(agent.navigateTreeCalls.at(-1)).toStrictEqual({
      entryId: "pi-assistant-1",
      sessionId: "session-1",
    });
    expect(threads.snapshot().selected?.drafts).toStrictEqual([
      "Try this again",
    ]);
  });

  test("rejects unavailable, running, and stale tree navigation", async () => {
    const agent = new FakeAgent();
    agent.operations.treePicker = false;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("First Thread");

    await expect(threads.treeTargets()).rejects.toThrow(
      "does not support Navigate Thread Tree"
    );

    agent.operations.treePicker = true;
    agent.holdPrompts = true;
    const running = threads.prompt("Still running");
    await agent.firstPromptStarted;
    await expect(threads.treeTargets()).rejects.toThrow(
      "current turn to finish"
    );
    await threads.cancel();
    await running;

    await threads.newThread();
    const context = await threads.treeTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing tree target");
    }
    await threads.newThread();

    await expect(
      threads.navigateTree(context.threadId, target)
    ).rejects.toThrow("selected Thread changed");
    expect(agent.navigateTreeCalls).toStrictEqual([]);
  });

  test("tree navigation failure preserves the old transcript", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Old branch");
    const context = await threads.treeTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing tree target");
    }
    const oldItems = threads.snapshot().selected?.items;
    agent.navigationError = new Error("Navigation failed");

    await expect(
      threads.navigateTree(context.threadId, target)
    ).rejects.toThrow("Navigation failed");

    expect(threads.snapshot().selected).toMatchObject({
      items: oldItems,
      status: "idle",
    });
    expect(threads.snapshot().selected?.sessionOperation).toBeUndefined();
  });

  test("tree replay failure clears stale transcript and remains retryable", async () => {
    const agent = new FakeAgent();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Old branch");
    const context = await threads.treeTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing tree target");
    }
    agent.failLoad = true;

    await threads.navigateTree(context.threadId, target);

    expect(threads.snapshot().selected).toMatchObject({
      drafts: ["Try this again"],
      error: "Load failed",
      items: [],
      status: "error",
    });
  });

  test("tree navigation cannot send on its source or steal a newer selection", async () => {
    const agent = new FakeAgent();
    agent.navigationGate = deferred();
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Source Thread");
    const sourceId = threads.snapshot().selected?.id;
    if (!isNonEmpty(sourceId)) {
      throw new Error("Missing source Thread");
    }
    await threads.newThread();
    const otherId = threads.snapshot().selected?.id;
    if (!isNonEmpty(otherId)) {
      throw new Error("Missing other Thread");
    }
    await threads.select(sourceId);
    const context = await threads.treeTargets();
    const [target] = context.targets;
    if (!isDefined(target)) {
      throw new Error("Missing tree target");
    }

    const navigating = threads.navigateTree(context.threadId, target);
    expect(threads.snapshot().selected?.sessionOperation).toBeTruthy();
    await expect(threads.prompt("Too soon")).rejects.toThrow(
      "Thread operation to finish"
    );
    await threads.select(otherId);
    agent.navigationGate.resolve();
    await navigating;

    expect(threads.snapshot().selected?.id).toBe(otherId);
    await threads.select(sourceId);
    expect(threads.snapshot().selected).toMatchObject({
      drafts: ["Try this again"],
      items: [],
      status: "idle",
    });
  });

  test("stopping a running Thread preserves output and restores queued prompts as drafts", async () => {
    const agent = new FakeAgent();
    agent.holdPrompts = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    const changes: (ThreadsChange | undefined)[] = [];
    threads.onChange((change) => {
      changes.push(change);
    });

    const first = threads.prompt("First");
    expect(threads.snapshot().selected).toMatchObject({
      status: "running",
      streaming: false,
    });
    await agent.firstPromptStarted;
    expect(threads.snapshot().selected?.streaming).toBeTruthy();
    expect(changes).toContainEqual(
      expect.objectContaining({
        item: testValue<unknown>(
          expect.objectContaining({ kind: "assistant", text: "Partial" })
        ),
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
      items: testValue<unknown>(
        expect.arrayContaining([
          expect.objectContaining({
            cancelled: true,
            kind: "user",
            text: "First",
          }),
          expect.objectContaining({ kind: "user", text: "Send me now" }),
        ])
      ),
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

  test("lists inactive Agent Threads for the current Workspace newest-first", async () => {
    const agent = new FakeAgent();
    agent.historyEntries = [
      {
        cwd: "/workspace",
        sessionId: "session-1",
        title: "Already open",
        updatedAt: "2026-09-16T09:00:00.000Z",
      },
      {
        cwd: "/workspace",
        preview: "Fix the login cache",
        previewRole: "user",
        sessionId: "session-newest",
        title: "Newest",
        updatedAt: "2026-09-16T12:00:00.000Z",
      },
      {
        cwd: "/other",
        sessionId: "other-workspace",
        title: "Other Workspace",
        updatedAt: "2026-09-16T13:00:00.000Z",
      },
      { cwd: "/workspace", sessionId: "session-unknown" },
    ];
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    await threads.prompt("Register this session");

    await expect(threads.history()).resolves.toStrictEqual([
      {
        preview: "Fix the login cache",
        previewRole: "user",
        sessionId: "session-newest",
        title: "Newest",
        updatedAt: "2026-09-16T12:00:00.000Z",
      },
      { sessionId: "session-unknown", title: "Untitled Thread" },
    ]);
    expect(agent.historyCalls).toStrictEqual(["/workspace"]);
    expect(agent.disposed).toBeTruthy();
  });

  test("reopens an Agent session once as the selected durable Thread", async () => {
    const agent = new FakeAgent();
    agent.replayOnLoad = true;
    const threads = createThreads(agent.factory);
    await threads.openWorkspace("/workspace");
    const entry = {
      sessionId: "previous-session",
      title: "Previous Thread",
      updatedAt: "2026-09-15T12:00:00.000Z",
    };

    await threads.reopen(entry);
    await threads.reopen(entry);

    expect(database.snapshot().threads).toMatchObject([
      {
        name: "Previous Thread",
        sessionId: "previous-session",
        updatedAt: "2026-09-15T12:00:00.000Z",
        workspace: "/workspace",
      },
    ]);
    expect(database.snapshot().selections).toMatchObject([
      { threadId: database.snapshot().threads[0]?.id, workspace: "/workspace" },
    ]);
    expect(agent.loadRequests).toStrictEqual([
      { cwd: "/workspace", sessionId: "previous-session" },
    ]);
    expect(threads.snapshot().selected).toMatchObject({
      items: [
        { kind: "user", text: "Restore me" },
        { kind: "assistant", text: "Restored." },
      ],
      name: "Previous Thread",
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
      {
        id: "assistant:pi-assistant-1",
        kind: "assistant",
        text: "Restored.",
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
