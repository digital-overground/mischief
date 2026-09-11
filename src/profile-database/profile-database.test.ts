import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { ProfileDatabase } from "./profile-database";

describe(ProfileDatabase, () => {
  test("another Instance observes a Workspace activate and become inactive on close", async () => {
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

      await first.dispose();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(second.snapshot().workspaces).toStrictEqual([
          { path: workspacePath, status: "inactive" },
        ]);
      });
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await rm(profileDirectory, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });
});
