import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyEdits, modify, parse } from "jsonc-parser/lib/esm/main.js";
import * as vscode from "vscode";

import { isDefined, isNonEmpty, isRecord } from "./present";

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
const PROJECT_HUES = [0, 35, 60, 120, 180, 225, 285] as const;
const WORKSPACE_VARIANTS = [
  { hue: -12, neutral: 0.12 },
  { hue: -8, neutral: 0.24 },
  { hue: -4, neutral: 0.36 },
  { hue: 4, neutral: 0.48 },
  { hue: 8, neutral: 0.6 },
  { hue: 12, neutral: 0.72 },
] as const;

type Colors = Record<string, string>;

interface Rgba {
  alpha: number;
  blue: number;
  green: number;
  red: number;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const rgba = (color: string): Rgba | undefined => {
  const value = color.slice(1);
  if (!color.startsWith("#") || ![3, 4, 6, 8].includes(value.length)) {
    return undefined;
  }
  const expanded =
    value.length < 5
      ? // oxlint-disable-next-line typescript/no-misused-spread -- validated hex is ASCII
        [...value].map((character) => character.repeat(2)).join("")
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

const hash = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

const hex = (color: Rgba): string =>
  `#${[color.red, color.green, color.blue]
    .map((channel) => Math.round(channel * 255))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;

const hsl = (hue: number, lightness: number, alpha: number): string => {
  const saturation = 0.7;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const sectors = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const [red, green, blue] = sectors[Math.floor(hue / 60)] ?? sectors[0] ?? [];
  const offset = lightness - chroma / 2;
  return `#${[red + offset, green + offset, blue + offset, alpha]
    .map((channel) => Math.round(channel * 255))
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
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
  if (!isNonEmpty(active)) {
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
  workspacePath: string,
  projectPath = workspacePath
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

  const projectHash = hash(projectPath);
  const workspaceHash = hash(workspacePath);
  const baseHue =
    PROJECT_HUES[projectHash.readUInt32BE(0) % PROJECT_HUES.length];
  if (baseHue === undefined) {
    return undefined;
  }
  const linked = workspacePath !== projectPath;
  const variant = linked
    ? WORKSPACE_VARIANTS[
        workspaceHash.readUInt32BE(4) % WORKSPACE_VARIANTS.length
      ]
    : undefined;
  const hue = (baseHue + (variant?.hue ?? 0) + 360) % 360;
  const color = rgba(hsl(hue, 0.5, 0.18));
  if (!color) {
    return undefined;
  }
  const displayed = composite(color, base);
  const neutral = luminance(base) < 0.5 ? 0 : 1;
  const amount = variant?.neutral ?? 0;
  const selected = {
    alpha: 1,
    blue: displayed.blue * (1 - amount) + neutral * amount,
    green: displayed.green * (1 - amount) + neutral * amount,
    red: displayed.red * (1 - amount) + neutral * amount,
  };
  const [foreground] = foregrounds.toSorted(
    (left, right) =>
      contrast(selected, right.color) - contrast(selected, left.color)
  );
  if (!isDefined(foreground) || contrast(selected, foreground.color) < 4.5) {
    return undefined;
  }
  const value = hex(selected);
  return Object.fromEntries<string>([
    ...WINDOW_BACKGROUND_KEYS.map((key) => [key, value] as const),
    ...WINDOW_FOREGROUND_KEYS.map((key) => [key, foreground.value] as const),
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

const readWorkspaceSettings = async (
  workspacePath: string
): Promise<{
  file: string;
  settings: Record<string, unknown>;
  source: string;
}> => {
  const file = path.join(workspacePath, ".vscode", "settings.json");
  let source = "{\n}\n";
  try {
    source = await readFile(file, "utf-8");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const errors: { error: number; length: number; offset: number }[] = [];
  const settings = object(
    parse(source, errors, {
      allowTrailingComma: true,
    })
  );
  if (!settings || errors.length) {
    throw new Error(`Invalid Workspace settings: ${file}`);
  }
  return { file, settings, source };
};

const windowColor = (value: unknown): string | undefined => {
  const colors = object(value);
  if (!colors) {
    return undefined;
  }
  for (const key of ["titleBar.activeBackground", ...WINDOW_BACKGROUND_KEYS]) {
    const color = colors[key];
    if (typeof color === "string" && rgba(color)) {
      return color;
    }
  }
  for (const [key, nested] of Object.entries(colors)) {
    if (key.startsWith("[")) {
      const color = windowColor(nested);
      if (isNonEmpty(color)) {
        return color;
      }
    }
  }
  return undefined;
};

export const workspaceWindowColor = async (
  workspacePath: string
): Promise<string | undefined> => {
  try {
    const { settings } = await readWorkspaceSettings(workspacePath);
    return windowColor(settings["workbench.colorCustomizations"]);
  } catch {
    return undefined;
  }
};

export const assignWorkspaceColors = async (
  workspacePath: string,
  projectPath = workspacePath
): Promise<boolean> => {
  const { file, settings, source } = await readWorkspaceSettings(workspacePath);
  const existing = object(settings["workbench.colorCustomizations"]);
  if (hasWindowColors(existing)) {
    return false;
  }
  const themePath = activeThemePath();
  if (!isNonEmpty(themePath)) {
    return false;
  }
  const overrides = workspaceColorOverrides(
    await readThemeColors(themePath),
    workspacePath,
    projectPath
  );
  if (!overrides) {
    return false;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    applyEdits(
      source,
      modify(
        source,
        ["workbench.colorCustomizations"],
        { ...existing, ...overrides },
        {
          formattingOptions: {
            insertFinalNewline: true,
            insertSpaces: true,
            tabSize: 2,
          },
        }
      )
    )
  );
  return true;
};

export const ensureWorkspaceColors = async (
  workspacePath: string,
  projectPath = workspacePath
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
  if (!isNonEmpty(themePath)) {
    return false;
  }
  const overrides = workspaceColorOverrides(
    await readThemeColors(themePath),
    workspacePath,
    projectPath
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
