import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, test } from "vitest";

import { writeClient } from "./host-output.js";

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
let jobId = 0;
const backgroundHostEnvironment = (root: string) => {
  const label = `works.digitaloverground.mischief.host.test.${process.pid}.${jobId}`;
  jobId += 1;
  return {
    env: {
      ...process.env,
      MISCHIEF_HOST_INSTALL_ROOT: path.join(root, "Host"),
      MISCHIEF_HOST_JOB_LABEL: label,
      MISCHIEF_HOST_LAUNCH_AGENT_PATH: path.join(root, "host.plist"),
      MISCHIEF_HOST_SOCKET: path.join(root, "run", "host.sock"),
      MISCHIEF_PROFILE_DB: root,
    },
    service: `gui/${process.getuid?.() ?? -1}/${label}`,
  };
};
const stopService = async (service: string): Promise<void> => {
  const bootout = spawn("/bin/launchctl", ["bootout", service], {
    stdio: "ignore",
  });
  await once(bootout, "exit");
};

// The packaged executable, not the development Node runtime, is exercised here.
describe("signed macOS app", () => {
  test("packages the shared extension theme and companion styles", async () => {
    const resources = new URL(
      "dist/Mischief.app/Contents/Resources/",
      import.meta.url
    );
    const theme = await readFile(new URL("theme.css", resources), "utf-8");
    const source = await readFile(
      new URL("../shared/theme/tokens.css", import.meta.url),
      "utf-8"
    );
    const html = await readFile(new URL("index.html", resources), "utf-8");
    const css = await readFile(new URL("app.css", resources), "utf-8");
    assert.equal(theme, source);
    await Promise.all(
      [
        "IBMPlexSans-Regular.woff2",
        "IBMPlexSans-SemiBold.woff2",
        "Lilex-Regular.woff2",
      ].map(async (font) => {
        const [packaged, original] = await Promise.all([
          readFile(new URL(`fonts/${font}`, resources)),
          readFile(new URL(`../shared/theme/fonts/${font}`, import.meta.url)),
        ]);
        assert.deepEqual(packaged, original);
      })
    );
    assert.match(html, /href="theme\.css"/u);
    assert.match(html, /href="app\.css"/u);
    assert.match(css, /var\(--hl-accent\)/u);
  });

  test("installs a private signed Host outside the app bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-install-"));
    await chmod(root, 0o755);
    try {
      const child = spawn(app, ["--smoke-install-host"], {
        env: {
          ...process.env,
          MISCHIEF_DISABLE_BACKGROUND_HOST: "1",
          MISCHIEF_HOST_INSTALL_ROOT: path.join(root, "Host"),
        },
        stdio: "ignore",
      });
      assert.equal(await waitForExit(child), 0);
      const installed = path.join(root, "Host");
      const resources = new URL(
        "dist/Mischief.app/Contents/Resources/",
        import.meta.url
      );
      await Promise.all(
        [
          ["node", 0o700],
          ["Host.mjs", 0o600],
        ].map(async ([name, mode]) => {
          const target = path.join(installed, String(name));
          const [installedFile, resourceFile, installedStats] =
            await Promise.all([
              readFile(target),
              readFile(new URL(String(name), resources)),
              stat(target),
            ]);
          assert.deepEqual(installedFile, resourceFile);
          assert.equal(installedStats.mode % 0o1000, mode);
        })
      );
      const [installedStats, parentStats] = await Promise.all([
        stat(installed),
        stat(root),
      ]);
      assert.equal(installedStats.mode % 0o1000, 0o700);
      assert.equal(parentStats.mode % 0o1000, 0o700);
      const npm = path.join(installed, "npm/bin/npm-cli.js");
      await assert.doesNotReject(stat(npm));
      const npmVersion = spawn(path.join(installed, "node"), [
        npm,
        "--version",
      ]);
      assert.equal(await waitForExit(npmVersion), 0);
      const npxVersion = spawn(path.join(installed, "bin/npx"), ["--version"], {
        env: { HOME: root, PATH: "/usr/bin:/bin" },
      });
      assert.equal(await waitForExit(npxVersion), 0);
      const verify = spawn("/usr/bin/codesign", [
        "--verify",
        "--strict",
        path.join(installed, "node"),
      ]);
      assert.equal(await waitForExit(verify), 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("launchd Host survives app Quit and is reused on reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-launchd-"));
    const label = `works.digitaloverground.mischief.host.test.${process.pid}.${Date.now()}`;
    const service = `gui/${process.getuid?.() ?? -1}/${label}`;
    const socketPath = path.join(root, "run", "host.sock");
    const plistPath = path.join(root, "host.plist");
    const env = {
      ...process.env,
      MISCHIEF_HOST_INSTALL_ROOT: path.join(root, "Host"),
      MISCHIEF_HOST_JOB_LABEL: label,
      MISCHIEF_HOST_LAUNCH_AGENT_PATH: plistPath,
      MISCHIEF_HOST_SOCKET: socketPath,
      MISCHIEF_PROFILE_DB: path.join(root, "profile"),
    };
    const readPid = async (): Promise<number> => {
      const client = connect(socketPath);
      let output = "";
      try {
        await once(client, "connect");
        client.write('{"type":"hello","version":1}\n');
        for await (const chunk of client) {
          output += String(chunk);
          const state = output
            .split("\n")
            .slice(0, -1)
            .filter(Boolean)
            .map((line): unknown => JSON.parse(line) as unknown)
            .find(
              (message) =>
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "state"
            );
          if (
            typeof state === "object" &&
            state !== null &&
            "pid" in state &&
            typeof state.pid === "number"
          ) {
            return state.pid;
          }
        }
        throw new Error("Host disconnected before sending its PID");
      } finally {
        client.destroy();
      }
    };
    const waitForPid = async (deadline: number): Promise<number> => {
      try {
        return await readPid();
      } catch (error) {
        if (Date.now() >= deadline) {
          throw error;
        }
        await delay(50);
        return await waitForPid(deadline);
      }
    };
    const launchApp = async (): Promise<void> => {
      const child = spawn(app, ["--smoke-launch-host"], {
        env,
        stdio: "ignore",
      });
      assert.equal(await waitForExit(child), 0);
    };
    try {
      await launchApp();
      const firstPid = await waitForPid(Date.now() + 5000);
      process.kill(firstPid, 0);
      await launchApp();
      assert.equal(await waitForPid(Date.now() + 5000), firstPid);
      const plist = await stat(plistPath);
      assert.equal(plist.mode % 0o1000, 0o600);
    } finally {
      await stopService(service);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("standalone Host serves two local clients without stopping on disconnect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-"));
    const socketPath = path.join(root, "private", "host.sock");
    const child = spawn(binary, [script, "--daemon"], {
      env: {
        ...process.env,
        MISCHIEF_HOST_SOCKET: socketPath,
        MISCHIEF_PROFILE_DB: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ready: unknown[] = await once(child.stdout, "data");
      assert.match(String(ready[0]), /"type":"ready"/u);
      const directory = await stat(path.dirname(socketPath));
      const socket = await stat(socketPath);
      assert.equal(directory.mode % 0o100, 0);
      assert.equal(socket.mode % 0o1000, 0o600);
      const receive = async (
        version: number,
        sendCommand = false
      ): Promise<string> => {
        const client = connect(socketPath);
        let output = "";
        let commandSent = false;
        try {
          client.write(`${JSON.stringify({ type: "hello", version })}\n`);
          for await (const chunk of client) {
            output += String(chunk);
            if (
              sendCommand &&
              !commandSent &&
              output.includes('"type":"library"')
            ) {
              commandSent = true;
              client.write('{"action":"notify","type":"command"}\n');
            }
            if (
              output.includes(
                sendCommand ? '"type":"notify"' : '"type":"library"'
              )
            ) {
              break;
            }
          }
          return output;
        } finally {
          client.destroy();
        }
      };
      assert.match(await receive(1), /"version":1/u);
      assert.match(await receive(1), /"type":"library"/u);
      assert.match(await receive(1, true), /"type":"notify"/u);
      assert.match(await receive(2), /Incompatible Host protocol/u);
      const duplicate = spawn(binary, [script, "--daemon"], {
        env: {
          ...process.env,
          MISCHIEF_HOST_SOCKET: socketPath,
          MISCHIEF_PROFILE_DB: root,
        },
        stdio: "ignore",
      });
      assert.equal(await waitForExit(duplicate), 1);
      assert.equal(child.exitCode, null);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
      await assert.rejects(stat(socketPath), { code: "ENOENT" });
      await assert.rejects(
        stat(path.join(path.dirname(socketPath), "host.lock")),
        {
          code: "ENOENT",
        }
      );
      await rm(root, { force: true, recursive: true });
    }
  });

  test("only one Host owns a profile across different endpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-profile-owner-"));
    const profilePath = path.join(root, "profile");
    const start = (socketPath: string): ChildProcess =>
      spawn(binary, [script, "--daemon"], {
        env: {
          ...process.env,
          MISCHIEF_HOST_PROFILE: profilePath,
          MISCHIEF_HOST_SOCKET: socketPath,
          MISCHIEF_PROFILE_DB: root,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    const firstSocket = path.join(root, "first", "host.sock");
    const secondSocket = path.join(root, "second", "host.sock");
    const first = start(firstSocket);
    try {
      assert.ok(first.stdout);
      const ready: unknown[] = await once(first.stdout, "data");
      assert.match(String(ready[0]), /"type":"ready"/u);
      const second = start(secondSocket);
      assert.equal(await waitForExit(second), 1);
      assert.equal(first.exitCode, null);
      await assert.rejects(stat(secondSocket), { code: "ENOENT" });
    } finally {
      first.kill("SIGTERM");
      await waitForExit(first);
      await assert.rejects(stat(path.join(profilePath, "profile.lock")), {
        code: "ENOENT",
      });
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reclaims a crashed Host without stealing a live owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-crash-"));
    const socketPath = path.join(root, "private", "host.sock");
    const env = {
      ...process.env,
      MISCHIEF_HOST_SOCKET: socketPath,
      MISCHIEF_PROFILE_DB: root,
    };
    const start = (): ChildProcess =>
      spawn(binary, [script, "--daemon"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const first = start();
    let restored: ChildProcess | undefined;
    try {
      assert.ok(first.stdout);
      const ready: unknown[] = await once(first.stdout, "data");
      assert.match(String(ready[0]), /"type":"ready"/u);
      first.kill("SIGKILL");
      const stopped: unknown[] = await once(first, "exit");
      assert.equal(stopped[1], "SIGKILL");
      restored = start();
      assert.ok(restored.stdout);
      const recovered: unknown[] = await once(restored.stdout, "data");
      assert.match(String(recovered[0]), /"type":"ready"/u);
      assert.equal(restored.exitCode, null);
      const socket = await stat(socketPath);
      assert.ok(socket.isSocket());
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        first.kill("SIGKILL");
      }
      if (restored) {
        restored.kill("SIGTERM");
        await waitForExit(restored);
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reclaims a dead socket without a lock, but leaves a live socket alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-unlocked-"));
    const socketPath = path.join(root, "private", "host.sock");
    const lockPath = path.join(root, "private", "host.lock");
    const env = {
      ...process.env,
      MISCHIEF_HOST_SOCKET: socketPath,
      MISCHIEF_PROFILE_DB: root,
    };
    const start = (): ChildProcess =>
      spawn(binary, [script, "--daemon"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const first = start();
    let replacement: ChildProcess | undefined;
    try {
      assert.ok(first.stdout);
      const firstReady: unknown[] = await once(first.stdout, "data");
      assert.match(String(firstReady[0]), /"type":"ready"/u);
      first.kill("SIGKILL");
      await once(first, "exit");
      await rm(lockPath);
      replacement = start();
      assert.ok(replacement.stdout);
      const replacementReady: unknown[] = await once(
        replacement.stdout,
        "data"
      );
      assert.match(String(replacementReady[0]), /"type":"ready"/u);
      await rm(lockPath);
      const rival = spawn(binary, [script, "--daemon"], {
        env: {
          ...env,
          MISCHIEF_HOST_PROFILE: path.join(root, "rival-profile"),
        },
        stdio: "ignore",
      });
      assert.equal(await waitForExit(rival), 1);
      assert.equal(replacement.exitCode, null);
      const client = connect(socketPath);
      try {
        await once(client, "connect");
      } finally {
        client.destroy();
      }
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        first.kill("SIGKILL");
      }
      if (replacement) {
        replacement.kill("SIGTERM");
        await waitForExit(replacement);
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  test("only one Host replaces a stale lock and socket", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-race-"));
    const socketPath = path.join(root, "private", "host.sock");
    const env = {
      ...process.env,
      MISCHIEF_HOST_SOCKET: socketPath,
      MISCHIEF_PROFILE_DB: root,
    };
    const start = (): ChildProcess =>
      spawn(binary, [script, "--daemon"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const first = start();
    const replacements: ChildProcess[] = [];
    try {
      assert.ok(first.stdout);
      const firstReady: unknown[] = await once(first.stdout, "data");
      assert.match(String(firstReady[0]), /"type":"ready"/u);
      first.kill("SIGKILL");
      await once(first, "exit");
      replacements.push(start(), start());
      const outcomes = await Promise.all(
        replacements.map(async (child) => {
          assert.ok(child.stdout);
          return await Promise.race([
            once(child.stdout, "data").then((ready: unknown[]) => {
              assert.match(String(ready[0]), /"type":"ready"/u);
              return "ready";
            }),
            once(child, "exit").then((exit: unknown[]) => {
              assert.equal(exit[0], 1);
              return "lost";
            }),
          ]);
        })
      );
      assert.deepEqual(outcomes.toSorted(), ["lost", "ready"]);
      const client = connect(socketPath);
      try {
        await once(client, "connect");
      } finally {
        client.destroy();
      }
    } finally {
      if (first.exitCode === null && first.signalCode === null) {
        first.kill("SIGKILL");
      }
      await Promise.all(
        replacements.map(async (child) => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            await waitForExit(child);
          }
        })
      );
      await rm(root, { force: true, recursive: true });
    }
  });

  test("disconnects a client before pending writes exceed the limit", () => {
    const client = new Socket();
    Object.defineProperty(client, "writableLength", {
      value: 8 * 1024 * 1024 - 2,
    });
    writeClient(client, "hello\n");
    assert.equal(client.destroyed, true);
  });

  test("does not reclaim a lock held by a live PID", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-held-"));
    const socketPath = path.join(root, "private", "host.sock");
    const lockPath = path.join(root, "private", "host.lock");
    try {
      await mkdir(path.dirname(socketPath), { mode: 0o700 });
      const record = JSON.stringify({ nonce: "existing", pid: process.pid });
      await writeFile(lockPath, record, { mode: 0o600 });
      const child = spawn(binary, [script, "--daemon"], {
        env: {
          ...process.env,
          MISCHIEF_HOST_SOCKET: socketPath,
          MISCHIEF_PROFILE_DB: root,
        },
        stdio: "ignore",
      });
      assert.equal(await waitForExit(child), 1);
      assert.equal(await readFile(lockPath, "utf-8"), record);
      await assert.rejects(stat(socketPath), { code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

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

  test("initial library snapshot and bundled fonts reach React", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-empty-library-"));
    const { env, service } = backgroundHostEnvironment(root);
    try {
      const child = spawn(app, ["--smoke-library"], {
        env,
        stdio: "ignore",
      });
      assert.equal(await waitForExit(child), 0);
    } finally {
      await stopService(service);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("window closes and reopens without crashing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-close-"));
    const { env, service } = backgroundHostEnvironment(root);
    try {
      const child = spawn(app, ["--smoke-close"], {
        env,
        stdio: "ignore",
      });
      assert.equal(await waitForExit(child), 0);
    } finally {
      await stopService(service);
      await rm(root, { force: true, recursive: true });
    }
  });
});
