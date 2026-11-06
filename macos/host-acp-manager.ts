import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import { HostAcpConnection } from "./host-acp.js";
import type { HostAgentLaunch } from "./host-acp.js";

export type HostAcpEvent =
  | {
      agentId: string;
      sessionId: string;
      type: "acpUpdate";
      update: SessionUpdate;
    }
  | {
      agentId: string;
      interactionId: string;
      request: RequestPermissionRequest;
      type: "acpPermission";
    }
  | {
      agentId: string;
      interactionId: string;
      request: Extract<CreateElicitationRequest, { mode: "form" }>;
      type: "acpElicitation";
    }
  | { agentId: string; message: string; type: "acpError" };

const launchFrom = (value: unknown): HostAgentLaunch => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("command" in value) ||
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    !("args" in value) ||
    !Array.isArray(value.args) ||
    !value.args.every((argument) => typeof argument === "string")
  ) {
    throw new TypeError("Invalid Host Agent registry entry");
  }
  let env: Record<string, string> | undefined;
  if ("env" in value) {
    if (typeof value.env !== "object" || value.env === null) {
      throw new TypeError("Invalid Host Agent registry environment");
    }
    env = {};
    for (const [name, entry] of Object.entries(value.env)) {
      if (typeof entry !== "string") {
        throw new TypeError("Invalid Host Agent registry environment");
      }
      env[name] = entry;
    }
  }
  return {
    args: value.args,
    command: value.command,
    ...(env ? { env } : {}),
  };
};

/** Owns one ACP process per Agent and leaves interactions pending for clients. */
export class HostAcpManager {
  private readonly connections = new Map<string, HostAcpConnection>();
  private readonly elicitations = new Map<
    string,
    {
      event: Extract<HostAcpEvent, { type: "acpElicitation" }>;
      resolve: (response: CreateElicitationResponse) => void;
    }
  >();
  private readonly emit: (event: HostAcpEvent) => void;
  private readonly permissions = new Map<
    string,
    {
      event: Extract<HostAcpEvent, { type: "acpPermission" }>;
      resolve: (response: RequestPermissionResponse) => void;
    }
  >();
  private readonly profilePath: string;

  constructor(profilePath: string, emit: (event: HostAcpEvent) => void) {
    this.profilePath = profilePath;
    this.emit = emit;
  }

  async create(agentId: string, cwd: string): Promise<string> {
    const connection = await this.connection(agentId);
    return await connection.create(cwd);
  }

  async load(agentId: string, sessionId: string, cwd: string): Promise<void> {
    const connection = await this.connection(agentId);
    await connection.load(sessionId, cwd);
  }

  async prompt(
    agentId: string,
    sessionId: string,
    text: string
  ): Promise<"cancelled" | "completed"> {
    const connection = await this.connection(agentId);
    return await connection.prompt(sessionId, text);
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    const connection = await this.connection(agentId);
    await connection.cancel(sessionId);
  }

  pendingEvents(): HostAcpEvent[] {
    return [
      ...[...this.permissions.values()].map(({ event }) => event),
      ...[...this.elicitations.values()].map(({ event }) => event),
    ];
  }

  respondPermission(
    interactionId: string,
    response: RequestPermissionResponse
  ): void {
    const pending = this.permissions.get(interactionId);
    if (!pending) {
      throw new Error("Unknown or completed ACP permission request");
    }
    this.permissions.delete(interactionId);
    pending.resolve(response);
  }

  respondElicitation(
    interactionId: string,
    response: CreateElicitationResponse
  ): void {
    const pending = this.elicitations.get(interactionId);
    if (!pending) {
      throw new Error("Unknown or completed ACP elicitation");
    }
    this.elicitations.delete(interactionId);
    pending.resolve(response);
  }

  dispose(): void {
    for (const connection of this.connections.values()) {
      connection.dispose();
    }
    this.connections.clear();
  }

  private async connection(agentId: string): Promise<HostAcpConnection> {
    const existing = this.connections.get(agentId);
    if (existing) {
      return existing;
    }
    const raw = await readFile(path.join(this.profilePath, "agents.json"), {
      encoding: "utf-8",
    });
    if (raw.length > 1_000_000) {
      throw new Error("Host Agent registry is too large");
    }
    const registry: unknown = JSON.parse(raw);
    if (
      typeof registry !== "object" ||
      registry === null ||
      !("version" in registry) ||
      registry.version !== 1 ||
      !("agents" in registry) ||
      typeof registry.agents !== "object" ||
      registry.agents === null
    ) {
      throw new Error("Invalid Host Agent registry");
    }
    const entry: unknown = Object.entries(registry.agents).find(
      ([id]) => id === agentId
    )?.[1];
    if (entry === undefined) {
      throw new Error(`Agent is not installed in the Host: ${agentId}`);
    }
    const connection = new HostAcpConnection(launchFrom(entry), {
      elicitation: async (request) =>
        await this.waitForElicitation(agentId, request),
      error: (error) => {
        this.emit({ agentId, message: error.message, type: "acpError" });
      },
      permission: async (request) =>
        await this.waitForPermission(agentId, request),
      update: (sessionId, update) => {
        this.emit({ agentId, sessionId, type: "acpUpdate", update });
      },
    });
    this.connections.set(agentId, connection);
    return connection;
  }

  private async waitForPermission(
    agentId: string,
    request: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const interactionId = randomUUID();
    const event = {
      agentId,
      interactionId,
      request,
      type: "acpPermission" as const,
    };
    // oxlint-disable-next-line promise/avoid-new -- ACP intentionally waits until any client responds.
    const response = new Promise<RequestPermissionResponse>((resolve) => {
      this.permissions.set(interactionId, { event, resolve });
    });
    this.emit(event);
    return await response;
  }

  private async waitForElicitation(
    agentId: string,
    request: Extract<CreateElicitationRequest, { mode: "form" }>
  ): Promise<CreateElicitationResponse> {
    const interactionId = randomUUID();
    const event = {
      agentId,
      interactionId,
      request,
      type: "acpElicitation" as const,
    };
    // oxlint-disable-next-line promise/avoid-new -- ACP intentionally waits until any client responds.
    const response = new Promise<CreateElicitationResponse>((resolve) => {
      this.elicitations.set(interactionId, { event, resolve });
    });
    this.emit(event);
    return await response;
  }
}
