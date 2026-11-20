import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

const piAgentDir = (): string =>
  process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");

const todoSource = ADDON_SOURCES.todo;
const isTodoPackage = (entry: unknown): boolean => {
  if (typeof entry !== "string" && !isRecord(entry)) {
    return false;
  }
  const source = typeof entry === "string" ? entry : entry.source;
  return (
    typeof source === "string" &&
    (source === todoSource || source.startsWith(`${todoSource}@`))
  );
};

export const todoExtensionEnabled = (
  agentDir = piAgentDir()
): boolean | undefined => {
  try {
    const settings: unknown = JSON.parse(
      readFileSync(path.join(agentDir, "settings.json"), "utf-8")
    );
    if (!isRecord(settings) || !Array.isArray(settings.packages)) {
      return undefined;
    }
    const entry: unknown = settings.packages.find(isTodoPackage);
    return entry === undefined
      ? undefined
      : !isRecord(entry) ||
          !Array.isArray(entry.extensions) ||
          entry.extensions.length > 0;
  } catch {
    return undefined;
  }
};

export const setTodoExtensionEnabled = (
  enabled: boolean,
  agentDir = piAgentDir()
): void => {
  const filename = path.join(agentDir, "settings.json");
  const original = readFileSync(filename, "utf-8");
  const settings: unknown = JSON.parse(original);
  if (!isRecord(settings) || !Array.isArray(settings.packages)) {
    throw new Error("Invalid Pi package settings");
  }
  const todoPackages: unknown[] = settings.packages.filter(isTodoPackage);
  if (todoPackages.length === 0) {
    throw new Error("Pi Todo extension is not installed");
  }
  if (
    todoPackages.length !== 1 ||
    todoPackages.some(
      (entry) =>
        isRecord(entry) &&
        Array.isArray(entry.extensions) &&
        entry.extensions.length > 0
    )
  ) {
    throw new Error(
      "Pi Todo has custom package settings; configure it with pi config"
    );
  }
  settings.packages = settings.packages.map((entry: unknown) => {
    if (
      !isTodoPackage(entry) ||
      (typeof entry !== "string" && !isRecord(entry))
    ) {
      return entry;
    }
    const packageEntry: Record<string, unknown> =
      typeof entry === "string" ? { source: entry } : { ...entry };
    if (enabled) {
      delete packageEntry.extensions;
    } else {
      packageEntry.extensions = [];
    }
    return packageEntry;
  });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: statSync(filename).mode,
    });
    if (readFileSync(filename, "utf-8") !== original) {
      throw new Error("Pi settings changed while updating; retry");
    }
    renameSync(temporary, filename);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
};

export const missingRecommendedAddons = (
  agentDir = piAgentDir()
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
