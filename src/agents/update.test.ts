import { describe, expect, test } from "vitest";

import {
  AGENT_IDS,
  compareVersions,
  isAgentId,
  latestAgentVersion,
} from "./update";

describe("approved Agent releases", () => {
  test("only uses fixed npm packages", async () => {
    expect(AGENT_IDS).toStrictEqual([
      "magpi-acp",
      "claude-agent-acp",
      "codex-acp",
    ]);
    expect(isAgentId("arbitrary-npm-package")).toBeFalsy();
    let spec = "";
    const version = await latestAgentVersion("codex-acp", async (value) => {
      spec = value;
      return await Promise.resolve("2.1.1");
    });
    expect({ spec, version }).toStrictEqual({
      spec: "@agentclientprotocol/codex-acp@latest",
      version: "2.1.1",
    });
  });

  test("compares stable and prerelease versions without downgrading", () => {
    expect(compareVersions("0.3.0", "0.3.1")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});
