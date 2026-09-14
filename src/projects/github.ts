import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitHubIssue } from "./projects";

const exec = promisify(execFile);

export const listOpenGitHubIssues = async (
  projectRoot: string,
  repository: string
): Promise<GitHubIssue[]> => {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repository,
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number,title,url",
      ],
      { cwd: projectRoot, encoding: "utf-8" }
    ));
  } catch (error) {
    const failure = error as {
      code?: unknown;
      message?: unknown;
      stderr?: unknown;
    };
    if (failure.code === "ENOENT") {
      throw new Error(
        "GitHub CLI (gh) is required to open issues. Install it and try again.",
        { cause: error }
      );
    }
    let details = String(error);
    if (typeof failure.message === "string") {
      details = failure.message;
    }
    if (typeof failure.stderr === "string" && failure.stderr.trim()) {
      details = failure.stderr.trim();
    }
    throw new Error(
      `GitHub CLI could not list issues: ${details}. Authenticate with gh auth login or refresh credentials with gh auth refresh.`,
      { cause: error }
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("GitHub issue list could not be read");
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      "GitHub issue list could not be read: invalid response"
    );
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError(
        "GitHub issue list could not be read: invalid GitHub issue"
      );
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
      throw new TypeError(
        "GitHub issue list could not be read: invalid GitHub issue"
      );
    }
    let url: URL;
    try {
      url = new URL(issue.url);
    } catch {
      throw new TypeError(
        "GitHub issue list could not be read: invalid GitHub issue URL"
      );
    }
    if (url.protocol !== "https:") {
      throw new TypeError(
        "GitHub issue list could not be read: invalid GitHub issue URL"
      );
    }
    return { number: issue.number, title: issue.title, url: issue.url };
  });
};
