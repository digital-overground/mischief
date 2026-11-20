import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, test } from "vitest";

import {
  snapshot,
  selectThread,
  activateWorkspace,
  deactivateWorkspace,
} from "./library.js";

describe("Default profile database", () => {
  test("Default profile snapshot groups only active existing Workspaces and counts attention", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "mischief-library-"))
    );
    try {
      const workspace = path.join(root, "checkout");
      await mkdir(workspace);
      await mkdir(path.join(root, "workspaces"));
      await mkdir(path.join(root, "threads"));
      const name = `${createHash("sha256").update(workspace).digest("hex")}.json`;
      await writeFile(
        path.join(root, "workspaces", name),
        JSON.stringify({
          path: workspace,
          status: "active",
          version: 1,
          writtenAt: 1,
        })
      );
      const id = "11111111-1111-4111-8111-111111111111";
      await writeFile(
        path.join(root, "threads", `${id}.json`),
        JSON.stringify({
          id,
          name: "Needs help",
          owner: "host",
          status: "waiting",
          updatedAt: new Date().toISOString(),
          version: 1,
          workspace,
          writtenAt: 1,
        })
      );
      const result = await snapshot(root);
      assert.equal(result.attention, 1);
      assert.equal(result.workspaces[0].threads[0].name, "Needs help");
      assert.equal(result.workspaces[0].threads[0].owner, "host");
      await selectThread(workspace, id, root);
      const selected: unknown = JSON.parse(
        await readFile(path.join(root, "selections", name), "utf-8")
      );
      assert.ok(
        typeof selected === "object" &&
          selected !== null &&
          "threadId" in selected &&
          "focusRequest" in selected &&
          typeof selected.focusRequest === "string"
      );
      assert.equal(selected.threadId, id);
      assert.match(selected.focusRequest, /^[0-9a-f-]{36}$/u);
      await assert.rejects(
        selectThread(workspace, "22222222-2222-4222-8222-222222222222", root)
      );
      await writeFile(
        path.join(root, "workspaces", name),
        JSON.stringify({
          path: workspace,
          status: "inactive",
          version: 1,
          writtenAt: 2,
        })
      );
      const after = await snapshot(root);
      assert.equal(after.attention, 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("adding a Git folder groups it under its Project; deactivation hides it", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "mischief-workspace-"))
    );
    const folder = path.join(root, "project");
    try {
      await mkdir(folder);
      execFileSync("git", ["-C", folder, "init", "-q"]);
      await activateWorkspace(folder, root);
      const current = await snapshot(root);
      assert.equal(current.workspaces[0].projectRoot, folder);
      execFileSync("git", [
        "-C",
        folder,
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Test",
        "commit",
        "--allow-empty",
        "-qm",
        "init",
      ]);
      const linked = path.join(root, "linked");
      execFileSync("git", [
        "-C",
        folder,
        "worktree",
        "add",
        "-qb",
        "feature",
        linked,
      ]);
      await activateWorkspace(linked, root);
      const grouped = await snapshot(root);
      assert.equal(
        grouped.workspaces.find((w) => w.path === linked)?.projectRoot,
        folder
      );
      await deactivateWorkspace(linked, root);
      await deactivateWorkspace(folder, root);
      const after = await snapshot(root);
      assert.equal(after.workspaces.length, 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("Host notifies only on a new attention transition, not on initial load", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "mischief-attention-"))
    );
    const workspace = path.join(root, "checkout");
    const id = "11111111-1111-4111-8111-111111111111";
    const name = `${createHash("sha256").update(workspace).digest("hex")}.json`;
    let child;
    try {
      await mkdir(workspace);
      await mkdir(path.join(root, "workspaces"));
      await mkdir(path.join(root, "threads"));
      await writeFile(
        path.join(root, "workspaces", name),
        JSON.stringify({
          path: workspace,
          status: "active",
          version: 1,
          writtenAt: 1,
        })
      );
      const threadFile = path.join(root, "threads", `${id}.json`);
      const thread = {
        id,
        name: "Needs help",
        status: "waiting",
        updatedAt: new Date().toISOString(),
        version: 1,
        workspace,
        writtenAt: 1,
      };
      await writeFile(threadFile, JSON.stringify(thread));
      child = spawn(
        process.execPath,
        [
          new URL(
            "dist/Mischief.app/Contents/Resources/Host.mjs",
            import.meta.url
          ).pathname,
        ],
        {
          env: { ...process.env, MISCHIEF_PROFILE_DB: root },
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      await sleep(300);
      assert.equal(
        output.split("\n").filter((line) => line.includes('"type":"attention"'))
          .length,
        0
      );
      await writeFile(
        threadFile,
        JSON.stringify({
          ...thread,
          status: "idle",
          unread: false,
          writtenAt: 2,
        })
      );
      await sleep(1050);
      await writeFile(
        threadFile,
        JSON.stringify({ ...thread, status: "waiting", writtenAt: 3 })
      );
      await sleep(1050);
      assert.equal(
        output.split("\n").filter((line) => line.includes('"type":"attention"'))
          .length,
        1
      );
    } finally {
      if (child) {
        child.kill();
        await once(child, "exit");
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});
