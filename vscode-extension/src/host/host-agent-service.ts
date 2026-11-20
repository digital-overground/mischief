import type { AgentService, AgentStatus } from "../agents/manager";
import { AGENTS, AGENT_IDS, isAgentId } from "../agents/update";
import type { AgentId } from "../agents/update";
import type { HostClient } from "./host-client";

type HostAgentTransport = Pick<HostClient, "request">;

interface HostAgentStatus {
  agentId: AgentId;
  version?: string;
}

const parseStatuses = (value: unknown): HostAgentStatus[] => {
  if (!Array.isArray(value)) {
    throw new TypeError("Mischief Host returned invalid Agent status");
  }
  const candidates: unknown[] = value;
  return candidates.map((candidate) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("agentId" in candidate) ||
      !isAgentId(candidate.agentId)
    ) {
      throw new TypeError("Mischief Host returned invalid Agent status");
    }
    const version: unknown =
      "version" in candidate ? candidate.version : undefined;
    if (version !== undefined && typeof version !== "string") {
      throw new TypeError("Mischief Host returned invalid Agent status");
    }
    return {
      agentId: candidate.agentId,
      ...(typeof version === "string" ? { version } : {}),
    };
  });
};

export class HostAgentService implements AgentService {
  private readonly client: HostAgentTransport;
  private readonly listeners = new Set<(statuses: AgentStatus[]) => void>();
  private readonly statuses = new Map<AgentId, AgentStatus>();

  constructor(client: HostAgentTransport) {
    this.client = client;
    for (const id of AGENT_IDS) {
      this.statuses.set(id, {
        id,
        name: AGENTS[id].name,
        state: "waiting",
      });
    }
  }

  async refresh(): Promise<void> {
    try {
      const installed = parseStatuses(await this.client.request("agentStatus"));
      for (const { agentId, version } of installed) {
        this.statuses.set(agentId, {
          id: agentId,
          ...(version === undefined ? {} : { installedVersion: version }),
          managed: true,
          name: AGENTS[agentId].name,
          state: version === undefined ? "missing" : "current",
        });
      }
    } catch (error) {
      for (const id of AGENT_IDS) {
        this.statuses.set(id, {
          error: error instanceof Error ? error.message : String(error),
          id,
          name: AGENTS[id].name,
          state: "unknown",
        });
      }
    }
    this.emit();
  }

  availableAgents(): AgentId[] {
    return this.snapshot()
      .filter((status) => status.installedVersion !== undefined)
      .map(({ id }) => id);
  }

  async check(_id: AgentId, _force = false): Promise<void> {
    await this.refresh();
  }

  async install(id: AgentId): Promise<void> {
    this.statuses.set(id, {
      ...this.require(id),
      error: undefined,
      state: "installing",
    });
    this.emit();
    try {
      await this.client.request("agentInstall", { agentId: id });
      await this.refresh();
    } catch (error) {
      this.statuses.set(id, {
        ...this.require(id),
        error: error instanceof Error ? error.message : String(error),
        state: "missing",
      });
      this.emit();
      throw error;
    }
  }

  onChange(listener: (statuses: AgentStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  piCli(): string | undefined {
    this.require("magpi-acp");
    return undefined;
  }

  snapshot(): AgentStatus[] {
    return AGENT_IDS.map((id) => ({ ...this.require(id) }));
  }

  startAutoUpdates(): void {
    // Agent updates remain disabled until the Host can stage them around active turns.
    this.emit();
  }

  dispose(): void {
    this.listeners.clear();
  }

  private emit(): void {
    const statuses = this.snapshot();
    for (const listener of this.listeners) {
      listener(statuses);
    }
  }

  private require(id: AgentId): AgentStatus {
    const status = this.statuses.get(id);
    if (!status) {
      throw new Error(`Unknown Agent: ${id}`);
    }
    return status;
  }
}
