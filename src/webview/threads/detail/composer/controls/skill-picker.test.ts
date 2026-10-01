import { describe, expect, test } from "vitest";

import type { ThreadCommand } from "../../../../../threads/model";
import { skillPickerGroups } from "./skill-picker";

const commands: ThreadCommand[] = [
  {
    description: "Review repository changes",
    name: "skill:ponytail-review",
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Main skill",
    name: "skill:ponytail",
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Audit",
    name: "skill:ponytail-audit",
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Review code",
    name: "skill:code-review",
    source: "git:github.com/mattpocock/skills",
  },
  { description: "A local skill", name: "skill:solo", source: "local" },
  { description: "Not a skill", name: "review" },
];

const labels = (query?: string) =>
  skillPickerGroups(commands, query).map(({ entries, name, source }) => ({
    entries: entries.map(({ command, label }) => ({
      command: command.name,
      label,
    })),
    name,
    source,
  }));

describe("skill picker groups", () => {
  test("filters skills and sorts them under repository source names", () => {
    expect(labels()).toStrictEqual([
      {
        entries: [
          { command: "skill:ponytail", label: "ponytail" },
          { command: "skill:ponytail-audit", label: "ponytail-audit" },
          { command: "skill:ponytail-review", label: "ponytail-review" },
        ],
        name: "DietrichGebert/ponytail",
        source: "git:github.com/DietrichGebert/ponytail",
      },
      {
        entries: [{ command: "skill:solo", label: "solo" }],
        name: "local",
        source: "local",
      },
      {
        entries: [{ command: "skill:code-review", label: "code-review" }],
        name: "mattpocock/skills",
        source: "git:github.com/mattpocock/skills",
      },
    ]);
  });

  test("searches skill names and descriptions case-insensitively", () => {
    expect(labels("REPOSITORY")).toStrictEqual([
      {
        entries: [
          { command: "skill:ponytail-review", label: "ponytail-review" },
        ],
        name: "DietrichGebert/ponytail",
        source: "git:github.com/DietrichGebert/ponytail",
      },
    ]);
    expect(labels("solo")[0]?.entries[0]?.label).toBe("solo");
  });
});
