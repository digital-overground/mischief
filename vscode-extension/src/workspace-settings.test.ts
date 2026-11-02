import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  readWorkspaceSettings,
  updateWorkspaceSetting,
} from "./workspace-settings";

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rename: vi.fn<typeof actual.rename>(actual.rename),
    writeFile: vi.fn<typeof actual.writeFile>(actual.writeFile),
  };
});

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

  test("creates settings when the Workspace has none", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "mischief-settings-test-")
    );
    try {
      await updateWorkspaceSetting(root, "editor.tabSize", 4);
      await expect(readWorkspaceSettings(root)).resolves.toMatchObject({
        settings: { "editor.tabSize": 4 },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "preserves private settings permissions and settings symlinks",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "mischief-settings-test-")
      );
      const file = path.join(root, ".vscode", "settings.json");
      const target = path.join(root, "shared-settings.json");
      try {
        await mkdir(path.dirname(file));
        await writeFile(target, "{}\n");
        await chmod(target, 0o600);
        await symlink(target, file);
        await updateWorkspaceSetting(root, "editor.tabSize", 4);
        const { mode } = await stat(target);
        expect(mode % 0o1000).toBe(0o600);
        await expect(readlink(file)).resolves.toBe(target);
        await expect(readFile(target, "utf-8")).resolves.toContain(
          '"editor.tabSize": 4'
        );
        await rm(target);
        await expect(
          updateWorkspaceSetting(root, "editor.tabSize", 2)
        ).rejects.toThrow("ENOENT");
        await expect(readlink(file)).resolves.toBe(target);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );

  test.each(["write", "rename"] as const)(
    "keeps original settings when %s fails",
    async (operation) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "mischief-settings-test-")
      );
      const directory = path.join(root, ".vscode");
      const file = path.join(directory, "settings.json");
      const original = '{ "editor.tabSize": 4 }\n';
      try {
        await mkdir(directory);
        await writeFile(file, original);
        vi.mocked(
          operation === "write" ? writeFile : rename
        ).mockRejectedValueOnce(new Error("disk failure"));
        await expect(
          updateWorkspaceSetting(root, "mischief.copyIgnoredItems", [".env"])
        ).rejects.toThrow("disk failure");
        await expect(readFile(file, "utf-8")).resolves.toBe(original);
        await expect(readdir(directory)).resolves.toStrictEqual([
          "settings.json",
        ]);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );
});
