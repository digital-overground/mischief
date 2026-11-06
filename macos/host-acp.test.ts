import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HostAcpConnection } from "./host-acp";

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
import readline from "node:readline";
let promptId;
let promptSession;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { agentCapabilities: { loadSession: true }, protocolVersion: 1 } });
  } else if (message.method === "session/new") {
    send({ id: message.id, result: { sessionId: "session-1" } });
  } else if (message.method === "session/load") {
    send({ id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
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
    const updates: { sessionId: string; update: SessionUpdate }[] = [];
    const pendingPermission = deferred<RequestPermissionResponse>();
    const connection = new HostAcpConnection(
      { args: [script], command: process.execPath },
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
      const sessionId = await connection.create(root);
      expect(sessionId).toBe("session-1");
      await connection.load(sessionId, root);
      let finished = false;
      const prompt = connection.prompt(sessionId, "Hello").then((result) => {
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
      expect(updates[0]?.sessionId).toBe(sessionId);
    } finally {
      connection.dispose();
    }
  });

  test("serves ACP turns through the packaged Host socket", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-acp-"));
    roots.push(root);
    const profilePath = path.join(root, "profile");
    const socketPath = path.join(root, "private", "host.sock");
    const agentRoot = path.join(
      profilePath,
      "agents/magpi-acp/versions/1.0.0/node_modules/magpi-acp"
    );
    const agentScript = path.join(agentRoot, "dist/index.js");
    await mkdir(path.dirname(agentScript), { mode: 0o700, recursive: true });
    await writeFile(agentScript, fakeAgent);
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
          '{"type":"command","action":"threadCreate","requestId":"invalid"}\n' +
          '{"type":"command","action":"threadCreate","agentId":"unknown","cwd":"/tmp","requestId":"unknown"}\n' +
          '{"type":"command","action":"threadCreate","agentId":"magpi-acp","cwd":"/tmp","requestId":"create"}\n'
      );
      await vi.waitFor(() => {
        expect(output).toContain('"requestId":"create"');
      });
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
      expect(output).toContain('"type":"acpUpdate"');
      expect(output).toContain(`"threadId":"${created.value.id}"`);
      await vi.waitFor(() => {
        expect(output).toContain('"status":"waiting"');
      });
      client.destroy();

      const replacement = connect(socketPath);
      let replacementOutput = "";
      replacement.setEncoding("utf-8");
      replacement.on("data", (chunk: string) => {
        replacementOutput += chunk;
      });
      replacement.write('{"type":"hello","version":1}\n');
      await vi.waitFor(() => {
        expect(replacementOutput).toContain(permission.interactionId);
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
        expect(replacementOutput).toContain(
          '"requestId":"permission","type":"result"'
        );
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
      const sessionId = await connection.create(root);
      const prompt = connection.prompt(sessionId, "Hello");
      await started.promise;
      await connection.cancel(sessionId);
      await expect(prompt).resolves.toBe("cancelled");
    } finally {
      connection.dispose();
    }
  });
});
