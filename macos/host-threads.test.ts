import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { HostThreads } from "./host-threads";

const roots: string[] = [];
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
          return await Promise.resolve("session-retry");
        },
        load: async () => {
          await Promise.resolve();
        },
        prompt: async () => await Promise.resolve("completed" as const),
      },
      () => {}
    );
    const created = await threads.create("magpi-acp", "/workspace");
    expect(created).toMatchObject({
      error: "Agent unavailable",
      status: "error",
    });
    expect(created.sessionId).toBeUndefined();
    await expect(threads.prompt(created.id, "Retry")).resolves.toBe(
      "completed"
    );
    expect(threads.snapshot()[0]).toMatchObject({
      sessionId: "session-retry",
      status: "idle",
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
      create: async () => await Promise.resolve("session-1"),
      load: async (_agentId: string, sessionId: string) => {
        await Promise.resolve();
        loads.push(sessionId);
      },
      prompt: async () => await turn.promise,
    };
    const threads = await HostThreads.open(root, acp, () => {});
    const created = await threads.create("magpi-acp", "/workspace");
    const prompt = threads.prompt(created.id, "Keep working");
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
    expect(restarted.snapshot()[0]).toMatchObject({ status: "idle" });
    turn.resolve("completed");
    await expect(prompt).resolves.toBe("completed");
  });
});
