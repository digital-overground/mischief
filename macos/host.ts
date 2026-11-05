/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- async work is dispatched from synchronous stdin events */
import { once } from "node:events";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { writeClient } from "./host-output.js";
import { acquireHostOwnership } from "./host-ownership.js";
import {
  activateWorkspace,
  deactivateWorkspace,
  selectThread,
  snapshot,
} from "./library.js";

const clients = new Set<Socket>();
const daemon = process.argv.includes("--daemon");
const send = (message: unknown): void => {
  const line = `${JSON.stringify(message)}\n`;
  if (daemon) {
    for (const client of clients) {
      writeClient(client, line);
    }
  } else {
    process.stdout.write(line);
  }
};
let badge = 0;
let view = "home";
let pending = "";
let previous: Awaited<ReturnType<typeof snapshot>> | undefined;
let refreshing = false;
const state = (): void => {
  send({ badge, pid: process.pid, type: "state", view });
};

const refresh = async (): Promise<void> => {
  if (refreshing) {
    return;
  }
  refreshing = true;
  try {
    const current = await snapshot(process.env.MISCHIEF_PROFILE_DB);
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      const old = new Set(previous?.attentionIds ?? current.attentionIds);
      const newIds = current.attentionIds.filter((id) => !old.has(id));
      previous = current;
      badge = current.attention;
      state();
      send({
        attention: current.attention,
        type: "library",
        workspaces: current.workspaces,
      });
      for (const id of newIds) {
        const workspace = current.workspaces.find((w) =>
          w.threads.some((t) => t.id === id)
        );
        if (workspace) {
          send({ threadId: id, type: "attention", workspace: workspace.path });
        }
      }
    }
  } catch (error) {
    process.stderr.write(`Profile read failed: ${String(error)}\n`);
  } finally {
    refreshing = false;
  }
};

// oxlint-disable-next-line complexity -- validates and routes each IPC command
const command = (message: unknown): void => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "command" ||
    !("action" in message) ||
    typeof message.action !== "string"
  ) {
    return;
  }
  const candidate = "path" in message ? message.path : undefined;
  const threadId = "threadId" in message ? message.threadId : undefined;
  switch (message.action) {
    case "notify": {
      send({ type: "notify", view: "diagnostic" });
      break;
    }
    case "refresh": {
      refresh().catch((error: unknown) => {
        process.stderr.write(`${String(error)}\n`);
      });
      break;
    }
    case "addWorkspace":
    case "deactivateWorkspace": {
      if (typeof candidate !== "string") {
        break;
      }
      const { action } = message;
      (async () => {
        if (action === "addWorkspace") {
          await activateWorkspace(candidate, process.env.MISCHIEF_PROFILE_DB);
        } else {
          if (previous?.workspaces.some((w) => w.path === candidate) !== true) {
            return;
          }
          await deactivateWorkspace(candidate, process.env.MISCHIEF_PROFILE_DB);
        }
        await refresh();
      })().catch((error: unknown) => {
        process.stderr.write(`Workspace update failed: ${String(error)}\n`);
      });
      break;
    }
    case "openWorkspace": {
      if (
        typeof candidate === "string" &&
        previous?.workspaces.some((w) => w.path === candidate) === true
      ) {
        send({ path: candidate, type: "openWorkspace" });
      }
      break;
    }
    case "openThread": {
      if (
        typeof candidate !== "string" ||
        typeof threadId !== "string" ||
        previous?.workspaces.some(
          (w) =>
            w.path === candidate && w.threads.some((t) => t.id === threadId)
        ) !== true
      ) {
        break;
      }
      (async () => {
        await selectThread(
          candidate,
          threadId,
          process.env.MISCHIEF_PROFILE_DB
        );
        send({ path: candidate, type: "openWorkspace" });
      })().catch((error: unknown) => {
        process.stderr.write(`Could not focus Thread: ${String(error)}\n`);
      });
      break;
    }
    case "navigate": {
      const next = "view" in message ? message.view : undefined;
      if (next === "home" || next === "diagnostic") {
        view = next;
        state();
      }
      break;
    }
    default: {
      break;
    }
  }
};

const startDaemon = async (): Promise<void> => {
  const socketPath =
    process.env.MISCHIEF_HOST_SOCKET ??
    path.join(homedir(), "Library/Application Support/Mischief/host.sock");
  const parent = path.dirname(socketPath);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const directory = await lstat(parent);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode % 0o100 !== 0
  ) {
    throw new Error("Host socket directory must be private to this user");
  }
  const releaseOwnership = await acquireHostOwnership(socketPath);
  const server = createServer((client) => {
    let accepted = false;
    let clientPending = "";
    client.setEncoding("utf-8");
    client.on("data", (chunk: string) => {
      clientPending += chunk;
      if (clientPending.length > 65_536) {
        client.destroy();
        return;
      }
      let end = clientPending.indexOf("\n");
      while (end !== -1) {
        let message: unknown;
        try {
          message = JSON.parse(clientPending.slice(0, end)) as unknown;
        } catch {
          client.destroy();
          return;
        }
        clientPending = clientPending.slice(end + 1);
        if (accepted) {
          command(message);
        } else {
          if (
            typeof message !== "object" ||
            message === null ||
            !("type" in message) ||
            message.type !== "hello" ||
            !("version" in message) ||
            message.version !== 1
          ) {
            client.end(
              '{"type":"error","message":"Incompatible Host protocol"}\n'
            );
            return;
          }
          accepted = true;
          clients.add(client);
          writeClient(
            client,
            `${JSON.stringify({ type: "hello", version: 1 })}\n`
          );
          writeClient(
            client,
            `${JSON.stringify({ badge, pid: process.pid, type: "state", view })}\n`
          );
          if (previous) {
            writeClient(
              client,
              `${JSON.stringify({ attention: previous.attention, type: "library", workspaces: previous.workspaces })}\n`
            );
          }
        }
        end = clientPending.indexOf("\n");
      }
    });
    client.on("close", () => {
      clients.delete(client);
    });
    client.on("error", () => {
      clients.delete(client);
    });
  });
  try {
    server.listen(socketPath);
    await once(server, "listening");
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) {
      server.close();
    }
    await releaseOwnership();
    throw error;
  }
  const socket = await lstat(socketPath);
  process.on("SIGTERM", () => {
    server.close();
    void (async () => {
      try {
        const current = await lstat(socketPath);
        if (current.dev === socket.dev && current.ino === socket.ino) {
          await rm(socketPath);
        }
      } catch (error) {
        process.stderr.write(`Socket cleanup failed: ${String(error)}\n`);
      } finally {
        try {
          await releaseOwnership();
        } catch (error) {
          process.stderr.write(
            `Host ownership cleanup failed: ${String(error)}\n`
          );
        }
        process.exit(0);
      }
    })();
  });
  process.stdout.write(
    `${JSON.stringify({ socket: socketPath, type: "ready" })}\n`
  );
};

if (daemon) {
  startDaemon().catch((error: unknown) => {
    process.stderr.write(`Host startup failed: ${String(error)}\n`);
    process.exit(1);
  });
} else {
  state();
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    let end = pending.indexOf("\n");
    while (end !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        command(JSON.parse(line) as unknown);
      } catch (error) {
        process.stderr.write(`Invalid command: ${String(error)}\n`);
      }
      end = pending.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });
}
refresh().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
});
setInterval(() => {
  refresh().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
  });
}, 1000);
if (!daemon) {
  process.on("SIGTERM", () => {
    process.exit(0);
  });
}
