import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { HostClient } from "./host-client";

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

const serve = async (
  version = 1
): Promise<{ server: Server; socketPath: string }> => {
  const root = await mkdtemp(path.join(tmpdir(), "mischief-host-client-"));
  roots.push(root);
  await mkdir(root, { mode: 0o700, recursive: true });
  const socketPath = path.join(root, "host.sock");
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf-8");
    let pending = "";
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let end = pending.indexOf("\n");
      while (end !== -1) {
        const message: unknown = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "hello"
        ) {
          socket.write(
            `${JSON.stringify({ type: "hello", version })}\n${JSON.stringify({ pid: 42, type: "state" })}\n`
          );
        } else if (
          typeof message === "object" &&
          message !== null &&
          "requestId" in message &&
          typeof message.requestId === "string" &&
          "action" in message
        ) {
          if (message.action === "fail") {
            socket.write(
              `${JSON.stringify({ authentication: { label: "Log in", methodId: "login" }, error: "Expected failure", requestId: message.requestId, type: "result" })}\n`
            );
          } else if (message.action !== "wait") {
            socket.write(
              `${JSON.stringify({ requestId: message.requestId, type: "result", value: { ok: true } })}\n`
            );
          }
        }
        end = pending.indexOf("\n");
      }
    });
  });
  servers.push(server);
  server.listen(socketPath);
  await vi.waitFor(() => {
    expect(server.listening).toBeTruthy();
  });
  return { server, socketPath };
};

describe("Host client", () => {
  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await Promise.all(
      servers.splice(0).map(async (server) => {
        const closed = once(server, "close");
        server.close();
        await closed;
      })
    );
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { force: true, recursive: true });
      })
    );
  });

  test("starts, handshakes, replays initial events, and correlates results", async () => {
    const { socketPath } = await serve();
    let starts = 0;
    const client = await HostClient.connect({
      socketPath,
      start: async () => {
        starts += 1;
        await Promise.resolve();
      },
    });
    try {
      const events: unknown[] = [];
      client.onEvent((event) => {
        events.push(event);
      });
      expect({ events, starts }).toStrictEqual({
        events: [{ pid: 42, type: "state" }],
        starts: 1,
      });
      await expect(client.request("ping")).resolves.toStrictEqual({ ok: true });
      const failure = await client
        .request("fail")
        .catch((error: unknown) =>
          error instanceof Error ? error : new Error(String(error))
        );
      expect(failure).toMatchObject({
        authentication: { label: "Log in", methodId: "login" },
        message: "Expected failure",
      });
    } finally {
      client.close();
    }
  });

  test("reconnects and publishes connection state after the Host disconnects", async () => {
    const { socketPath } = await serve();
    const client = await HostClient.connect({
      socketPath,
      start: async () => {
        await Promise.resolve();
      },
      timeoutMs: 100,
    });
    const states: string[] = [];
    client.onConnectionChange(({ state }) => {
      states.push(state);
    });

    sockets[0]?.destroy();
    await vi.waitFor(() => {
      expect({ sockets: sockets.length, state: states.at(-1) }).toStrictEqual({
        sockets: 2,
        state: "connected",
      });
    });
    await expect(client.request("ping")).resolves.toStrictEqual({ ok: true });
    expect(states).toStrictEqual([
      "connected",
      "unreachable",
      "connecting",
      "connected",
    ]);
    client.close();
  });

  test("rejects pending requests when the Host disconnects", async () => {
    const { socketPath } = await serve();
    const client = await HostClient.connect({
      socketPath,
      start: async () => {
        await Promise.resolve();
      },
    });
    const request = client.request("wait");
    sockets[0]?.destroy();
    await expect(request).rejects.toThrow("disconnected");
    client.close();
  });

  test("rejects an incompatible Host protocol", async () => {
    const { socketPath } = await serve(2);
    await expect(
      HostClient.connect({
        socketPath,
        start: async () => {
          await Promise.resolve();
        },
        timeoutMs: 100,
      })
    ).rejects.toThrow("Incompatible Mischief Host protocol");
  });
});
