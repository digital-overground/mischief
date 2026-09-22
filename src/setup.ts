import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isRecord } from "./present";
import type { AgentLaunch } from "./threads/acp";
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

export const addOnInstallCommand = (selected: string[]): string | undefined => {
  const sources = RECOMMENDED_ADDONS.flatMap(({ id }) => {
    const source = ADDON_SOURCES[id];
    return selected.includes(id) && source !== undefined ? [source] : [];
  });
  return sources.length > 0
    ? sources.map((source) => `pi install ${source}`).join(" && ")
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

export type SoftwareRequirement = "agents" | "git" | "node";

export const missingSoftware = (launch: AgentLaunch): string[] =>
  (
    [
      ["Node.js", commandExists("node")],
      ["Git", commandExists("git")],
      ["Pi", commandExists("pi")],
      [
        "MagPi ACP",
        launch.command === "node" && launch.args[0]
          ? existsSync(launch.args[0])
          : commandExists(launch.command),
      ],
    ] satisfies [string, boolean][]
  ).flatMap(([name, installed]) => (installed ? [] : [name]));

export const nextSoftwareRequirement = (
  launch: AgentLaunch
): SoftwareRequirement | undefined => {
  const missing = missingSoftware(launch);
  if (missing.includes("Node.js") || !commandExists("npm")) {
    return "node";
  }
  if (missing.includes("Git")) {
    return "git";
  }
  if (missing.includes("Pi") || missing.includes("MagPi ACP")) {
    return "agents";
  }
  return undefined;
};
