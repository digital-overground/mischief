import { access } from "node:fs/promises";
import path from "node:path";

import { exec } from "../exec";
import { isRecord } from "../present";
import type { LinearIssue } from "./projects";

export const listOpenLinearIssues = async (
  projectRoot: string
): Promise<LinearIssue[]> => {
  try {
    await access(path.join(projectRoot, ".linear.toml"));
  } catch {
    throw new Error(
      "Configure this repository's Linear team with linear config --team <TEAM> first."
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "linear",
      [
        "issue",
        "query",
        "--state",
        "triage",
        "--state",
        "backlog",
        "--state",
        "unstarted",
        "--state",
        "started",
        "--limit",
        "1000",
        "--json",
        "--no-input",
      ],
      { cwd: projectRoot }
    ));
  } catch (error) {
    const failure = isRecord(error) ? error : {};
    if (failure.code === "ENOENT") {
      throw new Error(
        "Linear CLI is required to open Linear issues. Install it and try again.",
        { cause: error }
      );
    }
    throw new Error(
      `Linear CLI could not list issues: ${typeof failure.stderr === "string" && failure.stderr.trim() ? failure.stderr.trim() : String(error)}. Configure this repository with linear config --team <TEAM> and authenticate with linear auth login.`,
      { cause: error }
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Linear issue list could not be read");
  }
  if (!Array.isArray(value)) {
    throw new TypeError(
      "Linear issue list could not be read: invalid response"
    );
  }
  return value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.identifier !== "string" ||
      !/^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/u.test(candidate.identifier) ||
      typeof candidate.title !== "string" ||
      !candidate.title.trim() ||
      typeof candidate.url !== "string"
    ) {
      throw new TypeError("Linear issue list could not be read: invalid issue");
    }
    let url: URL;
    try {
      url = new URL(candidate.url);
    } catch {
      throw new TypeError("Linear issue list could not be read: invalid URL");
    }
    if (url.protocol !== "https:" || url.hostname !== "linear.app") {
      throw new TypeError("Linear issue list could not be read: invalid URL");
    }
    return {
      identifier: candidate.identifier,
      title: candidate.title,
      url: candidate.url,
    };
  });
};
