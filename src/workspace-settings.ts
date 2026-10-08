import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { applyEdits, modify, parse } from "jsonc-parser/lib/esm/main.js";

import { isRecord } from "./present";

export const readWorkspaceSettings = async (
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
  const settings: unknown = parse(source, errors, { allowTrailingComma: true });
  if (!isRecord(settings) || errors.length) {
    throw new Error(`Invalid Workspace settings: ${file}`);
  }
  return { file, settings, source };
};

export const updateWorkspaceSetting = async (
  workspacePath: string,
  key: string,
  value: unknown
): Promise<void> => {
  const { file, source } = await readWorkspaceSettings(workspacePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    applyEdits(
      source,
      modify(source, [key], value, {
        formattingOptions: {
          insertFinalNewline: true,
          insertSpaces: true,
          tabSize: 2,
        },
      })
    )
  );
};
