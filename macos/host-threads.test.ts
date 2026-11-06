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
