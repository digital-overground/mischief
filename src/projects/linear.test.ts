import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { listOpenLinearIssues } from "./linear";

const originalPath = process.env.PATH;
let bin: string | undefined;
describe("Linear issues", () => {
  afterEach(async () => {
    process.env.PATH = originalPath;
    if (bin !== undefined) {
      await rm(bin, { force: true, recursive: true });
    }
  });

  test("lists open issues from the configured Linear team and validates the response", async () => {
    bin = await mkdtemp("/tmp/mischief-linear-");
    await expect(listOpenLinearIssues(bin)).rejects.toThrow(
      "linear config --team"
    );
    await writeFile(path.join(bin, ".linear.toml"), "team = 'ENG'\n");
    const cli = path.join(bin, "linear");
    await writeFile(
      cli,
      `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'issue query --state triage --state backlog --state unstarted --state started --limit 1000 --json --no-input') process.exit(2);
process.stdout.write(process.env.MISCHIEF_LINEAR_OUTPUT || '');
`
    );
    await chmod(cli, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    process.env.MISCHIEF_LINEAR_OUTPUT = JSON.stringify([
      {
        identifier: "ENG-12",
        title: "Fix bug",
        url: "https://linear.app/acme/issue/ENG-12/fix-bug",
      },
    ]);
    await expect(listOpenLinearIssues(bin)).resolves.toStrictEqual([
      {
        identifier: "ENG-12",
        title: "Fix bug",
        url: "https://linear.app/acme/issue/ENG-12/fix-bug",
      },
    ]);
    process.env.MISCHIEF_LINEAR_OUTPUT = JSON.stringify([
      {
        identifier: "ENG-12",
        title: "Bad",
        url: "http://linear.app/acme/issue/ENG-12",
      },
    ]);
    await expect(listOpenLinearIssues(bin)).rejects.toThrow("invalid URL");
    delete process.env.MISCHIEF_LINEAR_OUTPUT;
  });
});
