import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import agentConfig from "../shared/agents/config.json";
import { HostAcpConnection } from "./host-acp.js";
import type {
  HostAcpSession,
  HostAgentLaunch,
  HostPromptImage,
} from "./host-acp.js";

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

const VERSION = /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?$/u;
type AgentId = keyof typeof agentConfig;
const isAgentId = (value: string): value is AgentId =>
  Object.hasOwn(agentConfig, value);
const launchFrom = async (
  profilePath: string,
  agentId: string
): Promise<HostAgentLaunch> => {
  if (!isAgentId(agentId)) {
    throw new Error(`Unknown Agent: ${agentId}`);
  }
  const config = agentConfig[agentId];
  const activePath = path.join(profilePath, "agents", agentId, "active.json");
  const raw = await readFile(activePath, "utf-8");
  if (raw.length > 1000) {
    throw new Error(`Invalid active Agent record: ${agentId}`);
  }
  const active: unknown = JSON.parse(raw);
  if (
    typeof active !== "object" ||
    active === null ||
    !("version" in active) ||
    typeof active.version !== "string" ||
    !VERSION.test(active.version)
  ) {
    throw new Error(`Invalid active Agent record: ${agentId}`);
  }
  const executable = path.join(
    profilePath,
    "agents",
    agentId,
    "versions",
    active.version,
    "node_modules",
    config.package,
    config.bin
  );
  const executableStat = await stat(executable);
  if (!executableStat.isFile()) {
    throw new Error(`Agent installation is incomplete: ${agentId}`);
  }
  return {
    args: [executable],
    command: process.execPath,
    ...(agentId === "magpi-acp"
      ? { env: { MAGPI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" } }
      : {}),
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

  async create(agentId: string, cwd: string): Promise<HostAcpSession> {
    const connection = await this.connection(agentId);
    return await connection.create(cwd);
  }

  async load(
    agentId: string,
    sessionId: string,
    cwd: string
  ): Promise<HostAcpSession> {
    const connection = await this.connection(agentId);
    return await connection.load(sessionId, cwd);
  }

  async prompt(
    agentId: string,
    sessionId: string,
    text: string,
    images: HostPromptImage[]
  ): Promise<"cancelled" | "completed"> {
    const connection = await this.connection(agentId);
    return await connection.prompt(sessionId, text, images);
  }

  async setConfig(
    agentId: string,
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    const connection = await this.connection(agentId);
    await connection.setConfig(sessionId, configId, value);
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    for (const [interactionId, pending] of this.permissions) {
      if (pending.event.request.sessionId === sessionId) {
        this.permissions.delete(interactionId);
        pending.resolve({ outcome: { outcome: "cancelled" } });
      }
    }
    for (const [interactionId, pending] of this.elicitations) {
      if (
        "sessionId" in pending.event.request &&
        pending.event.request.sessionId === sessionId
      ) {
        this.elicitations.delete(interactionId);
        pending.resolve({ action: "cancel" });
      }
    }
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
    const launch = await launchFrom(this.profilePath, agentId);
    const connection = new HostAcpConnection(launch, {
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
