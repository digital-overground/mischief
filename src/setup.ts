import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isRecord } from "./present";
import type { SetupOption } from "./webview/protocol";

const ADDON_SOURCES: Readonly<Record<string, string>> = {
  "matt-pocock-skills": "git:github.com/mattpocock/skills",
  ponytail: "git:github.com/DietrichGebert/ponytail",
  todo: "npm:@juicesharp/rpiv-todo",
};

export const RECOMMENDED_ADDONS: SetupOption[] = [
  {
    description:
      "Highly recommended — shows agent plans as live, persistent checklists in Mischief.",
    id: "todo",
    label: "Todo",
  },
  {
    description: "Keeps implementations minimal and avoids over-engineering.",
    id: "ponytail",
    label: "Ponytail",
  },
  {
    description:
      "Engineering workflows for debugging, TDD, reviews, and design.",
    id: "matt-pocock-skills",
    label: "Matt Pocock Skills",
  },
];

export const missingRecommendedAddons = (
  agentDir = process.env.PI_CODING_AGENT_DIR ??
    path.join(homedir(), ".pi", "agent")
): SetupOption[] => {
  let packages: unknown[] = [];
  try {
    const settings: unknown = JSON.parse(
      readFileSync(path.join(agentDir, "settings.json"), "utf-8")
    );
    packages =
      isRecord(settings) && Array.isArray(settings.packages)
        ? settings.packages
        : [];
  } catch {
    // Missing or invalid settings means no Pi packages are installed.
  }
  const installed = packages.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (isRecord(entry)) {
      const { source } = entry;
      return typeof source === "string" ? [source] : [];
    }
    return [];
  });
  return RECOMMENDED_ADDONS.filter(({ id }) => {
    const source = ADDON_SOURCES[id];
    return (
      source !== undefined &&
      !installed.some(
        (candidate) =>
          candidate === source || candidate.startsWith(`${source}@`)
      )
    );
  });
};

export const addOnInstallCommand = (
  selected: string[],
  piCli?: string
): string | undefined => {
  const sources = RECOMMENDED_ADDONS.flatMap(({ id }) => {
    const source = ADDON_SOURCES[id];
    return selected.includes(id) && source !== undefined ? [source] : [];
  });
  let command = "pi";
  if (piCli !== undefined) {
    const quotedCli =
      process.platform === "win32"
        ? `"${piCli}"`
        : `'${piCli.replaceAll("'", "'\\''")}'`;
    command = `node ${quotedCli}`;
  }
  return sources.length > 0
    ? sources.map((source) => `${command} install ${source}`).join(" && ")
    : undefined;
};

const executableExists = (candidate: string): boolean => {
  try {
    accessSync(
      candidate,
      process.platform === "win32" ? constants.F_OK : constants.X_OK
    );
    return true;
  } catch {
    return false;
  }
};

export const commandExists = (command: string): boolean => {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return executableExists(command);
  }
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((directory) =>
      extensions.some((extension) =>
        executableExists(path.join(directory, `${command}${extension}`))
      )
    );
};

const supportedNode = (): boolean => {
  if (!commandExists("node")) {
    return false;
  }
  const version = spawnSync("node", ["--version"], {
    encoding: "utf-8",
    shell: process.platform === "win32",
    timeout: 2000,
  });
  const match = /^v(?<major>\d+)\.(?<minor>\d+)\./u.exec(
    version.stdout
  )?.groups;
  return (
    match?.major !== undefined &&
    match.minor !== undefined &&
    (Number(match.major) > 22 ||
      (Number(match.major) === 22 && Number(match.minor) >= 19))
  );
};

export type SoftwareRequirement = "agents" | "git" | "node";

export const nextSoftwareRequirement = (
  hasAgent: boolean
): SoftwareRequirement | undefined => {
  if (!supportedNode() || !commandExists("npm")) {
    return "node";
  }
  if (!commandExists("git")) {
    return "git";
  }
  return hasAgent ? undefined : "agents";
};
