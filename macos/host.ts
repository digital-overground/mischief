/* oxlint-disable promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- async work is dispatched from synchronous stdin events */
import {
  activateWorkspace,
  deactivateWorkspace,
  selectThread,
  snapshot,
} from "./library.js";

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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

state();
refresh().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
});
setInterval(() => {
  refresh().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
  });
}, 1000);
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
process.on("SIGTERM", () => {
  process.exit(0);
});
