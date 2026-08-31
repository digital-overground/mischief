import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "jsonc-parser";
import * as vscode from "vscode";

const BACKGROUND_KEYS = [
  "editor.background",
  "titleBar.activeBackground",
  "activityBar.background",
  "sideBar.background",
  "panel.background",
] as const;
const FOREGROUND_KEYS = [
  "foreground",
  "editor.foreground",
  "activityBar.foreground",
  "titleBar.activeForeground",
  "statusBar.foreground",
] as const;
const WINDOW_BACKGROUND_KEYS = [
  "activityBar.background",
  "commandCenter.background",
  "statusBar.background",
  "statusBar.debuggingBackground",
  "statusBar.noFolderBackground",
  "titleBar.activeBackground",
  "titleBar.inactiveBackground",
] as const;
const WINDOW_FOREGROUND_KEYS = [
  "activityBar.foreground",
  "commandCenter.foreground",
  "statusBar.foreground",
  "statusBar.debuggingForeground",
  "statusBar.noFolderForeground",
  "titleBar.activeForeground",
  "titleBar.inactiveForeground",
] as const;
const WINDOW_KEYS = new Set<string>([
  ...WINDOW_BACKGROUND_KEYS,
  ...WINDOW_FOREGROUND_KEYS,
]);

type Colors = Record<string, string>;

interface Rgba {
  alpha: number;
  blue: number;
  green: number;
  red: number;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const rgba = (color: string): Rgba | undefined => {
  const value = color.slice(1);
  if (!color.startsWith("#") || ![3, 4, 6, 8].includes(value.length)) {
    return undefined;
  }
  const expanded =
    value.length < 5
      ? [...value].map((character) => character.repeat(2)).join("")
      : value;
  if (!/^[\da-f]+$/iu.test(expanded)) {
    return undefined;
  }
  return {
    alpha:
      expanded.length === 8 ? Number.parseInt(expanded.slice(6), 16) / 255 : 1,
    blue: Number.parseInt(expanded.slice(4, 6), 16) / 255,
    green: Number.parseInt(expanded.slice(2, 4), 16) / 255,
    red: Number.parseInt(expanded.slice(0, 2), 16) / 255,
  };
};

const composite = (color: Rgba, background: Rgba): Rgba => ({
  alpha: 1,
  blue: color.blue * color.alpha + background.blue * (1 - color.alpha),
  green: color.green * color.alpha + background.green * (1 - color.alpha),
  red: color.red * color.alpha + background.red * (1 - color.alpha),
});

const linear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const luminance = (color: Rgba): number =>
  0.2126 * linear(color.red) +
  0.7152 * linear(color.green) +
  0.0722 * linear(color.blue);

const contrast = (left: Rgba, right: Rgba): number => {
  const values = [luminance(left), luminance(right)].toSorted((a, b) => b - a);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
};

export const readThemeColors = async (
  file: string,
  seen = new Set<string>()
): Promise<Colors> => {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) {
    throw new Error(`Circular color theme include: ${resolved}`);
  }
  seen.add(resolved);
  const errors: { error: number; length: number; offset: number }[] = [];
  const theme = object(
    parse(await readFile(resolved, "utf-8"), errors, {
      allowTrailingComma: true,
    })
  );
  if (!theme || errors.length) {
    throw new Error(`Invalid color theme: ${resolved}`);
  }
  const inherited =
    typeof theme.include === "string"
      ? await readThemeColors(
          path.resolve(path.dirname(resolved), theme.include),
          seen
        )
      : {};
  const colors = object(theme.colors);
  for (const [key, value] of Object.entries(colors ?? {})) {
    if (typeof value === "string") {
      inherited[key] = value;
    }
  }
  return inherited;
};

const activeThemePath = (): string | undefined => {
  const active = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("colorTheme");
  if (!active) {
    return undefined;
  }
  for (const extension of vscode.extensions.all) {
    const contributes = object(object(extension.packageJSON)?.contributes);
    const themes = contributes?.themes;
    if (!Array.isArray(themes)) {
      continue;
    }
    for (const candidate of themes) {
      const theme = object(candidate);
      if (
        theme &&
        typeof theme.path === "string" &&
        (theme.id === active || theme.label === active)
      ) {
        return path.resolve(extension.extensionPath, theme.path);
      }
    }
  }
  return undefined;
};

export const workspaceColorOverrides = (
  colors: Colors,
  workspacePath: string
): Colors | undefined => {
  const base = BACKGROUND_KEYS.map((key) => rgba(colors[key] ?? "")).find(
    (color) => color?.alpha === 1
  );
  const foregrounds = FOREGROUND_KEYS.map((key) => colors[key])
    .filter((value): value is string => typeof value === "string")
    .map((value) => ({ color: rgba(value), value }))
    .filter(
      (entry): entry is { color: Rgba; value: string } =>
        entry.color?.alpha === 1
    );
  if (!base || !foregrounds.length) {
    return undefined;
  }

  const mutedCandidates = [
    ...new Map(
      Object.values(colors)
        .map((value) => ({ color: rgba(value), value }))
        .filter((entry): entry is { color: Rgba; value: string } =>
          Boolean(entry.color && entry.color.alpha >= 0.08)
        )
        .map((entry) => [entry.value.toLowerCase(), entry] as const)
    ).values(),
  ]
    .map((entry) => {
      const displayed = composite(entry.color, base);
      const foreground = foregrounds
        .toSorted(
          (left, right) =>
            contrast(displayed, right.color) - contrast(displayed, left.color)
        )
        .at(0);
      return { ...entry, displayed, foreground };
    })
    .filter(
      (entry) =>
        entry.foreground &&
        contrast(entry.displayed, base) <= 1.75 &&
        contrast(entry.displayed, entry.foreground.color) >= 4.5
    )
    .toSorted((left, right) => left.value.localeCompare(right.value));
  const chromaticCandidates = mutedCandidates.filter(
    ({ color }) =>
      Math.max(color.red, color.green, color.blue) -
        Math.min(color.red, color.green, color.blue) >=
      0.2
  );
  const candidates =
    chromaticCandidates.length > 1 ? chromaticCandidates : mutedCandidates;
  if (!candidates.length) {
    return undefined;
  }

  const hash = createHash("sha256")
    .update(workspacePath)
    .digest()
    .readUInt32BE(0);
  const selected = candidates.at(hash % candidates.length);
  const foreground = selected?.foreground;
  if (!selected || !foreground) {
    return undefined;
  }
  return Object.fromEntries([
    ...WINDOW_BACKGROUND_KEYS.map((key) => [key, selected.value]),
    ...WINDOW_FOREGROUND_KEYS.map((key) => [key, foreground.value]),
  ]);
};

const hasWindowColors = (value: unknown): boolean => {
  const colors = object(value);
  return Boolean(
    colors &&
    Object.entries(colors).some(
      ([key, nested]) =>
        WINDOW_KEYS.has(key) || (key.startsWith("[") && hasWindowColors(nested))
    )
  );
};

export const ensureWorkspaceColors = async (
  workspacePath: string
): Promise<boolean> => {
  const configuration = vscode.workspace.getConfiguration(
    "workbench",
    vscode.Uri.file(workspacePath)
  );
  const inspected = configuration.inspect<Record<string, unknown>>(
    "colorCustomizations"
  );
  if (
    hasWindowColors(inspected?.workspaceValue) ||
    hasWindowColors(inspected?.workspaceFolderValue)
  ) {
    return false;
  }
  const themePath = activeThemePath();
  if (!themePath) {
    return false;
  }
  const overrides = workspaceColorOverrides(
    await readThemeColors(themePath),
    workspacePath
  );
  if (!overrides) {
    return false;
  }
  await configuration.update(
    "colorCustomizations",
    { ...object(inspected?.workspaceValue), ...overrides },
    vscode.ConfigurationTarget.Workspace
  );
  return true;
};
