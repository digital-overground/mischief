import { describe, expect, test } from "vitest";

import type { ThreadCommand } from "../../../../../threads/model";
import { skillPickerGroups } from "./skill-picker";

const commands: ThreadCommand[] = [
  {
    description: "Review repository changes",
    name: "skill:ponytail-review",
    skill: true,
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Main skill",
    name: "skill:ponytail",
    skill: true,
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Audit",
    name: "skill:ponytail-audit",
    skill: true,
    source: "git:github.com/DietrichGebert/ponytail",
  },
  {
    description: "Review code",
    name: "skill:code-review",
    skill: true,
    source: "git:github.com/mattpocock/skills",
  },
  {
    description: "A local skill",
    name: "skill:solo",
    skill: true,
    source: "local",
  },
  { description: "Not a skill", name: "review", skill: false },
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

  test("keeps generic ACP command names for Codex and Claude", () => {
    const groups = skillPickerGroups([
      { description: "A skill", name: "$review" },
      { description: "A command", name: "clear" },
    ]);
    expect(groups[0]?.name).toBe("Other commands");
    expect(
      groups.flatMap(({ entries }) => entries.map(({ label }) => label))
    ).toStrictEqual(expect.arrayContaining(["$review", "clear"]));
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
