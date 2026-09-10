import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { ProfileSync } from "./profile-sync";

const openPair = async () => {
  vi.useFakeTimers();
  const profileDirectory = await mkdtemp(
    path.join(tmpdir(), "mischief-profile-sync-")
  );
  const log = vi.fn<(message: string) => void>();
  const first = await ProfileSync.open({
    instanceId: "00000000-0000-4000-8000-000000000001",
    log,
    profileDirectory,
    workspace: path.join(profileDirectory, "first-workspace"),
  });
  const second = await ProfileSync.open({
    instanceId: "00000000-0000-4000-8000-000000000002",
    log,
    profileDirectory,
    workspace: path.join(profileDirectory, "second-workspace"),
  });
  return { first, profileDirectory, second };
};

describe(ProfileSync, () => {
  test("membership added by one Instance becomes visible to another Instance", async () => {
    const { first, profileDirectory, second } = await openPair();

    try {
      const previous = second.snapshot();
      let changed = false;
      second.onChange(() => {
        changed = true;
      });
      const workspacePath = path.join(profileDirectory, "shared-workspace");

      await first.apply({
        membership: {
          kind: "untracked",
          path: workspacePath,
          state: "active",
        },
        type: "putMembership",
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(changed).toBeTruthy();
      });

      expect(second.snapshot().memberships).toStrictEqual([
        { kind: "untracked", path: workspacePath, state: "active" },
      ]);
      expect(previous.memberships).toStrictEqual([]);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await rm(profileDirectory, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });

  test("removing membership in one Instance marks it removed in another Instance", async () => {
    const { first, profileDirectory, second } = await openPair();

    try {
      const workspacePath = path.join(profileDirectory, "shared-workspace");
      await first.apply({
        membership: {
          kind: "untracked",
          path: workspacePath,
          state: "active",
        },
        type: "putMembership",
      });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(second.snapshot().memberships).toStrictEqual([
          { kind: "untracked", path: workspacePath, state: "active" },
        ]);
      });

      await first.apply({ path: workspacePath, type: "removeMembership" });
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(second.snapshot().memberships).toStrictEqual([
          { kind: "untracked", path: workspacePath, state: "removed" },
        ]);
      });
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
      await rm(profileDirectory, { force: true, recursive: true });
      vi.useRealTimers();
    }
  });
});
