import { exec } from "../exec";
import { isRecord } from "../present";

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
}

export const listOpenLinearIssues = async (
  projectRoot: string
): Promise<LinearIssue[]> => {
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
        "all",
        "--json",
        "--no-pager",
        "--no-input",
      ],
      { cwd: projectRoot }
    ));
  } catch (error) {
    const failure = isRecord(error) ? error : {};
    if (failure.code === "ENOENT") {
      throw new Error(
        "Linear CLI is required to open Linear issues. Install @schpet/linear-cli and authenticate with linear auth login.",
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
      `Linear CLI could not list issues: ${details}. Authenticate with linear auth login and configure a default team in this Project's .linear.toml with linear config --team <TEAM>.`,
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
    if (!isRecord(candidate)) {
      throw new TypeError("Linear issue list could not be read: invalid issue");
    }
    const issue = candidate;
    if (
      typeof issue.identifier !== "string" ||
      !/^[A-Z][A-Z\d]*-\d+$/iu.test(issue.identifier) ||
      typeof issue.title !== "string" ||
      !issue.title.trim() ||
      typeof issue.url !== "string"
    ) {
      throw new TypeError("Linear issue list could not be read: invalid issue");
    }
    let url: URL;
    try {
      url = new URL(issue.url);
    } catch {
      throw new TypeError(
        "Linear issue list could not be read: invalid issue URL"
      );
    }
    if (url.protocol !== "https:") {
      throw new TypeError(
        "Linear issue list could not be read: invalid issue URL"
      );
    }
    return {
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    };
  });
};
