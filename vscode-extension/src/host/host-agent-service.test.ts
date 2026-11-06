import { describe, expect, test } from "vitest";

import { HostAgentService } from "./host-agent-service";

class FakeHost {
  installed = false;
  readonly requests: string[] = [];

  async request(action: string): Promise<unknown> {
    this.requests.push(action);
    if (action === "agentInstall") {
      this.installed = true;
      return await Promise.resolve({
        agentId: "codex-acp",
        version: "1.2.3",
      });
    }
    if (action === "agentStatus") {
      return await Promise.resolve([
        { agentId: "magpi-acp" },
        { agentId: "claude-agent-acp" },
        {
          agentId: "codex-acp",
          ...(this.installed ? { version: "1.2.3" } : {}),
        },
      ]);
    }
    throw new Error(`Unexpected action: ${action}`);
  }
}

describe("Host Agent service", () => {
  test("reports and installs Agents through the Host", async () => {
    const host = new FakeHost();
    const service = new HostAgentService(host);

    await service.refresh();
    expect(service.availableAgents()).toStrictEqual([]);
    await service.install("codex-acp");
    expect(service.snapshot()).toContainEqual({
      id: "codex-acp",
      installedVersion: "1.2.3",
      managed: true,
      name: "Codex",
      state: "current",
    });
    expect(host.requests).toStrictEqual([
      "agentStatus",
      "agentInstall",
      "agentStatus",
    ]);
  });
});
