import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  readWorkspaceSettings,
  updateWorkspaceSetting,
} from "./workspace-settings";

describe("workspace settings", () => {
  test("remembers ignored-item selections without replacing other settings", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "mischief-settings-test-")
    );
    try {
      await mkdir(path.join(root, ".vscode"));
      await writeFile(
        path.join(root, ".vscode", "settings.json"),
        '{\n  // keep this\n  "editor.tabSize": 4,\n}\n'
      );
      await updateWorkspaceSetting(root, "mischief.copyIgnoredItems", [
        ".env",
        "config/",
      ]);
      const { settings } = await readWorkspaceSettings(root);
      const source = await readFile(
        path.join(root, ".vscode", "settings.json"),
        "utf-8"
      );
      expect(settings).toMatchObject({
        "editor.tabSize": 4,
        "mischief.copyIgnoredItems": [".env", "config/"],
      });
      expect(source).toContain("// keep this");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
