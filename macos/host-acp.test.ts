import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HostAcpConnection } from "./host-acp";
import { HostAcpManager } from "./host-acp-manager";

const roots: string[] = [];

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let complete: ((value: T) => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new -- the test controls when an ACP response arrives.
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

const fakeAgent = String.raw`
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import readline from "node:readline";
let promptId;
let promptSession;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const npx = spawnSync("npx", ["--version"], { encoding: "utf8" });
    if (npx.error || npx.status !== 0) {
      send({ error: { code: -32603, message: "npx unavailable" }, id: message.id });
      return;
    }
    send({ id: message.id, result: { agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true }, sessionCapabilities: { list: {} } }, authMethods: [{ id: "login", name: "Log in", type: "agent" }], protocolVersion: 1 } });
  } else if (message.method === "authenticate") {
    send({ id: message.id, result: {} });
  } else if (message.method === "session/list") {
    send({ id: message.id, result: { sessions: [{ cwd: message.params.cwd, sessionId: "old-session", title: "Previous" }] } });
  } else if (message.method === "session/new") {
    if (process.env.MISCHIEF_TEST_SESSION_LOG) appendFileSync(process.env.MISCHIEF_TEST_SESSION_LOG, "new\n");
    send({ id: message.id, result: { sessionId: "session-1" } });
  } else if (message.method === "session/load") {
    if (process.env.MISCHIEF_TEST_SESSION_LOG) appendFileSync(process.env.MISCHIEF_TEST_SESSION_LOG, "load\n");
    send({ id: message.id, result: {} });
  } else if (message.method === "session/set_config_option") {
    send({ id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    if (message.params.prompt[0]?.text?.startsWith("Hello image") && (message.params.prompt[1]?.type !== "image" || message.params.prompt[2]?.type !== "resource")) {
      send({ id: message.id, error: { code: -32602, message: "Missing image or context" } });
      return;
    }
    promptId = message.id;
    promptSession = message.params.sessionId;
    send({ method: "session/update", params: { sessionId: promptSession, update: { content: { text: "working", type: "text" }, sessionUpdate: "agent_message_chunk" } } });
    send({ id: 100, method: "session/request_permission", params: { options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }], sessionId: promptSession, toolCall: { kind: "other", status: "pending", title: "Test tool", toolCallId: "tool-1" } } });
  } else if (message.id === 100) {
    send({ id: promptId, result: { stopReason: "end_turn" } });
  } else if (message.method === "session/cancel") {
    send({ id: promptId, result: { stopReason: "cancelled" } });
  }
});
`;

describe("Host ACP connection", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { force: true, recursive: true });
      })
    );
  });

  test("owns Agent sessions and keeps permission requests pending", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-acp-"));
    roots.push(root);
    const script = path.join(root, "fake-agent.mjs");
    await writeFile(script, fakeAgent);
    await writeFile(path.join(root, "context.txt"), "context");
    const updates: { sessionId: string; update: SessionUpdate }[] = [];
    const pendingPermission = deferred<RequestPermissionResponse>();
    const connection = new HostAcpConnection(
      {
        args: [script],
        command: process.execPath,
        env: { PATH: "/usr/bin:/bin" },
      },
      {
        elicitation: async () => await Promise.resolve({ action: "cancel" }),
        error: (error) => {
          throw error;
        },
        permission: async () => await pendingPermission.promise,
        update: (sessionId, update) => {
          updates.push({ sessionId, update });
        },
      }
    );
    try {
      const session = await connection.create(root);
      await connection.authenticate("login");
      expect({
        history: await connection.history(root),
        sessionId: session.sessionId,
      }).toStrictEqual({
        history: [{ cwd: root, sessionId: "old-session", title: "Previous" }],
        sessionId: "session-1",
      });
      await connection.load(session.sessionId, root);
      await connection.setConfig(session.sessionId, "model", "fast");
      let finished = false;
      const prompt = connection
        .prompt(session.sessionId, "Hello image @context.txt", [
          { data: "aGVsbG8=", mimeType: "image/png" },
        ])
        .then((result) => {
          finished = true;
          return result;
        });
      await vi.waitFor(() => {
        expect(updates).toHaveLength(1);
      });
      expect(finished).toBeFalsy();
      pendingPermission.resolve({
        outcome: { optionId: "allow", outcome: "selected" },
      });
      await expect(prompt).resolves.toBe("completed");
      expect(updates[0]?.sessionId).toBe(session.sessionId);
    } finally {
      connection.dispose();
    }
  });

  test("advertises and forwards MagPi message-target fork only when supported", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-fork-acp-"));
    roots.push(root);
    const script = path.join(root, "agent.mjs");
    await writeFile(
      script,
      fakeAgent
        .replace(
          "sessionCapabilities: { list: {} }",
          'sessionCapabilities: { list: {}, fork: {} }, _meta: { "magpi-acp/message-target-actions": true }'
        )
        .replace(
          '  } else if (message.method === "session/load") {',
          '  } else if (message.method === "session/fork") {\n    if (message.params._meta?.["magpi-acp/fork-message-id"] !== "message-1") { send({ id: message.id, error: { code: -32602, message: "wrong fork target" } }); return; }\n    send({ id: message.id, result: { sessionId: "fork-session" } });\n  } else if (message.method === "session/load") {'
        )
    );
    const connection = new HostAcpConnection(
      { args: [script], command: process.execPath },
      {
        elicitation: async () => await Promise.resolve({ action: "decline" }),
        error: () => {},
        permission: async () =>
          await Promise.resolve({ outcome: { outcome: "cancelled" } }),
        update: () => {},
      }
    );
    try {
      const source = await connection.create(root);
      expect(source.operations.forkMessage).toBeTruthy();
      await expect(
        connection.forkMessage(source.sessionId, root, "message-1")
      ).resolves.toMatchObject({
        sessionId: "fork-session",
      });
      await expect(
        connection.forkMessage(source.sessionId, root, "wrong")
      ).rejects.toThrow("wrong fork target");
    } finally {
      connection.dispose();
    }
  });

  test("starts a Thread Agent in its Workspace, not the Host directory", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "mischief-agent-workspace-")
    );
    roots.push(root);
    const script = path.join(root, "agent.mjs");
    await writeFile(
      script,
      fakeAgent.replace('sessionId: "session-1"', "sessionId: process.cwd()")
    );
    const connection = new HostAcpConnection(
      { args: [script], command: process.execPath, cwd: root },
      {
        elicitation: async () => await Promise.resolve({ action: "decline" }),
        error: () => {},
        permission: async () =>
          await Promise.resolve({ outcome: { outcome: "cancelled" } }),
        update: () => {},
      }
    );
    try {
      const session = await connection.create(root);
      expect(session.sessionId).toBe(await realpath(root));
    } finally {
      connection.dispose();
    }
  });

  test("routes concurrent Workspaces to Agents launched in each Workspace", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "mischief-host-workspaces-")
    );
    roots.push(root);
    const profile = path.join(root, "profile");
    const agentScript = path.join(
      profile,
      "agents/magpi-acp/versions/1.0.0/node_modules/magpi-acp/dist/index.js"
    );
    await mkdir(path.dirname(agentScript), { recursive: true });
    await writeFile(
      agentScript,
      fakeAgent
        .replace('sessionId: "session-1"', "sessionId: process.cwd()")
        .replace(
          'send({ id: message.id, result: {} });\n  } else if (message.method === "session/prompt")',
          'if (process.cwd() !== message.params.sessionId) { send({ id: message.id, error: { code: -32603, message: "wrong cwd" } }); } else { send({ id: message.id, result: {} }); }\n  } else if (message.method === "session/prompt")'
        )
    );
    await writeFile(
      path.join(profile, "agents/magpi-acp/active.json"),
      JSON.stringify({ version: "1.0.0" })
    );
    const manager = new HostAcpManager(profile, () => {});
    try {
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      await mkdir(first);
      await mkdir(second);
      const [a, b] = await Promise.all([
        manager.create("magpi-acp", first),
        manager.create("magpi-acp", second),
      ]);
      expect([a.sessionId, b.sessionId]).toStrictEqual([
        await realpath(first),
        await realpath(second),
      ]);
      await manager.setConfig("magpi-acp", a.sessionId, "model", "fast");
      await manager.setConfig("magpi-acp", b.sessionId, "model", "fast");
    } finally {
      manager.dispose();
    }
  });

  test("starts the Agent after the Host's working directory is replaced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-cwd-"));
    const script = path.join(tmpdir(), `mischief-agent-cwd-${process.pid}.mjs`);
    await writeFile(script, `process.cwd();\n${fakeAgent}`);
    const originalCwd = process.cwd();
    const connection = new HostAcpConnection(
      { args: [script], command: process.execPath },
      {
        elicitation: async () => await Promise.resolve({ action: "decline" }),
        error: () => {},
        permission: async () =>
          await Promise.resolve({ outcome: { outcome: "cancelled" } }),
        update: () => {},
      }
    );
    try {
      process.chdir(root);
      await rm(root, { recursive: true });
      await expect(connection.inspect()).resolves.toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      connection.dispose();
      await rm(script);
    }
  });

  test("serves ACP turns through the packaged Host socket", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-acp-"));
    roots.push(root);
    const profilePath = path.join(root, "profile");
    const socketPath = path.join(root, "private", "host.sock");
    const sessionLog = path.join(root, "sessions.log");
    const agentRoot = path.join(
      profilePath,
      "agents/magpi-acp/versions/1.0.0/node_modules/magpi-acp"
    );
    const agentScript = path.join(agentRoot, "dist/index.js");
    await mkdir(path.dirname(agentScript), { mode: 0o700, recursive: true });
    await writeFile(
      agentScript,
      fakeAgent
        .replace(
          "sessionCapabilities: { list: {} }",
          'sessionCapabilities: { list: {}, fork: {} }, _meta: { "magpi-acp/message-target-actions": true }'
        )
        .replace(
          '  } else if (message.method === "session/load") {',
          '  } else if (message.method === "session/fork") {\n    if (message.params._meta?.["magpi-acp/fork-message-id"] !== "user-message-1") { send({ id: message.id, error: { code: -32602, message: "wrong fork target" } }); return; }\n    send({ id: message.id, result: { sessionId: "fork-session" } });\n  } else if (message.method === "session/load") {'
        )
    );
    await writeFile(
      path.join(profilePath, "agents/magpi-acp/active.json"),
      JSON.stringify({ version: "1.0.0" })
    );
    const resources = path.join(
      import.meta.dirname,
      "dist/Mischief.app/Contents/Resources"
    );
    const host = spawn(
      path.join(resources, "node"),
      [path.join(resources, "Host.mjs"), "--daemon"],
      {
        env: {
          ...process.env,
          MISCHIEF_HOST_PROFILE: profilePath,
          MISCHIEF_HOST_SOCKET: socketPath,
          MISCHIEF_PROFILE_DB: root,
          MISCHIEF_TEST_SESSION_LOG: sessionLog,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    try {
      await once(host.stdout, "data");
      const client = connect(socketPath);
      let output = "";
      client.setEncoding("utf-8");
      client.on("data", (chunk: string) => {
        output += chunk;
      });
      client.write(
        '{"type":"hello","version":1}\n' +
          '{"type":"command","action":"agentInstall","agentId":"unknown","requestId":"installUnknown"}\n' +
          '{"type":"command","action":"threadCreate","requestId":"invalid"}\n' +
          '{"type":"command","action":"threadCreate","agentId":"unknown","cwd":"/tmp","requestId":"unknown"}\n' +
          '{"type":"command","action":"threadCreate","agentId":"magpi-acp","cwd":"/tmp","requestId":"create"}\n'
      );
      await vi.waitFor(() => {
        expect(output).toContain('"requestId":"create"');
      });
      expect(output).toContain(
        '"error":"Unknown Agent: unknown","requestId":"installUnknown"'
      );
      expect(output).toContain(
        '"error":"Invalid Thread create request","requestId":"invalid"'
      );
      expect(output).toContain(
        '"error":"Invalid new Thread request","requestId":"unknown"'
      );
      expect(output).toContain('"sessionId":"session-1"');
      const created = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
        .find(
          (message): message is { requestId: string; value: { id: string } } =>
            typeof message === "object" &&
            message !== null &&
            "requestId" in message &&
            message.requestId === "create" &&
            "value" in message &&
            typeof message.value === "object" &&
            message.value !== null &&
            "id" in message.value &&
            typeof message.value.id === "string"
        );
      assert.ok(created);
      client.write(
        `${JSON.stringify({
          action: "threadPrompt",
          requestId: "prompt",
          text: "Hello",
          threadId: created.value.id,
          type: "command",
        })}\n`
      );
      await vi.waitFor(() => {
        expect(output).toContain('"type":"acpPermission"');
      });
      const permission = output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown)
        .find(
          (message): message is { interactionId: string; type: string } =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "acpPermission" &&
            "interactionId" in message &&
            typeof message.interactionId === "string"
        );
      assert.ok(permission);
      expect(output).toMatch(
        new RegExp(
          `"type":"acpUpdate"[^\\n]*"threadId":"${created.value.id}"`,
          "u"
        )
      );
      await vi.waitFor(() => {
        expect(output).toContain('"status":"waiting"');
      });
      const second = connect(socketPath);
      let secondOutput = "";
      second.setEncoding("utf-8");
      second.on("data", (chunk: string) => {
        secondOutput += chunk;
      });
      second.write(
        `{"type":"hello","version":1}\n${JSON.stringify({
          action: "threadLoad",
          requestId: "secondLoad",
          threadId: created.value.id,
          type: "command",
        })}\n`
      );
      await vi.waitFor(() => {
        expect(secondOutput).toContain('"requestId":"secondLoad"');
        expect(secondOutput).toContain(permission.interactionId);
      });
      assert.equal(await readFile(sessionLog, "utf-8"), "new\n");
      second.destroy();
      client.destroy();

      const replacement = connect(socketPath);
      let replacementOutput = "";
      replacement.setEncoding("utf-8");
      replacement.on("data", (chunk: string) => {
        replacementOutput += chunk;
      });
      replacement.write(
        `{"type":"hello","version":1}\n${JSON.stringify({
          action: "threadTranscript",
          requestId: "transcript",
          threadId: created.value.id,
          type: "command",
        })}\n`
      );
      await vi.waitFor(() => {
        expect(replacementOutput).toContain(permission.interactionId);
        expect(replacementOutput).toMatch(
          /"requestId":"transcript"[^\n]*"text":"working"/u
        );
      });
      replacement.write(
        `${JSON.stringify({
          action: "acpRespondPermission",
          interactionId: permission.interactionId,
          requestId: "permission",
          response: {
            outcome: { optionId: "allow", outcome: "selected" },
          },
          type: "command",
        })}\n`
      );
      await vi.waitFor(() => {
        expect(replacementOutput).toContain('"status":"idle"');
        expect(replacementOutput).toContain('"type":"acpInteractionResolved"');
        expect(replacementOutput).toContain(
          '"requestId":"permission","type":"result"'
        );
      });
      const forkId = "123e4567-e89b-4d3a-a456-426614174003";
      replacement.write(
        `${JSON.stringify({
          action: "threadFork",
          forkId,
          messageId: "user-message-1",
          requestId: "fork",
          threadId: created.value.id,
          type: "command",
        })}\n`
      );
      await vi.waitFor(() => {
        expect(replacementOutput).toContain('"requestId":"fork"');
      });
      // oxlint-disable-next-line vitest/max-expects -- socket round trip checks the fork response and its durable record.
      expect(replacementOutput).toMatch(
        /"requestId":"fork"[^\n]*"sessionId":"fork-session"/u
      );
      // oxlint-disable-next-line vitest/max-expects -- verify the Host persisted the same fork returned over the socket.
      expect(
        JSON.parse(
          await readFile(
            path.join(profilePath, "profile-db-v1/threads", `${forkId}.json`),
            "utf-8"
          )
        )
      ).toMatchObject({
        id: forkId,
        sessionId: "fork-session",
      });
      replacement.destroy();
    } finally {
      if (host.exitCode === null && host.signalCode === null) {
        const exited = once(host, "exit");
        host.kill("SIGTERM");
        await exited;
      }
    }
  });

  test("cancels an active turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-acp-"));
    roots.push(root);
    const script = path.join(root, "fake-agent.mjs");
    await writeFile(script, fakeAgent);
    const started = deferred<boolean>();
    const pendingPermission = deferred<RequestPermissionResponse>();
    const connection = new HostAcpConnection(
      { args: [script], command: process.execPath },
      {
        elicitation: async () => await Promise.resolve({ action: "cancel" }),
        error: (error) => {
          throw error;
        },
        permission: async () => await pendingPermission.promise,
        update: () => {
          started.resolve(true);
        },
      }
    );
    try {
      const session = await connection.create(root);
      const prompt = connection.prompt(session.sessionId, "Hello", []);
      await started.promise;
      await connection.cancel(session.sessionId);
      await expect(prompt).resolves.toBe("cancelled");
    } finally {
      connection.dispose();
    }
  });
});
