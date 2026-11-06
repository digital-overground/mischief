/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- async work is dispatched from synchronous stdin events */
import { once } from "node:events";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import type {
  CreateElicitationResponse,
  ElicitationContentValue,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

import { HostAcpManager } from "./host-acp-manager.js";
import { HostAgentInstaller } from "./host-agent-installer.js";
import { writeClient } from "./host-output.js";
import {
  acquireHostOwnership,
  acquireProfileOwnership,
} from "./host-ownership.js";
import { HostThreads } from "./host-threads.js";
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

const permissionResponse = (value: unknown): RequestPermissionResponse => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("outcome" in value) ||
    typeof value.outcome !== "object" ||
    value.outcome === null ||
    !("outcome" in value.outcome)
  ) {
    throw new Error("Invalid ACP permission response");
  }
  if (value.outcome.outcome === "cancelled") {
    return { outcome: { outcome: "cancelled" } };
  }
  if (
    value.outcome.outcome === "selected" &&
    "optionId" in value.outcome &&
    typeof value.outcome.optionId === "string"
  ) {
    return {
      outcome: { optionId: value.outcome.optionId, outcome: "selected" },
    };
  }
  throw new Error("Invalid ACP permission response");
};

const elicitationValue = (value: unknown): ElicitationContentValue => {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) &&
      value.every((candidate) => typeof candidate === "string"))
  ) {
    return value;
  }
  throw new Error("Invalid ACP elicitation value");
};

const elicitationResponse = (value: unknown): CreateElicitationResponse => {
  if (typeof value !== "object" || value === null || !("action" in value)) {
    throw new Error("Invalid ACP elicitation response");
  }
  if (value.action === "cancel" || value.action === "decline") {
    return { action: value.action };
  }
  if (
    value.action !== "accept" ||
    !("content" in value) ||
    typeof value.content !== "object" ||
    value.content === null
  ) {
    throw new Error("Invalid ACP elicitation response");
  }
  const content: Record<string, ElicitationContentValue> = {};
  for (const [name, candidate] of Object.entries(value.content)) {
    content[name] = elicitationValue(candidate);
  }
  return { action: "accept", content };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const promptImages = (value: unknown): { data: string; mimeType: string }[] => {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError("Invalid Thread prompt images");
  }
  const candidates: unknown[] = value;
  const images: { data: string; mimeType: string }[] = [];
  for (const image of candidates) {
    if (
      typeof image !== "object" ||
      image === null ||
      !("data" in image) ||
      typeof image.data !== "string" ||
      image.data.length === 0 ||
      !("mimeType" in image) ||
      typeof image.mimeType !== "string" ||
      image.mimeType.length === 0 ||
      image.mimeType.length > 256
    ) {
      throw new TypeError("Invalid Thread prompt images");
    }
    images.push({ data: image.data, mimeType: image.mimeType });
  }
  if (images.reduce((size, image) => size + image.data.length, 0) > 7_000_000) {
    throw new TypeError("Thread prompt images are too large");
  }
  return images;
};

// oxlint-disable-next-line complexity -- validates and routes each IPC command
const command = (
  message: unknown,
  acp?: HostAcpManager,
  threads?: HostThreads,
  installer?: HostAgentInstaller,
  reply: (message: unknown) => void = send
): void => {
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
  const requestId = "requestId" in message ? message.requestId : undefined;
  const respond = (operation: () => unknown): void => {
    if (typeof requestId !== "string" || requestId.length > 128) {
      return;
    }
    Promise.resolve()
      .then(operation)
      .then((value) => {
        reply({ requestId, type: "result", value });
      })
      .catch((error: unknown) => {
        reply({ error: errorMessage(error), requestId, type: "result" });
      });
  };
  const agentId = "agentId" in message ? message.agentId : undefined;
  const cwd = "cwd" in message ? message.cwd : undefined;
  switch (message.action) {
    case "agentStatus": {
      respond(async () => {
        if (!installer) {
          throw new TypeError("Invalid Agent status request");
        }
        return await installer.status();
      });
      break;
    }
    case "agentInstall": {
      respond(async () => {
        if (!installer || typeof agentId !== "string") {
          throw new TypeError("Invalid Agent install request");
        }
        return await installer.install(agentId);
      });
      break;
    }
    case "threadCreate": {
      respond(async () => {
        if (
          !threads ||
          typeof agentId !== "string" ||
          agentId.length > 128 ||
          typeof cwd !== "string" ||
          cwd.length > 4096
        ) {
          throw new TypeError("Invalid Thread create request");
        }
        return await threads.create(
          agentId,
          cwd,
          typeof threadId === "string" ? threadId : undefined
        );
      });
      break;
    }
    case "threadLoad": {
      respond(async () => {
        if (!threads || typeof threadId !== "string") {
          throw new TypeError("Invalid Thread load request");
        }
        return await threads.load(threadId);
      });
      break;
    }
    case "threadPrompt": {
      const text = "text" in message ? message.text : undefined;
      const images = "images" in message ? message.images : [];
      respond(async () => {
        if (
          !threads ||
          typeof threadId !== "string" ||
          typeof text !== "string" ||
          text.length > 1_000_000
        ) {
          throw new TypeError("Invalid Thread prompt request");
        }
        return await threads.prompt(threadId, text, promptImages(images));
      });
      break;
    }
    case "threadSetConfig": {
      const configId = "configId" in message ? message.configId : undefined;
      const value = "value" in message ? message.value : undefined;
      respond(async () => {
        if (
          !threads ||
          typeof threadId !== "string" ||
          typeof configId !== "string" ||
          configId.length === 0 ||
          configId.length > 256 ||
          (typeof value !== "string" && typeof value !== "boolean") ||
          (typeof value === "string" && value.length > 10_000)
        ) {
          throw new TypeError("Invalid Thread configuration request");
        }
        await threads.setConfig(threadId, configId, value);
        return {};
      });
      break;
    }
    case "threadCancel": {
      respond(async () => {
        if (!threads || typeof threadId !== "string") {
          throw new TypeError("Invalid Thread cancel request");
        }
        await threads.cancel(threadId);
        return {};
      });
      break;
    }
    case "acpRespondPermission": {
      const interactionId =
        "interactionId" in message ? message.interactionId : undefined;
      const response = "response" in message ? message.response : undefined;
      respond(() => {
        if (!acp || typeof interactionId !== "string") {
          throw new TypeError("Invalid ACP permission request");
        }
        acp.respondPermission(interactionId, permissionResponse(response));
        return {};
      });
      break;
    }
    case "acpRespondElicitation": {
      const interactionId =
        "interactionId" in message ? message.interactionId : undefined;
      const response = "response" in message ? message.response : undefined;
      respond(() => {
        if (!acp || typeof interactionId !== "string") {
          throw new TypeError("Invalid ACP elicitation request");
        }
        acp.respondElicitation(interactionId, elicitationResponse(response));
        return {};
      });
      break;
    }
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
  const profilePath =
    process.env.MISCHIEF_HOST_PROFILE ?? path.join(parent, "profile");
  const releaseProfile = await acquireProfileOwnership(profilePath);
  const installer = new HostAgentInstaller(profilePath);
  let threads: HostThreads | undefined;
  const acp = new HostAcpManager(profilePath, (event) => {
    if (threads) {
      threads.event(event);
    } else {
      send(event);
    }
  });
  try {
    threads = await HostThreads.open(profilePath, acp, send);
  } catch (error) {
    await releaseProfile();
    throw error;
  }
  let releaseOwnership: (() => Promise<void>) | undefined;
  try {
    releaseOwnership = await acquireHostOwnership(socketPath);
  } catch (error) {
    await releaseProfile();
    throw error;
  }
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
          command(message, acp, threads, installer, (response) => {
            writeClient(client, `${JSON.stringify(response)}\n`);
          });
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
          writeClient(
            client,
            `${JSON.stringify({ threads: threads.snapshot(), type: "threads" })}\n`
          );
          for (const queue of threads.queueSnapshots()) {
            writeClient(client, `${JSON.stringify(queue)}\n`);
          }
          for (const interaction of acp.pendingEvents()) {
            writeClient(client, `${JSON.stringify(interaction)}\n`);
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
    try {
      await releaseOwnership();
    } finally {
      await releaseProfile();
    }
    throw error;
  }
  const socket = await lstat(socketPath);
  process.on("SIGTERM", () => {
    server.close();
    void (async () => {
      acp.dispose();
      try {
        const current = await lstat(socketPath);
        if (current.dev === socket.dev && current.ino === socket.ino) {
          await rm(socketPath);
        }
      } catch (error) {
        process.stderr.write(`Socket cleanup failed: ${String(error)}\n`);
      } finally {
        try {
          try {
            await releaseOwnership();
          } finally {
            await releaseProfile();
          }
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
