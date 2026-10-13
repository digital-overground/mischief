import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { AgentManager } from "./manager";
import type { AgentStatus } from "./manager";

const directories: string[] = [];

describe("managed Agent installations", () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      })
    );
  });

  test("publishes one ordered full snapshot when an Agent changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-agents-"));
    directories.push(root);
    const manager = new AgentManager(root, root, undefined, async () => {
      await Promise.resolve();
    });
    const initial = manager.snapshot();
    expect(initial.map(({ id }) => id)).toStrictEqual([
      "magpi-acp",
      "claude-agent-acp",
      "codex-acp",
    ]);
    expect(initial.map(({ state }) => state)).toStrictEqual([
      "waiting",
      "missing",
      "missing",
    ]);
    const updates: AgentStatus[][] = [];
    const unsubscribe = manager.onChange((statuses) => {
      updates.push(statuses);
    });
    manager.connected("codex-acp", "2.1.1");
    expect(updates).toStrictEqual([
      [initial[0], initial[1], { ...initial[2], installedVersion: "2.1.1" }],
    ]);
    expect(manager.snapshot()).toStrictEqual(updates[0]);
    unsubscribe();
    manager.connected("codex-acp", "2.1.2");
    expect(updates).toHaveLength(1);
  });

  test("requires opt-in, verifies updates and retains the previous version on failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-agents-"));
    directories.push(root);
    let latest = "2.1.1";
    let failProbe = false;
    const installed: string[] = [];
    const manager = new AgentManager(
      root,
      root,
      undefined,
      async (launch) => {
        await Promise.resolve();
        if (failProbe || !launch.args[0]?.endsWith("dist/index.js")) {
          throw new Error("Agent handshake failed");
        }
      },
      {
        installPackage: async (spec, cwd) => {
          installed.push(spec);
          const directory = path.join(
            cwd,
            "node_modules",
            "@agentclientprotocol",
            "codex-acp"
          );
          await mkdir(path.join(directory, "dist"), { recursive: true });
          await writeFile(
            path.join(directory, "package.json"),
            JSON.stringify({ version: spec.split("@").at(-1) })
          );
          await writeFile(
            path.join(directory, "dist", "index.js"),
            "// test\n"
          );
        },
        version: async () => await Promise.resolve(latest),
      }
    );
    expect(() => manager.launch("codex-acp")).toThrow("not installed");
    await manager.check("codex-acp");
    expect(installed).toStrictEqual([]);
    await manager.install("codex-acp");
    const first = manager.launch("codex-acp");
    expect({ installed, path: first.args[0] }).toStrictEqual({
      installed: ["@agentclientprotocol/codex-acp@2.1.1"],
      path: path.join(
        root,
        "agents",
        "codex-acp",
        "versions",
        "2.1.1",
        "node_modules",
        "@agentclientprotocol",
        "codex-acp",
        "dist",
        "index.js"
      ),
    });
    latest = "2.1.2";
    failProbe = true;
    await manager.check("codex-acp", true);
    expect({
      launch: manager.launch("codex-acp"),
      status: manager.snapshot().find(({ id }) => id === "codex-acp"),
    }).toStrictEqual({
      launch: first,
      status: {
        error:
          "Update check failed; the previous version is still available. See Mischief output.",
        id: "codex-acp",
        installedVersion: "2.1.1",
        latestVersion: "2.1.2",
        managed: true,
        name: "Codex",
        state: "unknown",
      },
    });
    failProbe = false;
    await manager.check("codex-acp", true);
    expect(
      JSON.parse(
        await readFile(
          path.join(root, "agents", "codex-acp", "active.json"),
          "utf-8"
        )
      )
    ).toStrictEqual({ version: "2.1.2" });
  });

  test("accepts Codex as the only available Agent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-agents-"));
    directories.push(root);
    const codex = path.join(root, "agents", "codex-acp");
    const bin = path.join(
      codex,
      "versions",
      "2.2.2",
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist"
    );
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "index.js"), "// test\n");
    await writeFile(
      path.join(codex, "active.json"),
      JSON.stringify({ version: "2.2.2" })
    );
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const manager = new AgentManager(root, root, undefined, async () => {
        await Promise.resolve();
      });
      expect(manager.availableAgents()).toStrictEqual(["codex-acp"]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("explicit MagPi override wins over a managed install", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-agents-"));
    directories.push(root);
    const manager = new AgentManager(
      root,
      root,
      "/dev/magpi/dist/index.js",
      async () => {
        await Promise.resolve();
      }
    );
    expect(manager.launch("magpi-acp")).toStrictEqual({
      args: ["/dev/magpi/dist/index.js"],
      command: "node",
      env: { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
    });
  });
});
