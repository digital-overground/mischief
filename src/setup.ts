import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

import type { AgentLaunch } from "./threads/acp";
import type { SetupOption } from "./webview/protocol";

const ADDON_SOURCES = {
  "ask-user": "npm:pi-ask-user",
  "matt-pocock-skills": "git:github.com/mattpocock/skills",
  ponytail: "git:github.com/DietrichGebert/ponytail",
  todo: "npm:@juicesharp/rpiv-todo",
} as const;

export const RECOMMENDED_ADDONS: SetupOption[] = [
  {
    description:
      "Highly recommended — shows agent plans as live, persistent checklists in Mischief.",
    id: "todo",
    label: "Todo",
  },
  {
    description:
      "Highly recommended — lets the agent ask structured questions with selectable answers.",
    id: "ask-user",
    label: "Ask User",
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

export const addOnInstallCommand = (selected: string[]): string | undefined => {
  const sources = RECOMMENDED_ADDONS.flatMap(({ id }) => {
    const source = ADDON_SOURCES[id as keyof typeof ADDON_SOURCES];
    return selected.includes(id) && source ? [source] : [];
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
