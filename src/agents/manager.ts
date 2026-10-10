import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { exec } from "../exec";
import { isNonEmpty } from "../present";
import { commandExists } from "../setup";
import type { AgentLaunch } from "../threads/acp/models";
import type { AgentSetting } from "../webview/protocol";
import {
  AGENTS,
  AGENT_IDS,
  compareVersions,
  latestAgentVersion,
} from "./update";
import type { AgentId } from "./update";

const VERSION = /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$/u;
const runNpm = async (args: string[], cwd: string): Promise<string> => {
  // npm.cmd requires cmd.exe on Windows. Arguments contain only fixed package names and validated versions.
  const { stdout } = await exec(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    {
      cwd,
      env: { ...process.env, npm_config_update_notifier: "false" },
      shell: process.platform === "win32",
      signal: AbortSignal.timeout(args[0] === "view" ? 15_000 : 180_000),
    }
  );
  return stdout.trim();
};

const npmVersion = async (spec: string): Promise<string> =>
  await runNpm(["view", spec, "version"], process.cwd());

const npmInstall = async (spec: string, cwd: string): Promise<void> => {
  await runNpm(
    [
      "install",
      "--no-package-lock",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-progress",
      spec,
    ],
    cwd
  );
};

export class AgentManager {
  private readonly root: string;
  private readonly extensionPath: string;
  private readonly magpiOverride?: string;
  private readonly installPackage: (spec: string, cwd: string) => Promise<void>;
  private readonly probe: (launch: AgentLaunch) => Promise<void>;
  private readonly version: (spec: string) => Promise<string>;
  private readonly log: (message: string) => void;
  private readonly statuses = new Map<AgentId, AgentSetting>();
  private readonly pending = new Map<AgentId, Promise<void>>();
  private readonly lastChecked = new Map<AgentId, number>();
  private readonly listeners = new Set<(statuses: AgentSetting[]) => void>();
  private interval?: ReturnType<typeof setInterval>;

  constructor(
    root: string,
    extensionPath: string,
    magpiOverride: string | undefined,
    probe: (launch: AgentLaunch) => Promise<void>,
    options: {
      version?: (spec: string) => Promise<string>;
      installPackage?: (spec: string, cwd: string) => Promise<void>;
      log?: (message: string) => void;
    } = {}
  ) {
    this.root = path.join(root, "agents");
    this.extensionPath = extensionPath;
    const override = magpiOverride?.trim();
    this.magpiOverride = isNonEmpty(override) ? override : undefined;
    this.probe = probe;
    this.version = options.version ?? npmVersion;
    this.log =
      options.log ??
      (() => {
        /* No output channel in unit tests. */
      });
    this.installPackage = options.installPackage ?? npmInstall;
    for (const id of AGENT_IDS) {
      const installedVersion = this.activeVersion(id);
      this.statuses.set(id, {
        id,
        name: AGENTS[id].name,
        ...(installedVersion === undefined
          ? {}
          : { installedVersion, managed: true }),
        state: AgentManager.initialStatus(id, installedVersion),
      });
    }
  }

  private static initialStatus(
    id: AgentId,
    version?: string
  ): AgentSetting["state"] {
    if (version !== undefined) {
      return "checking";
    }
    return id === "magpi-acp" ? "waiting" : "missing";
  }

  snapshot(): AgentSetting[] {
    return [...this.statuses.values()];
  }

  connected(id: AgentId, version?: string): void {
    if (isNonEmpty(version)) {
      this.set(id, { installedVersion: version });
    }
  }

  onChange(listener: (statuses: AgentSetting[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(id: AgentId, status: Partial<AgentSetting>): void {
    const previous = this.statuses.get(id);
    if (!previous) {
      return;
    }
    this.statuses.set(id, { ...previous, ...status });
    for (const listener of this.listeners) {
      listener(this.snapshot());
    }
  }

  private versionDirectory(id: AgentId, version: string): string {
    return path.join(this.root, id, "versions", version);
  }

  private static executable(id: AgentId, directory: string): string {
    return path.join(
      directory,
      "node_modules",
      AGENTS[id].package,
      AGENTS[id].bin
    );
  }

  activeVersion(id: AgentId): string | undefined {
    try {
      const active: unknown = JSON.parse(
        readFileSync(path.join(this.root, id, "active.json"), "utf-8")
      );
      if (
        active !== null &&
        typeof active === "object" &&
        "version" in active &&
        typeof active.version === "string" &&
        VERSION.test(active.version) &&
        existsSync(
          AgentManager.executable(id, this.versionDirectory(id, active.version))
        )
      ) {
        return active.version;
      }
    } catch {
      // Missing or invalid install: leave the Agent available for a fresh install.
    }
    return undefined;
  }

  piCli(): string | undefined {
    if (this.magpiOverride !== undefined) {
      return undefined;
    }
    const version = this.activeVersion("magpi-acp");
    if (version === undefined) {
      return undefined;
    }
    const directory = this.versionDirectory("magpi-acp", version);
    const candidates = [
      path.join(
        directory,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js"
      ),
      path.join(
        directory,
        "node_modules",
        "magpi-acp",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js"
      ),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }

  availableAgents(): AgentId[] {
    return AGENT_IDS.filter((id) => {
      if (id !== "magpi-acp") {
        return this.activeVersion(id) !== undefined;
      }
      const launch = this.launch(id);
      return launch.command === "node" && launch.args[0] !== undefined
        ? existsSync(launch.args[0])
        : commandExists(launch.command);
    });
  }

  launch(id: AgentId): AgentLaunch {
    if (id === "magpi-acp") {
      const candidate =
        this.magpiOverride ??
        path.resolve(this.extensionPath, "../magpi-acp/dist/index.js");
      if (this.magpiOverride !== undefined || existsSync(candidate)) {
        return candidate.endsWith(".js")
          ? {
              args: [candidate],
              command: "node",
              env: { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
            }
          : {
              args: [],
              command: candidate,
              env: { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
            };
      }
    }
    const version = this.activeVersion(id);
    if (version !== undefined) {
      return AgentManager.installedLaunch(
        id,
        this.versionDirectory(id, version)
      );
    }
    if (id === "magpi-acp") {
      return {
        args: [],
        command: "magpi-acp",
        env: { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
      };
    }
    throw new Error(
      `${AGENTS[id].name} is not installed. Install it from Mischief Settings.`
    );
  }

  private static installedLaunch(id: AgentId, directory: string): AgentLaunch {
    return {
      args: [AgentManager.executable(id, directory)],
      command: "node",
      ...(id === "magpi-acp"
        ? { env: { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" } }
        : {}),
    };
  }

  async check(id: AgentId, force = false): Promise<void> {
    if (this.pending.has(id)) {
      return await this.pending.get(id);
    }
    if (
      !force &&
      Date.now() - (this.lastChecked.get(id) ?? 0) < 24 * 60 * 60 * 1000
    ) {
      return;
    }
    const job = (async () => {
      this.set(id, { error: undefined, state: "checking" });
      try {
        const latestVersion = await latestAgentVersion(id, this.version);
        const installedVersion = this.activeVersion(id);
        const current = this.statuses.get(id);
        const comparison = compareVersions(
          installedVersion ?? current?.installedVersion ?? "",
          latestVersion
        );
        let state: AgentSetting["state"] = AgentManager.initialStatus(
          id,
          installedVersion
        );
        if (comparison === undefined && installedVersion !== undefined) {
          state = "unknown";
        } else if (comparison === -1) {
          state = "updateAvailable";
        } else if (comparison === 0) {
          state = "current";
        } else if (comparison === 1) {
          state = "newer";
        }
        this.set(id, {
          latestVersion,
          ...(installedVersion === undefined
            ? {}
            : { installedVersion, managed: true }),
          state,
        });
        if (installedVersion !== undefined && comparison === -1) {
          await this.installVersion(id, latestVersion);
        }
      } catch (error) {
        this.log(
          `${AGENTS[id].name} update check failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.set(id, {
          error:
            "Update check failed; the previous version is still available. See Mischief output.",
          state: "unknown",
        });
      }
    })();
    this.pending.set(id, job);
    try {
      await job;
    } finally {
      this.lastChecked.set(id, Date.now());
      this.pending.delete(id);
    }
  }

  async checkAll(): Promise<void> {
    // oxlint-disable-next-line typescript/promise-function-async -- passing the promise through to Promise.all
    await Promise.all(AGENT_IDS.map((id) => this.check(id)));
  }

  startAutoUpdates(): void {
    void this.checkAll();
    this.interval = setInterval(
      () => {
        void this.checkAll();
      },
      24 * 60 * 60 * 1000
    );
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  // Call only after an explicit confirmation; an active manifest is the user's durable opt-in for future updates.
  async install(id: AgentId): Promise<void> {
    if (this.pending.has(id)) {
      await this.pending.get(id);
    }
    const job = (async () => {
      this.set(id, { error: undefined, state: "installing" });
      try {
        const latest = await latestAgentVersion(id, this.version);
        await this.installVersion(id, latest);
      } catch (error) {
        this.log(
          `${AGENTS[id].name} install failed: ${error instanceof Error ? error.message : String(error)}`
        );
        this.set(id, {
          error:
            "Install failed; the previous version is still available. See Mischief output.",
          state: "unknown",
        });
        throw new Error(
          `Mischief could not install ${AGENTS[id].name}. See Mischief output.`,
          { cause: error }
        );
      }
    })();
    this.pending.set(id, job);
    try {
      await job;
    } finally {
      this.pending.delete(id);
    }
  }

  private async installVersion(id: AgentId, version: string): Promise<void> {
    if (!VERSION.test(version)) {
      throw new Error("Invalid Agent version");
    }
    this.set(id, { latestVersion: version, state: "installing" });
    const versions = path.join(this.root, id, "versions");
    const staged = path.join(versions, `.staging-${randomUUID()}`);
    const target = this.versionDirectory(id, version);
    await mkdir(staged, { recursive: true });
    try {
      if (!existsSync(AgentManager.executable(id, target))) {
        await this.installPackage(`${AGENTS[id].package}@${version}`, staged);
        const manifest: unknown = JSON.parse(
          readFileSync(
            path.join(
              staged,
              "node_modules",
              AGENTS[id].package,
              "package.json"
            ),
            "utf-8"
          )
        );
        if (
          manifest === null ||
          typeof manifest !== "object" ||
          !("version" in manifest) ||
          manifest.version !== version ||
          !existsSync(AgentManager.executable(id, staged))
        ) {
          throw new Error(`${AGENTS[id].name} install is incomplete`);
        }
        await this.probe(AgentManager.installedLaunch(id, staged));
        try {
          await rename(staged, target);
        } catch (error) {
          if (!existsSync(AgentManager.executable(id, target))) {
            throw error;
          }
        }
      }
      await this.probe(AgentManager.installedLaunch(id, target));
      const current = this.activeVersion(id);
      if (current !== undefined && compareVersions(current, version) === 1) {
        // Another window installed a newer version while we were staging.
        return;
      }
      const active = path.join(this.root, id, "active.json");
      const temp = path.join(this.root, id, `.active-${randomUUID()}.json`);
      try {
        await writeFile(temp, JSON.stringify({ version }));
        await rename(temp, active);
      } finally {
        await rm(temp, { force: true });
      }
      this.set(id, {
        error: undefined,
        installedVersion: version,
        latestVersion: version,
        managed: true,
        state: "current",
      });
      // ponytail: retain previous versions for rollback and running Threads; add pruning only if disk use becomes a problem.
    } finally {
      await rm(staged, { force: true, recursive: true });
    }
  }
}
