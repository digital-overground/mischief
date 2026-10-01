import type { ThreadCommand } from "../../../../../threads/model";

export interface SkillPickerGroup {
  name: string | undefined;
  entries: { command: ThreadCommand; label: string }[];
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { sensitivity: "base" }) ||
  left.localeCompare(right);

export const skillPickerGroups = (
  commands: ThreadCommand[],
  query = ""
): SkillPickerGroup[] => {
  const skills = commands
    .filter(({ name }) => name.startsWith("skill:"))
    .map((command) => ({
      command,
      name: command.name.slice("skill:".length),
    }))
    .filter(({ name }) => name.length > 0);
  const prefixes = new Set(
    skills.flatMap(({ name }) => {
      const separator = name.indexOf("-");
      return separator > 0 ? [name.slice(0, separator)] : [];
    })
  );
  const search = query.trim().toLowerCase();
  const groups = new Map<string | undefined, SkillPickerGroup>();

  for (const skill of skills) {
    if (
      search &&
      !`${skill.name}\n${skill.command.description}`
        .toLowerCase()
        .includes(search)
    ) {
      continue;
    }
    const separator = skill.name.indexOf("-");
    const prefix = separator > 0 ? skill.name.slice(0, separator) : undefined;
    const name = prefix ?? (prefixes.has(skill.name) ? skill.name : undefined);
    const label =
      name !== undefined && skill.name !== name
        ? skill.name.slice(name.length + 1)
        : skill.name;
    const group = groups.get(name) ?? { entries: [], name };
    group.entries.push({ command: skill.command, label });
    groups.set(name, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      entries: group.entries.toSorted((a, b) => compare(a.label, b.label)),
    }))
    .toSorted((a, b) =>
      compare(
        a.name ?? a.entries[0]?.label ?? "",
        b.name ?? b.entries[0]?.label ?? ""
      )
    );
};
