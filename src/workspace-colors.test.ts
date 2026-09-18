import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { testValue } from "./test-value";
import {
  assignWorkspaceColors,
  ensureWorkspaceColors,
  workspaceColorOverrides,
  workspaceWindowColor,
} from "./workspace-colors";

const vscode = vi.hoisted(
  (): {
    extensions: { extensionPath: string; packageJSON: unknown }[];
    update: ReturnType<
      typeof vi.fn<
        (key: string, value: unknown, target: number) => Promise<void>
      >
    >;
    workspaceValue: Record<string, unknown> | undefined;
  } => ({
    extensions: [],
    update:
      vi.fn<(key: string, value: unknown, target: number) => Promise<void>>(),
    workspaceValue: undefined,
  })
);

vi.mock(import("vscode"), () =>
  testValue<never>({
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
  })
);

const colorLightness = (color: string): number => {
  const channels = [1, 3, 5].map((index) =>
    Number.parseInt(color.slice(index, index + 2), 16)
  );
  return (Math.max(...channels) + Math.min(...channels)) / 2;
};

describe("workspace colors", () => {
  afterEach(() => {
    vscode.extensions = [];
    vscode.workspaceValue = undefined;
    vi.clearAllMocks();
  });

  test("adds generated theme-compatible colors once without replacing other overrides", async () => {
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
      vscode.update.mockImplementation(async (_key, value) => {
        await Promise.resolve();
        vscode.workspaceValue = testValue<Record<string, unknown>>(value);
      });

      const applied = await ensureWorkspaceColors("/muted");
      const written = vscode.workspaceValue;
      expect({
        applied,
        color: written?.["titleBar.activeBackground"],
        preserved: written?.["editorCursor.foreground"],
      }).toStrictEqual({
        applied: true,
        color: testValue<unknown>(expect.stringMatching(/^#[\da-f]{6}$/iu)),
        preserved: "#ff0000",
      });

      const theme = {
        "editor.background": "#22272e",
        foreground: "#adbac7",
      };
      const projectColors = Array.from(
        { length: 100 },
        (_, index) =>
          workspaceColorOverrides(theme, `/project-${index}`)?.[
            "titleBar.activeBackground"
          ]
      );
      const project = "/project";
      const workspaceColor = workspaceColorOverrides(
        theme,
        "/worktree-a",
        project
      )?.["titleBar.activeBackground"];
      const mischief = "/Users/kyle.humphrey/Projects/_tools/mischief";
      const mischiefColors = [
        mischief,
        `${mischief}-composer-list-editing`,
        `${mischief}-workspace-color-families`,
      ].map(
        (workspace) =>
          workspaceColorOverrides(theme, workspace, mischief)?.[
            "titleBar.activeBackground"
          ] ?? ""
      );
      const lightnesses = mischiefColors.map(colorLightness);
      expect({
        bases: new Set(projectColors).size,
        spaced: Math.max(...lightnesses) - Math.min(...lightnesses) >= 30,
        stable:
          workspaceColorOverrides(theme, "/worktree-a", project)?.[
            "titleBar.activeBackground"
          ] === workspaceColor,
        varied:
          workspaceColorOverrides(theme, "/worktree-b", project)?.[
            "titleBar.activeBackground"
          ] !== workspaceColor,
      }).toStrictEqual({
        bases: 7,
        spaced: true,
        stable: true,
        varied: true,
      });

      const reapplied = await ensureWorkspaceColors("/muted");
      expect({
        reapplied,
        writes: vscode.update.mock.calls.length,
      }).toStrictEqual({
        reapplied: false,
        writes: 1,
      });

      const workspace = path.join(folder, "workspace");
      await mkdir(path.join(workspace, ".vscode"), { recursive: true });
      await writeFile(
        path.join(workspace, ".vscode", "settings.json"),
        '{ "editor.fontSize": 14 }'
      );
      const assigned = await assignWorkspaceColors(workspace);
      const settings = testValue<Record<string, unknown>>(
        JSON.parse(
          await readFile(
            path.join(workspace, ".vscode", "settings.json"),
            "utf-8"
          )
        )
      );
      const assignedColors = testValue<Record<string, unknown>>(
        settings["workbench.colorCustomizations"]
      );
      await expect(workspaceWindowColor(workspace)).resolves.toBe(
        assignedColors["titleBar.activeBackground"]
      );
      expect({
        assigned,
        color: assignedColors["titleBar.activeBackground"],
        preserved: settings["editor.fontSize"],
      }).toMatchObject({
        assigned: true,
        color: testValue<unknown>(expect.stringMatching(/^#[\da-f]{6}$/iu)),
        preserved: 14,
      });
    } finally {
      await rm(folder, { force: true, recursive: true });
    }
  });
});
