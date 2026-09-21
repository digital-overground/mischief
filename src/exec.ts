import { spawn } from "node:child_process";
import { once } from "node:events";

interface ExecOptions {
  cwd?: string;
  encoding?: "utf-8";
  env?: NodeJS.ProcessEnv;
}

interface ExecResult {
  stderr: string;
  stdout: string;
}

const output = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(String(chunk));
  }
  return chunks.join("");
};

export const exec = async (
  file: string,
  args: readonly string[],
  options?: ExecOptions
): Promise<ExecResult> => {
  const child = spawn(file, args, {
    cwd: options?.cwd,
    env: options?.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = output(child.stdout);
  const stderr = output(child.stderr);
  const result: unknown = await once(child, "close");
  const stdoutText = await stdout;
  const stderrText = await stderr;
  if (!Array.isArray(result)) {
    throw new TypeError(`${file} returned an invalid exit status`);
  }
  const exitCode: unknown = result[0];
  if (exitCode !== 0) {
    throw Object.assign(
      new Error(`${file} exited with ${String(exitCode)}: ${stderrText}`),
      { stderr: stderrText, stdout: stdoutText }
    );
  }
  return { stderr: stderrText, stdout: stdoutText };
};
