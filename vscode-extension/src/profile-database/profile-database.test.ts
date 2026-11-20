import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { testValue } from "../test-value";
import type { DatabaseThread } from "./profile-database";
import {
  ProfileDatabase,
  stripLegacyThreadAuthentication,
} from "./profile-database";

describe(ProfileDatabase, () => {
  test("Instances observe activation and any Instance may deactivate", async () => {
    vi.useFakeTimers();
    const profileDirectory = await mkdtemp(
      path.join(tmpdir(), "mischief-profile-database-")
    );
    const workspacePath = path.join(profileDirectory, "workspace");
    const log = vi.fn<(message: string) => void>();
    const first = await ProfileDatabase.open({
      currentWorkspace: workspacePath,
      instanceId: "00000000-0000-4000-8000-000000000001",
      log,
      profileDirectory,
    });
    const second = await ProfileDatabase.open({
      currentWorkspace: path.join(profileDirectory, "other-workspace"),
      instanceId: "00000000-0000-4000-8000-000000000002",
      log,
      profileDirectory,
    });

    try {
      const previous = second.snapshot();
      let changed = false;
      second.onChange(() => {
        changed = true;
      });

      await first.apply({
        type: "activateWorkspace",
        workspace: { path: workspacePath },
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(changed).toBeTruthy();
      });

      expect(second.snapshot().workspaces).toStrictEqual([
        { path: workspacePath, status: "active" },
      ]);
      expect(previous.workspaces).toStrictEqual([]);

      await second.apply({
        path: workspacePath,
        type: "deactivateWorkspace",
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(first.snapshot().workspaces).toStrictEqual([
          { path: workspacePath, status: "inactive" },
        ]);
      });
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await rm(profileDirectory, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  test("an owning Instance receives a remote focus request with polling fallback", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const profileDirectory = await mkdtemp(
      path.join(tmpdir(), "mischief-profile-database-")
    );
    const workspace = path.join(profileDirectory, "workspace");
    const owner = await ProfileDatabase.open({
      currentWorkspace: workspace,
      instanceId: "00000000-0000-4000-8000-000000000001",
      log: vi.fn<(message: string) => void>(),
      profileDirectory,
    });
    let source: ProfileDatabase | undefined;
    const threadId = "10000000-0000-4000-8000-000000000001";
    const request = "20000000-0000-4000-8000-000000000001";
    try {
      await owner.apply({
        thread: {
          createdAt: "2026-09-11T12:00:00.000Z",
          id: threadId,
          name: "Shared Thread",
          status: "idle",
          updatedAt: "2026-09-11T12:00:00.000Z",
          workspace,
        },
        type: "putThread",
      });
      source = await ProfileDatabase.open({
        currentWorkspace: path.join(profileDirectory, "other"),
        instanceId: "00000000-0000-4000-8000-000000000002",
        log: vi.fn<(message: string) => void>(),
        profileDirectory,
      });
      await source.apply({
        focusRequest: request,
        threadId,
        type: "selectThread",
        workspace,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(owner.snapshot().selections).toStrictEqual([
          { focusRequest: request, threadId, workspace },
        ]);
      });
    } finally {
      await Promise.all([owner.dispose(), source?.dispose()]);
      await rm(profileDirectory, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  test("any Instance may select a valid foreign Thread but cannot mutate it", async () => {
    vi.useFakeTimers();
    const profileDirectory = await mkdtemp(
      path.join(tmpdir(), "mischief-profile-database-")
    );
    const workspacePath = path.join(profileDirectory, "workspace");
    const owner = await ProfileDatabase.open({
      currentWorkspace: workspacePath,
      instanceId: "00000000-0000-4000-8000-000000000001",
      log: vi.fn<(message: string) => void>(),
      profileDirectory,
    });
    const reader = await ProfileDatabase.open({
      currentWorkspace: path.join(profileDirectory, "other-workspace"),
      instanceId: "00000000-0000-4000-8000-000000000002",
      log: vi.fn<(message: string) => void>(),
      profileDirectory,
    });
    const thread = {
      createdAt: "2026-09-11T12:00:00.000Z",
      id: "10000000-0000-4000-8000-000000000001",
      name: "Shared Thread",
      status: "waiting" as const,
      updatedAt: "2026-09-11T12:01:00.000Z",
      workspace: workspacePath,
    };

    try {
      await owner.apply({ thread, type: "putThread" });
      await owner.apply({
        threadId: thread.id,
        type: "selectThread",
        workspace: workspacePath,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(reader.snapshot()).toMatchObject({
          selections: [{ threadId: thread.id, workspace: workspacePath }],
          threads: [thread],
        });
      });
      await expect(
        reader.apply({
          thread: { ...thread, name: "Foreign write" },
          type: "putThread",
        })
      ).rejects.toThrow("owning Workspace");
      await expect(
        reader.apply({ id: thread.id, type: "removeThread" })
      ).rejects.toThrow("owning Workspace");
      await expect(
        reader.apply({
          threadId: thread.id,
          type: "selectThread",
          workspace: workspacePath,
        })
      ).resolves.toBeUndefined();
      expect(reader.snapshot().selections).toStrictEqual([
        { threadId: thread.id, workspace: workspacePath },
      ]);
    } finally {
      await Promise.all([owner.dispose(), reader.dispose()]);
      await rm(profileDirectory, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  test("cleans authentication from existing Thread files without losing Thread data", async () => {
    const profileDirectory = await mkdtemp(
      path.join(tmpdir(), "mischief-profile-database-")
    );
    const threadsDirectory = path.join(
      profileDirectory,
      "profile-db-v1",
      "threads"
    );
    const id = "10000000-0000-4000-8000-000000000001";
    const filename = path.join(threadsDirectory, `${id}.json`);
    const workspace = path.join(profileDirectory, "workspace");
    const record = {
      authentication: {
        args: ["--token", "secret"],
        command: "agent",
        env: { TOKEN: "secret" },
        label: "Log in",
      },
      createdAt: "2026-09-11T12:00:00.000Z",
      error: "Login required",
      id,
      name: "Saved Thread",
      retryText: "Try again",
      status: "error",
      updatedAt: "2026-09-11T12:01:00.000Z",
      version: 1,
      workspace,
      writtenAt: Date.now(),
    };
    await mkdir(threadsDirectory, { recursive: true });
    await writeFile(filename, JSON.stringify(record));
    const database = await ProfileDatabase.open({
      currentWorkspace: workspace,
      instanceId: "00000000-0000-4000-8000-000000000001",
      log: vi.fn<(message: string) => void>(),
      profileDirectory,
    });
    try {
      expect(database.snapshot().threads[0]).toMatchObject({
        agentId: "magpi-acp",
        error: "Login required",
        id,
        name: "Saved Thread",
        retryText: "Try again",
      });
      expect(database.snapshot().threads[0]).not.toHaveProperty(
        "authentication"
      );
      const cleaned = await readFile(filename, "utf-8");
      expect(JSON.parse(cleaned)).toStrictEqual(
        expect.objectContaining({
          id,
          name: "Saved Thread",
          retryText: "Try again",
        })
      );
      expect(cleaned).not.toContain("secret");
    } finally {
      await database.dispose();
      await rm(profileDirectory, { force: true, recursive: true });
    }
  });

  test("strips only authentication from the legacy rollback copy", () => {
    const original = {
      selected: { "/workspace": "thread-1" },
      threads: [
        { authentication: { env: { TOKEN: "secret" } }, id: "thread-1" },
        { id: "thread-2" },
      ],
    };
    expect(stripLegacyThreadAuthentication(original)).toStrictEqual({
      selected: original.selected,
      threads: [{ id: "thread-1" }, { id: "thread-2" }],
    });
    expect(original.threads[0]).toHaveProperty("authentication");
    const clean = { threads: [{ id: "thread-1" }] };
    expect(stripLegacyThreadAuthentication(clean)).toBe(clean);
  });

  test("imports legacy Thread registrations and selections exactly once", async () => {
    const profileDirectory = await mkdtemp(
      path.join(tmpdir(), "mischief-profile-database-")
    );
    const firstWorkspace = path.join(profileDirectory, "first-workspace");
    const secondWorkspace = path.join(profileDirectory, "second-workspace");
    const database = await ProfileDatabase.open({
      currentWorkspace: firstWorkspace,
      instanceId: "00000000-0000-4000-8000-000000000001",
      log: vi.fn<(message: string) => void>(),
      profileDirectory,
    });
    const firstId = "10000000-0000-4000-8000-000000000001";
    const secondId = "10000000-0000-4000-8000-000000000002";
    const previous = {
      selected: {
        [firstWorkspace]: firstId,
        [secondWorkspace]: secondId,
      },
      threads: [
        {
          authentication: {
            args: ["--login"],
            command: "magpi-acp",
            env: { TOKEN: "redacted" },
            label: "Authenticate",
          },
          createdAt: "2026-09-11T12:00:00.000Z",
          error: "Authentication required",
          id: firstId,
          manualName: true,
          name: "First Thread",
          retryText: "Try again",
          sessionId: "session-1",
          unread: true,
          updatedAt: "2026-09-11T12:01:00.000Z",
          usage: { size: 200, used: 100 },
          workspace: firstWorkspace,
        },
        {
          createdAt: "2026-09-11T13:00:00.000Z",
          id: secondId,
          name: "Second Thread",
          updatedAt: "2026-09-11T13:01:00.000Z",
          workspace: secondWorkspace,
        },
      ],
    };

    try {
      await database.importPreviousThreads(previous);
      await database.importPreviousThreads({
        ...previous,
        threads: previous.threads.map((thread) => ({
          ...thread,
          name: "Must not replace imported data",
        })),
      });

      await expect(
        database.apply({
          thread: testValue<DatabaseThread>({
            ...previous.threads[0],
            agentId: "unapproved-acp",
            status: "idle",
          }),
          type: "putThread",
        })
      ).rejects.toThrow("Thread is invalid");
      expect(database.snapshot()).toMatchObject({
        selections: [
          { threadId: firstId, workspace: firstWorkspace },
          { threadId: secondId, workspace: secondWorkspace },
        ],
        threads: [
          {
            agentId: "magpi-acp",
            error: "Authentication required",
            id: firstId,
            manualName: true,
            name: "First Thread",
            retryText: "Try again",
            status: "error",
            usage: { size: 200, used: 100 },
          },
          {
            ...previous.threads[1],
            agentId: "magpi-acp",
            status: "idle",
          },
        ],
      });
      expect(database.snapshot().threads[0]).not.toHaveProperty(
        "authentication"
      );
      const filename = path.join(
        profileDirectory,
        "profile-db-v1",
        "threads",
        `${firstId}.json`
      );
      await expect(readFile(filename, "utf-8")).resolves.not.toContain("TOKEN");
      await database.apply({
        thread: testValue<DatabaseThread>({
          ...previous.threads[0],
          status: "error",
        }),
        type: "putThread",
      });
      await expect(readFile(filename, "utf-8")).resolves.not.toContain("TOKEN");
    } finally {
      await database.dispose();
      await rm(profileDirectory, { force: true, recursive: true });
    }
  });
});
