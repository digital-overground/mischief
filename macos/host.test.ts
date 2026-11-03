import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, test } from "vitest";

const binary = new URL(
  "dist/Mischief.app/Contents/Resources/node",
  import.meta.url
).pathname;
const script = new URL(
  "dist/Mischief.app/Contents/Resources/Host.mjs",
  import.meta.url
).pathname;
const app = new URL(
  "dist/Mischief.app/Contents/MacOS/Mischief",
  import.meta.url
).pathname;
const waitForExit = async (child: ChildProcess): Promise<unknown> => {
  const result: unknown[] = await once(child, "exit");
  assert.equal(result[1], null);
  return result[0];
};

// The packaged executable, not the development Node runtime, is exercised here.
describe("signed macOS app", () => {
  test("Host exchanges commands on stdin/stdout", async () => {
    const child = spawn(binary, [script], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (data: string) => {
      output += data;
    });
    child.stdin.write(
      `${JSON.stringify({ action: "notify", type: "command" })}\n`
    );
    child.stdin.write(
      `${JSON.stringify({ action: "navigate", type: "command", view: "diagnostic" })}\n`
    );
    child.stdin.end();
    assert.equal(await waitForExit(child), 0);
    const messages: unknown[] = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    assert.ok(
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "pid" in message &&
          message.pid === child.pid
      )
    );
    assert.ok(
      messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "notify" &&
          "view" in message &&
          message.view === "diagnostic"
      )
    );
  });

  test("initial library snapshot reaches React", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-empty-library-"));
    try {
      const child = spawn(app, ["--smoke-library"], {
        env: { ...process.env, MISCHIEF_PROFILE_DB: root },
        stdio: "ignore",
      });
      assert.equal(await waitForExit(child), 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("window closes and reopens without crashing", async () => {
    const child = spawn(app, ["--smoke-close"], { stdio: "ignore" });
    assert.equal(await waitForExit(child), 0);
  });
});
