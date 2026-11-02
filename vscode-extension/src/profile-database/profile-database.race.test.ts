import { mkdtemp, rm } from "node:fs/promises";
import type * as FileSystemPromises from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { describe, expect, test, vi } from "vitest";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolver!: () => void;
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolver();
    },
  };
};

const controls = vi.hoisted(() => ({
  blockWorkspaceRead: false,
  onWorkspaceRead: () => {},
  workspaceDirectory: "",
  workspaceReadReleased: Promise.resolve(),
}));

vi.mock(import("node:fs/promises"), async () => {
  const actual =
    await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
  const readdir = async (...args: unknown[]) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double boundary
    const [directory, options] = args as [string, { withFileTypes: true }];
    const entries = await actual.readdir(directory, options);
    if (
      controls.blockWorkspaceRead &&
      directory === controls.workspaceDirectory
    ) {
      controls.blockWorkspaceRead = false;
      controls.onWorkspaceRead();
      await controls.workspaceReadReleased;
    }
    return entries;
  };
  return {
    ...actual,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double boundary
    readdir: readdir as typeof actual.readdir,
  };
});

const { ProfileDatabase } = await import("./profile-database");

describe("ProfileDatabase synchronization", () => {
  test("a Workspace write waits for a refresh that already started", async () => {
    const profileDirectory = await mkdtemp("/tmp/mischief-profile-database-");
    const workspaceDirectory = path.join(
      profileDirectory,
      "profile-db-v1",
      "workspaces"
    );
    const root = path.join(profileDirectory, "root");
    const linked = path.join(profileDirectory, "linked");
    const database = await ProfileDatabase.open({
      instanceId: "00000000-0000-4000-8000-000000000001",
      log: () => {},
      profileDirectory,
    });
    const workspaceReadStarted = deferred();
    const workspaceReadReleased = deferred();
    controls.workspaceDirectory = workspaceDirectory;
    controls.onWorkspaceRead = workspaceReadStarted.resolve;
    controls.workspaceReadReleased = workspaceReadReleased.promise;

    try {
      controls.blockWorkspaceRead = true;
      await database.apply({
        type: "activateWorkspace",
        workspace: { path: root },
      });
      await workspaceReadStarted.promise;

      let linkedApplied = false;
      const activateLinked = database
        .apply({
          type: "activateWorkspace",
          workspace: { path: linked },
        })
        .then(() => {
          linkedApplied = true;
        });
      await setTimeout(10);
      expect(linkedApplied).toBeFalsy();
      workspaceReadReleased.resolve();
      await activateLinked;

      expect(
        database.snapshot().workspaces.map(({ path: workspace }) => workspace)
      ).toStrictEqual([linked, root]);
    } finally {
      await database.dispose();
      await rm(profileDirectory, { force: true, recursive: true });
    }
  });
});
