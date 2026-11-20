import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { HostThreads } from "./host-threads";

const roots: string[] = [];
const acpSession = (sessionId: string) => ({
  operations: {
    branchSummary: false,
    forkMessage: false,
    treeNavigation: false,
  },
  sessionId,
});
const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let complete: ((value: T) => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new -- the test controls when an Agent turn completes.
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      complete?.(value);
    },
  };
};

describe("Host Threads", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { force: true, recursive: true });
      })
    );
  });

  test("publishes the latest Thread configuration in live and reconnect snapshots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-config-"));
    roots.push(root);
    const initial = [
      {
        currentValue: "fast",
        id: "model",
        name: "Model",
        options: [
          { name: "Fast", value: "fast" },
          { name: "Deep", value: "deep" },
        ],
        type: "select" as const,
      },
    ];
    const events: unknown[] = [];
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () =>
          await Promise.resolve({
            ...acpSession("session-1"),
            configOptions: initial,
          }),
        load: async () =>
          await Promise.resolve({
            ...acpSession("session-1"),
            configOptions: initial,
          }),
        prompt: async () => await Promise.resolve("completed" as const),
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      (event) => {
        events.push(event);
      }
    );
    const thread = await threads.create("magpi-acp", "/workspace");
    expect(threads.snapshot()[0]).toMatchObject({ configOptions: initial });
    const updated = [{ ...initial[0], currentValue: "deep" }];
    threads.event({
      agentId: "magpi-acp",
      sessionId: "session-1",
      type: "acpUpdate",
      update: { configOptions: updated, sessionUpdate: "config_option_update" },
    });
    expect(threads.snapshot()[0]).toMatchObject({ configOptions: updated });
    await expect(threads.load(thread.id)).resolves.toMatchObject({
      configOptions: updated,
    });
    await expect(threads.transcript(thread.id)).resolves.toStrictEqual({
      cursor: null,
      events: [],
    });
    expect(events).toContainEqual({
      threads: threads.snapshot(),
      type: "threads",
    });
  });

  test("loads history once and sends it only in requested pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-pages-"));
    roots.push(root);
    const gate = deferred<boolean>();
    const broadcast: unknown[] = [];
    let loads = 0;
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () => await Promise.resolve(acpSession("session-1")),
        load: async () => {
          loads += 1;
          threads.event({
            agentId: "magpi-acp",
            sessionId: "session-1",
            type: "acpUpdate",
            update: {
              content: { text: "History", type: "text" },
              sessionUpdate: "agent_message_chunk",
            },
          });
          await gate.promise;
          return acpSession("session-1");
        },
        prompt: async () => await Promise.resolve("completed" as const),
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      (event) => {
        broadcast.push(event);
      }
    );
    const id = "123e4567-e89b-4d3a-a456-426614174010";
    await threads.adopt("magpi-acp", "/workspace", id, "session-1");
    const first = threads.transcript(id);
    const second = threads.transcript(id);
    await vi.waitFor(() => {
      expect(loads).toBe(1);
    });
    expect(
      broadcast.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "acpUpdate"
      )
    ).toBeFalsy();
    gate.resolve(true);
    const pages = await Promise.all([first, second]);
    expect(pages.map((page) => page.events.length)).toStrictEqual([1, 1]);
  });

  test("recovers an Agent title from history without overriding a manual name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-title-"));
    roots.push(root);
    let historyCalls = 0;
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () => await Promise.resolve(acpSession("session-1")),
        history: async () => {
          historyCalls += 1;
          return await Promise.resolve([
            { sessionId: "session-1", title: "Agent title" },
          ]);
        },
        load: async () => await Promise.resolve(acpSession("session-1")),
        prompt: async () => await Promise.resolve("completed" as const),
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      () => {}
    );
    const created = await threads.create("magpi-acp", "/workspace");
    await threads.prompt(created.id, "First");
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({
        name: "Agent title",
        status: "idle",
      });
    });
    await threads.rename(created.id, "My name");
    await threads.prompt(created.id, "Second");
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({
        manualName: true,
        name: "My name",
        status: "idle",
      });
    });
    expect(historyCalls).toBe(1);
  });

  test("forks a message into one durable Host-owned Thread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-fork-"));
    roots.push(root);
    const calls: string[] = [];
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () =>
          await Promise.resolve({
            ...acpSession("source-session"),
            operations: {
              branchSummary: false,
              forkMessage: true,
              treeNavigation: false,
            },
          }),
        forkMessage: async (_agent, sessionId, cwd, messageId) => {
          calls.push(`${sessionId}:${cwd}:${messageId}`);
          return await Promise.resolve({
            ...acpSession("fork-session"),
            operations: {
              branchSummary: false,
              forkMessage: true,
              treeNavigation: false,
            },
          });
        },
        load: async () => await Promise.resolve(acpSession("source-session")),
        prompt: async () => await Promise.resolve("completed" as const),
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      () => {}
    );
    const sourceId = "123e4567-e89b-4d3a-a456-426614174001";
    const forkId = "123e4567-e89b-4d3a-a456-426614174002";
    await threads.create("magpi-acp", "/workspace", sourceId);
    await expect(
      threads.forkMessage(sourceId, forkId, "user-message-1")
    ).resolves.toMatchObject({
      id: forkId,
      name: "New Thread (fork)",
      owner: "host",
      sessionId: "fork-session",
    });
    expect(calls).toStrictEqual(["source-session:/workspace:user-message-1"]);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, "profile-db-v1/threads", `${forkId}.json`),
          "utf-8"
        )
      )
    ).toMatchObject({
      id: forkId,
      sessionId: "fork-session",
    });
    await expect(
      threads.forkMessage(sourceId, forkId, "other")
    ).rejects.toThrow("already exists");
    await expect(
      threads.forkMessage(sourceId, "not-a-uuid", "other")
    ).rejects.toThrow("Invalid Thread fork");
  });

  test("adopts an Agent history session under a canonical Thread ID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-threads-"));
    roots.push(root);
    const loads: string[] = [];
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () => await Promise.resolve(acpSession("unused")),
        load: async (_agentId, sessionId) => {
          loads.push(sessionId);
          return await Promise.resolve(acpSession(sessionId));
        },
        prompt: async () => await Promise.resolve("completed" as const),
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      () => {}
    );
    const id = "123e4567-e89b-4d3a-a456-426614174001";

    await expect(
      threads.adopt("codex-acp", "/workspace", id, "history-session")
    ).resolves.toMatchObject({ id, owner: "host" });
    await threads.load(id);
    expect(loads).toStrictEqual(["history-session"]);
    threads.event({
      agentId: "codex-acp",
      sessionId: "history-session",
      type: "acpUpdate",
      update: {
        content: { text: "Restored", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
    await expect(threads.transcript(id)).resolves.toMatchObject({
      cursor: null,
      events: [
        {
          threadId: id,
          type: "acpUpdate",
          update: { sessionUpdate: "agent_message_chunk" },
        },
      ],
    });
    for (let index = 0; index < 300; index += 1) {
      threads.event({
        agentId: "codex-acp",
        sessionId: "history-session",
        type: "acpUpdate",
        update: {
          content: { text: String(index), type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      });
    }
    const latest = await threads.transcript(id);
    const older = await threads.transcript(id, latest.cursor ?? undefined);
    const smallPage = {
      latestCount: latest.events.length,
      latestCursor: latest.cursor,
      olderCount: older.events.length,
      olderCursor: older.cursor,
    };
    for (let index = 0; index < 300; index += 1) {
      threads.event({
        agentId: "codex-acp",
        sessionId: "history-session",
        type: "acpUpdate",
        update: {
          content: { text: "x".repeat(40_000), type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      });
    }
    let cursor: number | null | undefined;
    let received = 0;
    let largest = 0;
    do {
      // oxlint-disable-next-line no-await-in-loop -- each cursor depends on the previous page.
      const page = await threads.transcript(id, cursor ?? undefined);
      received += page.events.length;
      largest = Math.max(largest, Buffer.byteLength(JSON.stringify(page)));
      ({ cursor } = page);
    } while (cursor !== null);
    expect({
      received,
      smallPage,
      underLimit: largest < 8 * 1024 * 1024,
    }).toStrictEqual({
      received: 601,
      smallPage: {
        latestCount: 256,
        latestCursor: 45,
        olderCount: 45,
        olderCursor: null,
      },
      underLimit: true,
    });
    await expect(
      threads.adopt("codex-acp", "/other", id, "history-session")
    ).rejects.toThrow("already exists");
  });

  test("keeps a Thread durable when its first ACP session fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-threads-"));
    roots.push(root);
    let creates = 0;
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () => {
          creates += 1;
          if (creates === 1) {
            throw new Error("Agent unavailable");
          }
          return await Promise.resolve(acpSession("session-retry"));
        },
        load: async () => await Promise.resolve(acpSession("session-retry")),
        prompt: async () => await Promise.resolve("completed" as const),
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      () => {}
    );
    const requestedId = "123e4567-e89b-4d3a-a456-426614174000";
    const created = await threads.create(
      "magpi-acp",
      "/workspace",
      requestedId
    );
    expect(created).toMatchObject({
      error: "Agent unavailable",
      id: requestedId,
      status: "error",
    });
    expect(created.sessionId).toBeUndefined();
    await expect(threads.prompt(created.id, "Retry")).resolves.toMatchObject({
      position: 1,
    });
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({
        sessionId: "session-retry",
        status: "idle",
      });
    });
  });

  test("keeps an Agent-generated Thread name after Host restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-title-"));
    roots.push(root);
    const acp = {
      cancel: async () => {
        await Promise.resolve();
      },
      create: async () => await Promise.resolve(acpSession("session-title")),
      load: async () => await Promise.resolve(acpSession("session-title")),
      prompt: async () => await Promise.resolve("completed" as const),
      setConfig: async () => {
        await Promise.resolve();
      },
    };
    const threads = await HostThreads.open(root, acp, () => {});
    const created = await threads.create("magpi-acp", "/workspace");
    threads.event({
      agentId: "magpi-acp",
      sessionId: "session-title",
      type: "acpUpdate",
      update: { sessionUpdate: "session_info_update", title: "Fix cwd" },
    });
    await vi.waitFor(async () => {
      const restored = await HostThreads.open(root, acp, () => {});
      expect(restored.snapshot()[0]?.name).toBe("Fix cwd");
    });
    await threads.rename(created.id, "My title");
    threads.event({
      agentId: "magpi-acp",
      sessionId: "session-title",
      type: "acpUpdate",
      update: {
        sessionUpdate: "session_info_update",
        title: "Later Agent title",
      },
    });
    const restored = await HostThreads.open(root, acp, () => {});
    expect(restored.snapshot()[0]?.name).toBe("My title");
  });

  test("renames, retries, and removes an idle Thread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-threads-"));
    roots.push(root);
    let prompts = 0;
    const events: unknown[] = [];
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () => await Promise.resolve(acpSession("session-1")),
        load: async () => await Promise.resolve(acpSession("session-1")),
        prompt: async () => {
          prompts += 1;
          if (prompts === 1) {
            throw new Error("Turn failed");
          }
          return await Promise.resolve("completed" as const);
        },
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      (event) => {
        events.push(event);
      }
    );
    const created = await threads.create("magpi-acp", "/workspace");
    await threads.rename(created.id, "  Renamed Thread  ");
    expect(threads.snapshot()[0]).toMatchObject({
      manualName: true,
      name: "Renamed Thread",
    });
    await threads.prompt(created.id, "Try again");
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({
        retryText: "Try again",
        status: "error",
      });
    });
    await threads.retry(created.id);
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({ status: "idle" });
    });
    expect(prompts).toBe(2);
    await threads.remove(created.id);
    expect({
      events: events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          (event.type === "threadRenamed" || event.type === "threadRemoved")
      ),
      snapshot: threads.snapshot(),
    }).toStrictEqual({
      events: [
        {
          name: "Renamed Thread",
          threadId: created.id,
          type: "threadRenamed",
        },
        { threadId: created.id, type: "threadRemoved" },
      ],
      snapshot: [],
    });
  });

  test("cancels while a failed Thread is recreating its session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-threads-"));
    roots.push(root);
    const session = deferred<ReturnType<typeof acpSession>>();
    let creates = 0;
    let prompts = 0;
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          await Promise.resolve();
        },
        create: async () => {
          creates += 1;
          if (creates === 1) {
            throw new Error("Agent unavailable");
          }
          return await session.promise;
        },
        load: async () => await Promise.resolve(acpSession("session-retry")),
        prompt: async () => {
          prompts += 1;
          return await Promise.resolve("completed" as const);
        },
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      () => {}
    );
    const created = await threads.create("magpi-acp", "/workspace");
    await threads.prompt(created.id, "Retry");
    await vi.waitFor(() => {
      expect(creates).toBe(2);
    });
    await threads.cancel(created.id);
    session.resolve(acpSession("session-retry"));
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({ status: "idle" });
    });
    expect(prompts).toBe(0);
  });

  test("runs queued prompts in order and returns queued text on cancel", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-threads-"));
    roots.push(root);
    const turns = [
      deferred<"cancelled" | "completed">(),
      deferred<"cancelled" | "completed">(),
    ];
    const prompts: string[] = [];
    const events: unknown[] = [];
    const threads = await HostThreads.open(
      root,
      {
        cancel: async () => {
          turns[1]?.resolve("cancelled");
          await Promise.resolve();
        },
        create: async () => await Promise.resolve(acpSession("session-1")),
        load: async () => await Promise.resolve(acpSession("session-1")),
        prompt: async (_agentId, _sessionId, text) => {
          prompts.push(text);
          const turn = turns.at(prompts.length - 1);
          if (!turn) {
            throw new Error("Unexpected prompt");
          }
          return await turn.promise;
        },
        setConfig: async () => {
          await Promise.resolve();
        },
      },
      (event) => {
        events.push(event);
      }
    );
    const created = await threads.create("magpi-acp", "/workspace");
    await expect(threads.prompt(created.id, "First")).resolves.toMatchObject({
      position: 1,
    });
    await expect(threads.prompt(created.id, "Second")).resolves.toMatchObject({
      position: 2,
    });
    await expect(threads.prompt(created.id, "Third")).resolves.toMatchObject({
      position: 3,
    });
    await vi.waitFor(() => {
      expect(prompts).toStrictEqual(["First"]);
    });
    turns[0]?.resolve("completed");
    await vi.waitFor(() => {
      expect(prompts).toStrictEqual(["First", "Second"]);
    });
    await threads.cancel(created.id);
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({ status: "idle" });
    });
    expect(events).toContainEqual({
      drafts: ["Third"],
      threadId: created.id,
      type: "threadQueueCleared",
    });
  });

  test("persists ownership and marks a crashed turn interrupted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-threads-"));
    roots.push(root);
    const turn = deferred<"cancelled" | "completed">();
    const loads: string[] = [];
    const acp = {
      cancel: async () => {
        await Promise.resolve();
      },
      create: async () => await Promise.resolve(acpSession("session-1")),
      load: async (_agentId: string, sessionId: string) => {
        await Promise.resolve();
        loads.push(sessionId);
        return acpSession(sessionId);
      },
      prompt: async () => await turn.promise,
      setConfig: async () => {
        await Promise.resolve();
      },
    };
    const threads = await HostThreads.open(root, acp, () => {});
    const created = await threads.create("magpi-acp", "/workspace");
    await threads.prompt(created.id, "Keep working");
    const recordPath = path.join(
      root,
      "profile-db-v1/threads",
      `${created.id}.json`
    );
    await vi.waitFor(async () => {
      const record: unknown = JSON.parse(await readFile(recordPath, "utf-8"));
      expect(record).toMatchObject({
        agentId: "magpi-acp",
        sessionId: "session-1",
        status: "running",
        workspace: "/workspace",
      });
    });

    const restarted = await HostThreads.open(root, acp, () => {});
    expect(restarted.snapshot()).toMatchObject([
      {
        error: "Host stopped during an active turn",
        id: created.id,
        status: "error",
      },
    ]);
    await restarted.load(created.id);
    expect(loads).toStrictEqual(["session-1"]);
    expect(restarted.snapshot()[0]).toMatchObject({ status: "error" });
    turn.resolve("completed");
    await vi.waitFor(() => {
      expect(threads.snapshot()[0]).toMatchObject({ status: "idle" });
    });
  });
});
