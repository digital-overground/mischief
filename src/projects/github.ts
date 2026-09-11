import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitHubIssue } from "./projects";

const exec = promisify(execFile);

export const listOpenGitHubIssues = async (
  projectRoot: string
): Promise<GitHubIssue[]> => {
  const { stdout } = await exec(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,title,url",
    ],
    { cwd: projectRoot, encoding: "utf-8" }
  );
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Could not read the GitHub issue list");
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Received an invalid GitHub issue list");
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError("Received an invalid GitHub issue");
    }
    const issue = candidate as Record<string, unknown>;
    if (
      typeof issue.number !== "number" ||
      !Number.isInteger(issue.number) ||
      issue.number <= 0 ||
      typeof issue.title !== "string" ||
      !issue.title.trim() ||
      typeof issue.url !== "string"
    ) {
      throw new TypeError("Received an invalid GitHub issue");
    }
    let url: URL;
    try {
      url = new URL(issue.url);
    } catch {
      throw new TypeError("Received an invalid GitHub issue URL");
    }
    if (url.protocol !== "https:") {
      throw new TypeError("Received an invalid GitHub issue URL");
    }
    return { number: issue.number, title: issue.title, url: issue.url };
  });
};
