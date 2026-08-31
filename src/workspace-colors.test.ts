import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ensureWorkspaceColors } from "./workspace-colors";

const vscode = vi.hoisted(() => ({
  extensions: [] as { extensionPath: string; packageJSON: unknown }[],
  update:
    vi.fn<(key: string, value: unknown, target: number) => Promise<void>>(),
  workspaceValue: undefined as Record<string, unknown> | undefined,
}));

vi.mock(
  import("vscode"),
  () =>
    ({
      ConfigurationTarget: { Workspace: 2 },
      Uri: { file: (fsPath: string) => ({ fsPath }) },
      extensions: {
        get all() {
          return vscode.extensions;
        },
      },
      workspace: {
        getConfiguration: () => ({
          get: () => "Test Theme",
          inspect: () => ({ workspaceValue: vscode.workspaceValue }),
          update: vscode.update,
        }),
      },
    }) as never
);

describe("workspace colors", () => {
  afterEach(() => {
    vscode.extensions = [];
    vscode.workspaceValue = undefined;
    vi.clearAllMocks();
  });

  test("adds subdued active-theme colors once without replacing other overrides", async () => {
    const folder = await mkdtemp("/tmp/mischief-theme-");
    try {
      await writeFile(
        path.join(folder, "base.jsonc"),
        `{
          // Theme files are JSON with comments and trailing commas.
          "colors": {
            "editor.background": "#22272e",
            "foreground": "#adbac7",
            "danger.background": "#ff0000",
            "accent.blue": "#4184e426",
            "accent.green": "#57ab5a4d",
            "accent.red": "#c93c3726",
          },
        }`
      );
      await writeFile(
        path.join(folder, "theme.json"),
        `{
          "include": "./base.jsonc",
          "colors": { "titleBar.activeBackground": "#2d333b" }
        }`
      );
      vscode.extensions = [
        {
          extensionPath: folder,
          packageJSON: {
            contributes: {
              themes: [{ label: "Test Theme", path: "./theme.json" }],
            },
          },
        },
      ];
      vscode.workspaceValue = { "editorCursor.foreground": "#ff0000" };
      vscode.update.mockImplementation((_key, value) => {
        vscode.workspaceValue = value as Record<string, unknown>;
        return Promise.resolve();
      });

      const applied = await ensureWorkspaceColors("/muted");
      const written = vscode.workspaceValue;
      const palette = new Set([
        "#22272e",
        "#adbac7",
        "#ff0000",
        "#4184e426",
        "#57ab5a4d",
        "#c93c3726",
        "#2d333b",
      ]);
      expect({
        applied,
        bright: written?.["titleBar.activeBackground"] === "#ff0000",
        mutedAccent: new Set(["#4184e426", "#c93c3726"]).has(
          String(written?.["titleBar.activeBackground"])
        ),
        preserved: written?.["editorCursor.foreground"],
        themeOnly: Object.values(written ?? {}).every((value) =>
          palette.has(String(value))
        ),
      }).toStrictEqual({
        applied: true,
        bright: false,
        mutedAccent: true,
        preserved: "#ff0000",
        themeOnly: true,
      });

      const reapplied = await ensureWorkspaceColors("/muted");
      expect({
        reapplied,
        writes: vscode.update.mock.calls.length,
      }).toStrictEqual({
        reapplied: false,
        writes: 1,
      });
    } finally {
      await rm(folder, { force: true, recursive: true });
    }
  });
});
