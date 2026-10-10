import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { isNonEmpty, isRecord } from "../present";
import { acpConnectionFactory, probeAgent } from "../threads/acp/acp";
import { AgentManager } from "./manager";
import type { AgentId } from "./update";

const ignore = (): void => {
  /* No live transcript in this smoke. */
};

const sessionReady = async (
  manager: AgentManager,
  id: AgentId,
  cwd: string
): Promise<boolean> => {
  const connection = acpConnectionFactory(
    manager.launch(id),
    ignore,
    ignore,
    ignore,
    id
  )({
    elicitation: async () => {
      await Promise.resolve();
      return { action: "cancel" };
    },
    error: ignore,
    permission: async () => {
      await Promise.resolve();
      return { cancelled: true };
    },
    update: ignore,
  });
  try {
    try {
      const session = await connection.create(cwd);
      return isNonEmpty(session.sessionId);
    } catch (error) {
      // No credentials is expected; the UI must receive a usable login action.
      const authentication = isRecord(error) ? error.authentication : undefined;
      return (
        isRecord(authentication) &&
        typeof authentication.label === "string" &&
        isNonEmpty(authentication.label)
      );
    }
  } finally {
    connection.dispose();
  }
};

// Opt-in network smoke: MISCHIEF_SMOKE_AGENTS=1 pnpm exec vitest run src/agents/manager.smoke.test.ts
// Add MISCHIEF_SMOKE_SESSIONS=1 to also open a session (no prompt or model charges).
describe("published ACP packages", () => {
  test.runIf(process.env.MISCHIEF_SMOKE_AGENTS === "1")(
    "install and initialize",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "mischief-smoke-agents-"));
      try {
        const manager = new AgentManager(root, root, undefined, probeAgent);
        const sessions: boolean[] = [];
        for (const id of [
          "magpi-acp",
          "claude-agent-acp",
          "codex-acp",
        ] as const) {
          // oxlint-disable-next-line no-await-in-loop -- keep the integration test from overloading npm's network
          await manager.install(id);
          expect(manager.launch(id).args[0]).toContain("dist/index.js");
          if (process.env.MISCHIEF_SMOKE_SESSIONS === "1") {
            // oxlint-disable-next-line no-await-in-loop -- sequential npm installs and ACP sessions use the same temporary storage
            sessions.push(await sessionReady(manager, id, root));
          }
        }
        expect(sessions).toStrictEqual(
          process.env.MISCHIEF_SMOKE_SESSIONS === "1" ? [true, true, true] : []
        );
        expect(manager.piCli()).toBeDefined();
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    300_000
  );
});
