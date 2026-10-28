import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { projectSetupInputs } from "./setup";

describe("Project setup inputs", () => {
  test("suggests installs only for present lockfiles and detects changes to setup inputs", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "mischief-project-setup-")
    );
    try {
      await writeFile(
        path.join(root, "package.json"),
        '{"scripts":{"build":"danger"}}'
      );
      await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
      const before = await projectSetupInputs(root);
      expect(before.suggestions).toStrictEqual(["pnpm install"]);
      expect(before.hashes[".gitignore"]).toBe("missing");
      await writeFile(path.join(root, ".gitignore"), ".env\n");
      await writeFile(path.join(root, "bun.lock"), "lock");
      const after = await projectSetupInputs(root);
      expect(after.suggestions).toStrictEqual(["bun install", "pnpm install"]);
      expect(after.hashes).not.toStrictEqual(before.hashes);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
