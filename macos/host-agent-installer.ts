import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import agentConfig from "../shared/agents/config.json";
import { isAgentId } from "../shared/threads/record.js";
import type { AgentId } from "../shared/threads/record.js";
import { HostAcpConnection } from "./host-acp.js";
import type { HostAgentLaunch } from "./host-acp.js";

const VERSION = /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$/u;
const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const installedLaunch = (
  profilePath: string,
  agentId: AgentId,
  version: string
): HostAgentLaunch => {
  const config = agentConfig[agentId];
  return {
    args: [
      path.join(
        profilePath,
        "agents",
        agentId,
        "versions",
        version,
        "node_modules",
        config.package,
        config.bin
      ),
    ],
    command: process.execPath,
    ...(agentId === "magpi-acp"
      ? { env: { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" } }
      : {}),
  };
};

const probe = async (launch: HostAgentLaunch): Promise<void> => {
  const connection = new HostAcpConnection(launch, {
    elicitation: async () => await Promise.resolve({ action: "decline" }),
    error: () => {
      /* Initialization failures reject inspect(). */
    },
    permission: async () =>
      await Promise.resolve({ outcome: { outcome: "cancelled" } }),
    update: () => {
      /* A probe has no live Thread. */
    },
  });
  try {
    await connection.inspect();
  } finally {
    connection.dispose();
  }
};

interface InstallerOptions {
  probe?: (launch: HostAgentLaunch) => Promise<void>;
  runNpm?: (args: string[], cwd: string) => Promise<string>;
}

/** Performs explicit first-time installs into the Host's private Agent layout. */
export class HostAgentInstaller {
  private readonly pending = new Map<
    AgentId,
    Promise<{ agentId: AgentId; version: string }>
  >();
  private readonly probe: (launch: HostAgentLaunch) => Promise<void>;
  private readonly profilePath: string;
  private readonly runNpm: (args: string[], cwd: string) => Promise<string>;

  constructor(profilePath: string, options: InstallerOptions = {}) {
    this.profilePath = profilePath;
    this.probe = options.probe ?? probe;
    this.runNpm =
      options.runNpm ??
      (async (args, cwd) => {
        const npm = path.join(
          path.dirname(process.execPath),
          "npm/bin/npm-cli.js"
        );
        const child = spawn(process.execPath, [npm, ...args], {
          cwd,
          env: { ...process.env, npm_config_update_notifier: "false" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let failure: string | undefined;
        const stop = (message: string): void => {
          failure ??= message;
          child.kill();
        };
        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.length + stderr.length > 1_000_000) {
            stop("npm output exceeded 1 MB");
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          if (stdout.length + stderr.length > 1_000_000) {
            stop("npm output exceeded 1 MB");
          }
        });
        const timeout = setTimeout(
          () => {
            stop("npm timed out");
          },
          args[0] === "view" ? 15_000 : 180_000
        );
        try {
          const result: unknown = await once(child, "exit");
          const code =
            Array.isArray(result) && typeof result[0] === "number"
              ? result[0]
              : undefined;
          if (failure !== undefined) {
            throw new Error(failure);
          }
          if (code !== 0) {
            throw new Error(stderr.trim() || `npm exited with ${String(code)}`);
          }
          return stdout.trim();
        } finally {
          clearTimeout(timeout);
        }
      });
  }

  async status(): Promise<{ agentId: AgentId; version?: string }[]> {
    return await Promise.all(
      Object.keys(agentConfig).map(async (rawAgentId) => {
        if (!isAgentId(rawAgentId)) {
          throw new Error(`Unknown Agent configuration: ${rawAgentId}`);
        }
        const activePath = path.join(
          this.profilePath,
          "agents",
          rawAgentId,
          "active.json"
        );
        try {
          const active: unknown = JSON.parse(
            await readFile(activePath, "utf-8")
          );
          if (
            typeof active === "object" &&
            active !== null &&
            "version" in active &&
            typeof active.version === "string" &&
            VERSION.test(active.version) &&
            (await exists(
              installedLaunch(this.profilePath, rawAgentId, active.version)
                .args[0]
            ))
          ) {
            return { agentId: rawAgentId, version: active.version };
          }
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
        return { agentId: rawAgentId };
      })
    );
  }

  async install(
    rawAgentId: string
  ): Promise<{ agentId: AgentId; version: string }> {
    if (!isAgentId(rawAgentId)) {
      throw new Error(`Unknown Agent: ${rawAgentId}`);
    }
    const agentId = rawAgentId;
    const existing = this.pending.get(agentId);
    if (existing) {
      return await existing;
    }
    const job = this.installAgent(agentId);
    this.pending.set(agentId, job);
    try {
      return await job;
    } finally {
      this.pending.delete(agentId);
    }
  }

  private async installAgent(
    agentId: AgentId
  ): Promise<{ agentId: AgentId; version: string }> {
    const config = agentConfig[agentId];
    const agentRoot = path.join(this.profilePath, "agents", agentId);
    if (await exists(path.join(agentRoot, "active.json"))) {
      throw new Error(`Agent is already installed: ${agentId}`);
    }
    const version = await this.runNpm(
      ["view", `${config.package}@latest`, "version"],
      this.profilePath
    );
    if (!VERSION.test(version)) {
      throw new Error(`Invalid ${config.name} release version`);
    }
    const versions = path.join(agentRoot, "versions");
    const staged = path.join(versions, `.staging-${randomUUID()}`);
    const target = path.join(versions, version);
    await mkdir(staged, { mode: 0o700, recursive: true });
    try {
      await this.runNpm(
        [
          "install",
          "--no-package-lock",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-progress",
          `${config.package}@${version}`,
        ],
        staged
      );
      const manifest: unknown = JSON.parse(
        await readFile(
          path.join(staged, "node_modules", config.package, "package.json"),
          "utf-8"
        )
      );
      const launch = installedLaunch(this.profilePath, agentId, version);
      const stagedLaunch = {
        ...launch,
        args: [path.join(staged, "node_modules", config.package, config.bin)],
      };
      if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("version" in manifest) ||
        manifest.version !== version ||
        !(await exists(stagedLaunch.args[0]))
      ) {
        throw new Error(`${config.name} install is incomplete`);
      }
      await this.probe(stagedLaunch);
      try {
        await rename(staged, target);
      } catch (error) {
        if (!(await exists(target))) {
          throw error;
        }
        await this.probe(installedLaunch(this.profilePath, agentId, version));
      }
      const temporary = path.join(agentRoot, `.active-${randomUUID()}.json`);
      try {
        await writeFile(temporary, JSON.stringify({ version }), {
          mode: 0o600,
        });
        await rename(temporary, path.join(agentRoot, "active.json"));
      } finally {
        await rm(temporary, { force: true });
      }
      return { agentId, version };
    } finally {
      await rm(staged, { force: true, recursive: true });
    }
  }
}
