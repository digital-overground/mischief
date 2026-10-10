import type { ThreadCommand } from "../../../../../threads/model";

export interface SkillPickerGroup {
  name: string;
  source: string | undefined;
  entries: { command: ThreadCommand; label: string }[];
}

const compare = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { sensitivity: "base" }) ||
  left.localeCompare(right);

const sourceName = (source: string | undefined, skill: boolean): string => {
  if (source === undefined) {
    return skill ? "Other skills" : "Other commands";
  }
  const withoutVersion = source.replace(/@[^/@]*$/u, "").replace(/\.git$/u, "");
  const gitPath = /^git:[^/]+\/(?<path>.+)$/u.exec(withoutVersion)?.groups
    ?.path;
  if (gitPath !== undefined && gitPath.length > 0) {
    return gitPath;
  }
  const separator = Math.max(
    withoutVersion.lastIndexOf("/"),
    withoutVersion.lastIndexOf(":")
  );
  return withoutVersion.slice(separator + 1) || source;
};

export const skillPickerGroups = (
  commands: ThreadCommand[],
  query = ""
): SkillPickerGroup[] => {
  const search = query.trim().toLowerCase();
  const groups = new Map<string, SkillPickerGroup>();

  for (const command of commands) {
    if (command.skill === false) {
      continue;
    }
    const skill = command.skill === true;
    const label =
      skill && command.name.startsWith("skill:")
        ? command.name.slice("skill:".length)
        : command.name;
    if (
      !label ||
      (search &&
        !`${label}\n${command.description}`.toLowerCase().includes(search))
    ) {
      continue;
    }
    const key = command.source ?? (skill ? "\u0000skills" : "\u0000commands");
    const group = groups.get(key) ?? {
      entries: [],
      name: sourceName(command.source, skill),
      source: command.source,
    };
    group.entries.push({ command, label });
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      entries: group.entries.toSorted((a, b) => compare(a.label, b.label)),
    }))
    .toSorted((a, b) => compare(a.name, b.name));
};
