import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  addOnInstallCommand,
  missingRecommendedAddons,
  missingSoftware,
  nextSoftwareRequirement,
  RECOMMENDED_ADDONS,
} from "./setup";

const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const directories: string[] = [];

describe("setup", () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.PATHEXT = originalPathExt;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("builds add-on installs from the allowlist in display order", () => {
    expect(RECOMMENDED_ADDONS.map(({ id }) => id)).toStrictEqual([
      "todo",
      "ask-user",
      "ponytail",
      "matt-pocock-skills",
    ]);
    expect(addOnInstallCommand(["unknown", "ponytail", "todo"])).toBe(
      "pi install npm:@juicesharp/rpiv-todo && pi install git:github.com/DietrichGebert/ponytail"
    );
  });

  test("does not recommend packages already installed by Pi", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mischief-addons-"));
    directories.push(directory);
    writeFileSync(
      path.join(directory, "settings.json"),
      JSON.stringify({
        packages: [
          "npm:@juicesharp/rpiv-todo",
          "npm:pi-ask-user",
          "git:github.com/DietrichGebert/ponytail",
          "git:github.com/mattpocock/skills",
        ],
      })
    );

    expect(missingRecommendedAddons(directory)).toStrictEqual([]);
  });

  test("reports missing Git alongside the agent tools", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mischief-setup-"));
    directories.push(directory);
    const extension = process.platform === "win32" ? ".CMD" : "";
    for (const command of ["node", "pi"]) {
      const executable = path.join(directory, `${command}${extension}`);
      writeFileSync(executable, "");
      chmodSync(executable, 0o755);
    }
    process.env.PATH = directory;
    process.env.PATHEXT = ".CMD";

    const launch = { args: [], command: "magpi-acp", env: {} };
    expect(missingSoftware(launch)).toStrictEqual(["Git", "MagPi ACP"]);
    expect(nextSoftwareRequirement(launch)).toBe("node");

    for (const command of ["npm", "git"]) {
      const executable = path.join(directory, `${command}${extension}`);
      writeFileSync(executable, "");
      chmodSync(executable, 0o755);
      expect(nextSoftwareRequirement(launch)).toBe(
        command === "npm" ? "git" : "agents"
      );
    }
  });
});
