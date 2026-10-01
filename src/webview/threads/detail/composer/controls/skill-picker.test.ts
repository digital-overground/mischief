import { describe, expect, test } from "vitest";

import type { ThreadCommand } from "../../../../../threads/model";
import { skillPickerGroups } from "./skill-picker";

const commands: ThreadCommand[] = [
  { description: "Review repository changes", name: "skill:ponytail-review" },
  { description: "Main skill", name: "skill:ponytail" },
  { description: "Audit", name: "skill:ponytail-audit" },
  { description: "A standalone skill", name: "skill:solo" },
  { description: "Not a skill", name: "review" },
];

const labels = (query?: string) =>
  skillPickerGroups(commands, query).map(({ entries, name }) => ({
    entries: entries.map(({ command, label }) => ({
      command: command.name,
      label,
    })),
    name,
  }));

describe("skill picker groups", () => {
  test("filters skills, groups hyphenated names, and sorts entries", () => {
    expect(labels()).toStrictEqual([
      {
        entries: [
          { command: "skill:ponytail-audit", label: "audit" },
          { command: "skill:ponytail", label: "ponytail" },
          { command: "skill:ponytail-review", label: "review" },
        ],
        name: "ponytail",
      },
      {
        entries: [{ command: "skill:solo", label: "solo" }],
        name: undefined,
      },
    ]);
  });

  test("searches skill names and descriptions case-insensitively", () => {
    expect(labels("REPOSITORY")).toStrictEqual([
      {
        entries: [{ command: "skill:ponytail-review", label: "review" }],
        name: "ponytail",
      },
    ]);
    expect(labels("solo")[0]?.entries[0]?.label).toBe("solo");
  });
});
