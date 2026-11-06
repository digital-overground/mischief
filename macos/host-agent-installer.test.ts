import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { HostAgentInstaller } from "./host-agent-installer";

const roots: string[] = [];

describe("Host Agent installer", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { force: true, recursive: true });
      })
    );
  });

  test("publishes a probed first-time install atomically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-agent-"));
    roots.push(root);
    const installed: string[] = [];
    const probed: string[] = [];
    const installer = new HostAgentInstaller(root, {
      probe: async (launch) => {
        await Promise.resolve();
        probed.push(launch.args[0] ?? "");
      },
      runNpm: async (args, cwd) => {
        if (args[0] === "view") {
          return await Promise.resolve("2.1.1");
        }
        const spec = args.at(-1) ?? "";
        installed.push(spec);
        const directory = path.join(
          cwd,
          "node_modules/@agentclientprotocol/codex-acp"
        );
        await mkdir(path.join(directory, "dist"), { recursive: true });
        await writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ version: "2.1.1" })
        );
        await writeFile(path.join(directory, "dist/index.js"), "// fake\n");
        return "";
      },
    });
    await expect(installer.status()).resolves.toStrictEqual([
      { agentId: "magpi-acp" },
      { agentId: "claude-agent-acp" },
      { agentId: "codex-acp" },
    ]);
    await expect(
      Promise.all([
        installer.install("codex-acp"),
        installer.install("codex-acp"),
      ])
    ).resolves.toStrictEqual([
      { agentId: "codex-acp", version: "2.1.1" },
      { agentId: "codex-acp", version: "2.1.1" },
    ]);
    expect({
      active: await readFile(
        path.join(root, "agents/codex-acp/active.json"),
        "utf-8"
      ),
      installed,
      probedInStaging: probed[0]?.includes(".staging-"),
    }).toStrictEqual({
      active: '{"version":"2.1.1"}',
      installed: ["@agentclientprotocol/codex-acp@2.1.1"],
      probedInStaging: true,
    });
    await expect(installer.status()).resolves.toContainEqual({
      agentId: "codex-acp",
      version: "2.1.1",
    });
    await expect(installer.install("codex-acp")).rejects.toThrow(
      "already installed"
    );
  });

  test("does not publish an Agent that fails its ACP probe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-host-agent-"));
    roots.push(root);
    const installer = new HostAgentInstaller(root, {
      probe: async () => {
        await Promise.resolve();
        throw new Error("ACP handshake failed");
      },
      runNpm: async (args, cwd) => {
        if (args[0] === "view") {
          return await Promise.resolve("1.0.0");
        }
        const directory = path.join(cwd, "node_modules/magpi-acp");
        await mkdir(path.join(directory, "dist"), { recursive: true });
        await writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ version: "1.0.0" })
        );
        await writeFile(path.join(directory, "dist/index.js"), "// fake\n");
        return "";
      },
    });
    await expect(installer.install("magpi-acp")).rejects.toThrow(
      "ACP handshake failed"
    );
    await expect(
      readFile(path.join(root, "agents/magpi-acp/active.json"), "utf-8")
    ).rejects.toThrow(/ENOENT/u);
  });
});
