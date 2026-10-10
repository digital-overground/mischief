import type {
  AvailableCommand,
  ClientContext,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import type {
  AgentAuthentication,
  AgentHistoryEntry,
  ThreadCommand,
} from "../model";

export interface AgentImplementation {
  name: string;
  title?: string;
  version?: string;
}

export interface AgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentSessionOperations {
  branchSummary: boolean;
  forkMessage: boolean;
  treeNavigation: boolean;
}

export interface AcpExtension {
  operations?: (capabilities: unknown) => Partial<AgentSessionOperations>;
  messageKind?: (
    update: SessionUpdate,
    meta?: Record<string, unknown> | null
  ) => "branchSummary" | undefined;
  visibleMessageText?: (sessionUpdate: string, text: string) => string;
  command?: (
    command: AvailableCommand
  ) => Partial<Pick<ThreadCommand, "skill" | "source">>;
  sessionPreview?: (
    meta: Record<string, unknown> | null | undefined
  ) => Pick<AgentHistoryEntry, "preview" | "previewRole">;
  authentication?: (
    error: unknown,
    launch: AgentLaunch,
    advertised: unknown[]
  ) => AgentAuthentication | undefined;
  forkMessage?: (
    agent: ClientContext,
    sessionId: string,
    cwd: string,
    messageId: string
  ) => Promise<{
    sessionId: string;
    configOptions?: SessionConfigOption[] | null;
  }>;
  navigateTreeMessage?: (
    agent: ClientContext,
    sessionId: string,
    messageId: string,
    options: AgentTreeNavigationOptions
  ) => Promise<AgentTreeNavigationResult>;
  missingCapabilities?: (capabilities: unknown) => string[];
}

export interface AgentTreeNavigationOptions {
  summarize: boolean;
  customInstructions?: string;
}

export interface AgentTreeNavigationResult {
  draft?: string;
}
