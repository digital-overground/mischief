import { execFile } from "node:child_process";
import { promisify } from "node:util";

// oxlint-disable-next-line typescript/strict-void-return -- promisify supports Node callbacks that return process handles
const execute = promisify(execFile);

export const exec = async (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<{ stderr: string; stdout: string }> =>
  await execute(file, [...args], { ...options, encoding: "utf-8" });
