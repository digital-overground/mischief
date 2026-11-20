import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const lockfiles = [
  ["bun.lock", "bun install"],
  ["bun.lockb", "bun install"],
  ["pnpm-lock.yaml", "pnpm install"],
  ["package-lock.json", "npm install"],
  ["npm-shrinkwrap.json", "npm install"],
  ["yarn.lock", "yarn install"],
] as const;
const inputs = [
  ".gitignore",
  "package.json",
  ...lockfiles.map(([file]) => file),
];

export const projectSetupInputs = async (
  project: string
): Promise<{ hashes: Record<string, string>; suggestions: string[] }> => {
  const files = await Promise.all(
    inputs.map(async (name) => {
      try {
        const source = await readFile(path.join(project, name));
        return [
          name,
          createHash("sha256").update(source).digest("hex"),
        ] as const;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
        return [name, "missing"] as const;
      }
    })
  );
  const hashes = Object.fromEntries(files);
  const present = new Set(
    files.filter(([, hash]) => hash !== "missing").map(([name]) => name)
  );
  const suggestions = present.has("package.json")
    ? [
        ...new Set(
          lockfiles
            .filter(([name]) => present.has(name))
            .map(([, command]) => command)
        ),
      ]
    : [];
  if (present.has("package.json") && suggestions.length === 0) {
    suggestions.push("npm install");
  }
  return { hashes, suggestions };
};

export const setupCommandHash = (command: string): string =>
  createHash("sha256").update(command).digest("hex");
