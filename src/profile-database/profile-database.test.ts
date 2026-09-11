import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { ProfileDatabase } from "./profile-database";

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

  test("an owning Instance shares read-only Thread and selection records", async () => {
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
      ).rejects.toThrow("owning Workspace");
    } finally {
      await Promise.all([owner.dispose(), reader.dispose()]);
      await rm(profileDirectory, { force: true, recursive: true });
      vi.useRealTimers();
    }
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

      expect(database.snapshot()).toMatchObject({
        selections: [
          { threadId: firstId, workspace: firstWorkspace },
          { threadId: secondId, workspace: secondWorkspace },
        ],
        threads: [
          {
            ...previous.threads[0],
            status: "error",
          },
          {
            ...previous.threads[1],
            status: "idle",
          },
        ],
      });
    } finally {
      await database.dispose();
      await rm(profileDirectory, { force: true, recursive: true });
    }
  });
});
