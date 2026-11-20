import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
  test(
    "packaged Thread view sends prompts, renders Markdown, and loads older messages",
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "mischief-thread-ui-"));
      const workspace = await realpath(root);
      const profile = path.join(root, "profile");
      const socketPath = path.join(root, "run/host.sock");
      const threadId = "123e4567-e89b-4d3a-a456-426614174000";
      const agentRoot = path.join(profile, "agents/magpi-acp");
      const agentScript = path.join(
        agentRoot,
        "versions/1.0.0/node_modules/magpi-acp/dist/index.js"
      );
      await mkdir(path.dirname(agentScript), { recursive: true });
      await chmod(profile, 0o700);
      await writeFile(
        path.join(agentRoot, "active.json"),
        JSON.stringify({ version: "1.0.0" })
      );
      await writeFile(
        agentScript,
        String.raw`
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const configOptions = [
  { id: "model", name: "Model", type: "select", currentValue: "fast", options: [{ name: "Fast", value: "fast" }, { name: "Deep", value: "deep" }] },
  { id: "thinking", name: "Thinking", type: "select", currentValue: "low", options: [{ name: "Low", value: "low" }, { name: "High", value: "high" }] },
];
const update = (id, text, kind = "agent_message_chunk") => send({ method: "session/update", params: { sessionId: "ui-session", update: { sessionUpdate: kind, messageId: id, content: { type: "text", text } } } });
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (m.method === "session/load") {
    for (let i = 0; i < 300; i++) update("history-" + i, "History " + i + (i === 299 ? "\n\n**restored**\n" : "\n"), i % 2 === 0 ? "user_message_chunk" : "agent_message_chunk");
    send({ id: m.id, result: { configOptions } });
  } else if (m.method === "session/set_config_option") {
    configOptions.find((option) => option.id === m.params.configId).currentValue = m.params.value;
    // No notification: clients must also consume the confirmed RPC response.
    send({ id: m.id, result: { configOptions } });
  } else if (m.method === "session/prompt") {
    const text = m.params.prompt[0]?.text;
    appendFileSync(process.env.MISCHIEF_UI_PROMPT_LOG, JSON.stringify({ sessionId: m.params.sessionId, text }) + "\n");
    update("user-" + m.id, text, "user_message_chunk");
    update("reply-" + m.id, "## Reply to " + text + "\n\n**bo");
    update("reply-" + m.id, "ld**\n\n- item\n\n~~~js\nconst x = 1\n~~~\n\n<script>window.injected=true</script>\n\n[bad](javascript:alert(1))");
    if (text === "Enter smoke") {
      send({ id: "question", method: "elicitation/create", params: { sessionId: "ui-session", mode: "form", message: "Choose the next step", requestedSchema: { type: "object", properties: { answer: { type: "string", title: "Answer" } }, required: ["answer"] } } });
    } else {
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }
  } else if (m.id === "question") {
    if (m.result?.action !== "accept" || m.result.content?.answer !== "Do the footer first") throw new Error("Wrong elicitation response");
    update("accepted", "Answer accepted; still working");
    // Keep the turn running: dismissal must not depend on turn completion.
  }
});
`
      );
      const now = new Date().toISOString();
      await mkdir(path.join(profile, "profile-db-v1/threads"), {
        recursive: true,
      });
      await writeFile(
        path.join(profile, "profile-db-v1/threads", `${threadId}.json`),
        JSON.stringify({
          agentId: "magpi-acp",
          createdAt: now,
          id: threadId,
          name: "UI smoke Thread",
          owner: "host",
          sessionId: "ui-session",
          status: "idle",
          updatedAt: now,
          version: 1,
          workspace,
          writtenAt: Date.now(),
        })
      );
      await mkdir(path.join(root, "workspaces"));
      await writeFile(
        path.join(
          root,
          "workspaces",
          `${createHash("sha256").update(workspace).digest("hex")}.json`
        ),
        JSON.stringify({
          path: workspace,
          status: "active",
          version: 1,
          writtenAt: Date.now(),
        })
      );
      const promptLog = path.join(root, "prompts.jsonl");
      const env = {
        ...process.env,
        MISCHIEF_DISABLE_BACKGROUND_HOST: "1",
        MISCHIEF_HOST_INSTALL_ROOT: path.join(root, "Host"),
        MISCHIEF_HOST_PROFILE: profile,
        MISCHIEF_HOST_SOCKET: socketPath,
        MISCHIEF_PROFILE_DB: root,
        MISCHIEF_THREAD_SMOKE_SCRIPT: path.join(
          import.meta.dirname,
          "thread-smoke.js"
        ),
        MISCHIEF_UI_PROMPT_LOG: promptLog,
      };
      const host = spawn(binary, [script, "--daemon"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let child: ChildProcess | undefined;
      let observer: Socket | undefined;
      let observed = "";
      let changedThinking = false;
      let errors = "";
      try {
        host.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        await Promise.race([
          once(host.stdout, "data"),
          once(host, "exit").then(() => {
            throw new Error(`Host exited: ${errors}`);
          }),
        ]);
        observer = connect(socketPath);
        observer.setEncoding("utf-8");
        observer.on("data", (chunk: string) => {
          observed += chunk;
          if (!changedThinking && observed.includes('"currentValue":"deep"')) {
            changedThinking = true;
            observer?.write(
              `${JSON.stringify({ action: "threadSetConfig", configId: "thinking", requestId: "remote-config", threadId, type: "command", value: "high" })}\n`
            );
          }
        });
        observer.write('{"type":"hello","version":1}\n');
        child = spawn(app, ["--smoke-thread"], {
          env,
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 20_000,
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        const exitResult: unknown[] = await once(child, "exit");
        assert.deepEqual(exitResult, [0, null], errors);
        const events = observed
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        const question = events.find(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "acpElicitation"
        );
        assert.ok(
          typeof question === "object" &&
            question !== null &&
            "interactionId" in question
        );
        assert.ok(
          events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "type" in event &&
              event.type === "acpInteractionResolved" &&
              "interactionId" in event &&
              event.interactionId === question.interactionId &&
              "threadId" in event &&
              event.threadId === threadId
          ),
          "Other client did not receive completion"
        );
        const prompts = await readFile(promptLog, "utf-8");
        assert.deepEqual(
          prompts
            .trim()
            .split("\n")
            .map((line): unknown => JSON.parse(line)),
          [
            { sessionId: "ui-session", text: "Send smoke" },
            { sessionId: "ui-session", text: "Enter smoke" },
          ]
        );
      } finally {
        observer?.destroy();
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
        if (host.exitCode === null && host.signalCode === null) {
          const exited = once(host, "exit");
          host.kill();
          await exited;
        }
        await rm(root, { force: true, recursive: true });
      }
    }
  );

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

  test(
    "installs a private signed Host outside the app bundle",
    { timeout: 20_000 },
    async () => {
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
        const npxVersion = spawn(
          path.join(installed, "bin/npx"),
          ["--version"],
          {
            env: { HOME: root, PATH: "/usr/bin:/bin" },
          }
        );
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
    }
  );

  test(
    "launchd Host survives app Quit and is reused on reopen",
    { timeout: 20_000 },
    async () => {
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
    }
  );

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
      const imageClient = connect(socketPath);
      try {
        imageClient.write('{"type":"hello","version":1}\n');
        imageClient.write(
          `${JSON.stringify({
            action: "threadPrompt",
            images: [{ data: "a".repeat(100_000), mimeType: "image/png" }],
            requestId: "large-image",
            text: "Describe this image",
            threadId: "missing-thread",
            type: "command",
          })}\n`
        );
        let response = "";
        for await (const chunk of imageClient) {
          response += String(chunk);
          if (response.includes('"requestId":"large-image"')) {
            break;
          }
        }
        assert.match(response, /"error":"Unknown Thread: missing-thread"/u);
      } finally {
        imageClient.destroy();
      }
      const oversizedClient = connect(socketPath);
      try {
        oversizedClient.write('{"type":"hello","version":1}\n');
        oversizedClient.write(
          `${JSON.stringify({
            action: "threadPrompt",
            images: [{ data: "a".repeat(7_000_001), mimeType: "image/png" }],
            requestId: "oversized-image",
            text: "Describe this image",
            threadId: "missing-thread",
            type: "command",
          })}\n`
        );
        let response = "";
        for await (const chunk of oversizedClient) {
          response += String(chunk);
          if (response.includes('"requestId":"oversized-image"')) {
            break;
          }
        }
        assert.match(response, /Images exceed the 7 MB limit/u);
      } finally {
        oversizedClient.destroy();
      }
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

  test(
    "initial library snapshot and bundled fonts reach React",
    { timeout: 20_000 },
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "mischief-empty-library-")
      );
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
    }
  );

  test(
    "window closes and reopens without crashing",
    { timeout: 20_000 },
    async () => {
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
    }
  );
});
