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
  HostHistoryEntry,
  HostPromptImage,
} from "./host-acp.js";

export type HostAcpEvent =
  | {
      agentId: string;
      sessionId: string;
      type: "acpUpdate";
      meta?: Record<string, unknown> | null;
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
  | {
      agentId: string;
      interactionId: string;
      sessionId?: string;
      type: "acpInteractionResolved";
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

/** Owns one ACP process per Agent and Workspace and leaves interactions pending for clients. */
export class HostAcpManager {
  private readonly connections = new Map<string, HostAcpConnection>();
  private readonly sessionWorkspaces = new Map<string, string>();
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

  async authenticate(
    agentId: string,
    cwd: string,
    methodId: string
  ): Promise<void> {
    const connection = await this.connection(agentId, cwd);
    await connection.authenticate(methodId);
  }

  async create(agentId: string, cwd: string): Promise<HostAcpSession> {
    const connection = await this.connection(agentId, cwd);
    const session = await connection.create(cwd);
    this.remember(agentId, session.sessionId, cwd);
    return session;
  }

  async forkMessage(
    agentId: string,
    sessionId: string,
    cwd: string,
    messageId: string
  ): Promise<HostAcpSession> {
    const connection = await this.sessionConnection(agentId, sessionId);
    const session = await connection.forkMessage(sessionId, cwd, messageId);
    this.remember(agentId, session.sessionId, cwd);
    return session;
  }

  async history(agentId: string, cwd: string): Promise<HostHistoryEntry[]> {
    const connection = await this.connection(agentId, cwd);
    return await connection.history(cwd);
  }

  async load(
    agentId: string,
    sessionId: string,
    cwd: string
  ): Promise<HostAcpSession> {
    const connection = await this.connection(agentId, cwd);
    const session = await connection.load(sessionId, cwd);
    this.remember(agentId, sessionId, cwd);
    return session;
  }

  async prompt(
    agentId: string,
    sessionId: string,
    text: string,
    images: HostPromptImage[]
  ): Promise<"cancelled" | "completed"> {
    const connection = await this.sessionConnection(agentId, sessionId);
    return await connection.prompt(sessionId, text, images);
  }

  async setConfig(
    agentId: string,
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    const connection = await this.sessionConnection(agentId, sessionId);
    await connection.setConfig(sessionId, configId, value);
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    for (const [interactionId, pending] of this.permissions) {
      if (
        pending.event.agentId === agentId &&
        pending.event.request.sessionId === sessionId
      ) {
        this.respondPermission(interactionId, {
          outcome: { outcome: "cancelled" },
        });
      }
    }
    for (const [interactionId, pending] of this.elicitations) {
      if (
        pending.event.agentId === agentId &&
        "sessionId" in pending.event.request &&
        pending.event.request.sessionId === sessionId
      ) {
        this.respondElicitation(interactionId, { action: "cancel" });
      }
    }
    const connection = await this.sessionConnection(agentId, sessionId);
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
    this.emit({
      agentId: pending.event.agentId,
      interactionId,
      sessionId: pending.event.request.sessionId,
      type: "acpInteractionResolved",
    });
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
    this.emit({
      agentId: pending.event.agentId,
      interactionId,
      sessionId:
        "sessionId" in pending.event.request
          ? pending.event.request.sessionId
          : undefined,
      type: "acpInteractionResolved",
    });
    pending.resolve(response);
  }

  dispose(): void {
    for (const connection of this.connections.values()) {
      connection.dispose();
    }
    this.connections.clear();
    this.sessionWorkspaces.clear();
  }

  private remember(agentId: string, sessionId: string, cwd: string): void {
    const key = `${agentId}\0${sessionId}`;
    const existing = this.sessionWorkspaces.get(key);
    if (existing !== undefined && existing !== cwd) {
      throw new Error("Agent session ID belongs to another Workspace");
    }
    this.sessionWorkspaces.set(key, cwd);
  }

  private async sessionConnection(
    agentId: string,
    sessionId: string
  ): Promise<HostAcpConnection> {
    const cwd = this.sessionWorkspaces.get(`${agentId}\0${sessionId}`);
    if (cwd === undefined) {
      throw new Error("Agent session is not loaded in the Host");
    }
    return await this.connection(agentId, cwd);
  }

  private async connection(
    agentId: string,
    cwd: string
  ): Promise<HostAcpConnection> {
    const key = `${agentId}\0${cwd}`;
    const existing = this.connections.get(key);
    if (existing) {
      return existing;
    }
    const launch = await launchFrom(this.profilePath, agentId);
    const connection = new HostAcpConnection(
      { ...launch, cwd },
      {
        elicitation: async (request) =>
          await this.waitForElicitation(agentId, request),
        error: (error) => {
          this.emit({ agentId, message: error.message, type: "acpError" });
        },
        permission: async (request) =>
          await this.waitForPermission(agentId, request),
        update: (sessionId, update, meta) => {
          this.emit({
            agentId,
            ...(meta === undefined ? {} : { meta }),
            sessionId,
            type: "acpUpdate",
            update,
          });
        },
      }
    );
    this.connections.set(key, connection);
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
