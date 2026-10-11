import type { AgentId } from "../agents/update";
import type {
  AgentSessionOperations,
  AgentTreeNavigationOptions,
  AgentTreeNavigationResult,
} from "./acp/models";

export interface ThreadConfigChoice {
  value: string;
  name: string;
}

export interface ThreadConfigGroup {
  name: string;
  options: ThreadConfigChoice[];
}

export type ThreadConfigOption =
  | {
      id: string;
      name: string;
      description?: string;
      type: "select";
      currentValue: string;
      options: (ThreadConfigChoice | ThreadConfigGroup)[];
    }
  | {
      id: string;
      name: string;
      description?: string;
      type: "boolean";
      currentValue: boolean;
    };

export interface AgentSession {
  sessionId: string;
  configOptions: ThreadConfigOption[];
  operations: AgentSessionOperations;
}

export interface AgentPromptResult {
  stopReason: "completed" | "cancelled";
}

export interface AgentHistoryEntry {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  preview?: string;
  previewRole?: "user" | "assistant";
}

export interface PromptImage {
  data: string;
  mimeType: string;
}

export interface AgentPermissionRequest {
  message: string;
  options: { id: string; name: string; kind: string }[];
}

export type AgentPermissionResponse =
  | { optionId: string }
  | { cancelled: true };

export interface AgentElicitationRequest {
  message: string;
  context?: string;
  fields: ElicitationField[];
}

export type AgentElicitationResponse =
  | { action: "accept"; values: Record<string, unknown> }
  | { action: "cancel" };

export type AgentToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface AgentToolUpdate {
  toolCallId: string;
  toolKind?: AgentToolKind;
  title?: string;
  status?: string;
  input?: string;
  output?: string;
  terminalOutput?: string;
  locations?: { path: string; line?: number }[];
  diffs?: { path: string; oldText?: string; newText: string }[];
}

export interface ThreadCommand {
  name: string;
  description: string;
  inputHint?: string;
  skill?: boolean;
  source?: string;
}

export interface PlanEntry {
  content: string;
  status: string;
}

export interface ThreadUsage {
  used: number;
  size: number;
}

export interface ElicitationField {
  name: string;
  label: string;
  description?: string;
  type: "text" | "number" | "boolean" | "select" | "multiselect";
  required: boolean;
  defaultValue?: string | number | boolean | string[];
  options?: { value: string; name: string; description?: string }[];
}

export interface TerminalAuthentication {
  command: string;
  args: string[];
  env?: Record<string, string>;
  label: string;
}

export type AgentAuthentication =
  | TerminalAuthentication
  | {
      methodId: string;
      label: string;
    };

export type AgentUpdate =
  | {
      type: "message";
      kind: "user" | "assistant" | "thought" | "system" | "branchSummary";
      text?: string;
      images?: PromptImage[];
      messageId?: string;
    }
  | ({ type: "tool" } & AgentToolUpdate)
  | {
      type: "plan";
      text: string;
      allCompleted: boolean;
      entries: PlanEntry[];
    }
  | { type: "usage"; usage: ThreadUsage }
  | { type: "commands"; commands: ThreadCommand[] }
  | { type: "config"; options: ThreadConfigOption[] }
  | { type: "sessionInfo"; title?: string; updatedAt?: string };

export interface AgentError extends Error {
  readonly authentication?: AgentAuthentication;
}

export interface AgentHandlers {
  error: (error: AgentError) => void;
  elicitation: (
    request: AgentElicitationRequest
  ) => Promise<AgentElicitationResponse>;
  permission: (
    request: AgentPermissionRequest
  ) => Promise<AgentPermissionResponse>;
  update: (update: AgentUpdate) => void;
}

export interface AgentConnection {
  authenticate?: (methodId: string) => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  create: (cwd: string) => Promise<AgentSession>;
  dispose: () => void;
  forkMessage: (
    sessionId: string,
    cwd: string,
    messageId: string
  ) => Promise<AgentSession>;
  history: (cwd: string) => Promise<AgentHistoryEntry[]>;
  load: (sessionId: string, cwd: string) => Promise<AgentSession>;
  navigateTreeMessage: (
    sessionId: string,
    messageId: string,
    options: AgentTreeNavigationOptions
  ) => Promise<AgentTreeNavigationResult>;
  prompt: (
    sessionId: string,
    text: string,
    images: PromptImage[]
  ) => Promise<AgentPromptResult>;
  setConfig: (
    sessionId: string,
    configId: string,
    value: string | boolean
  ) => Promise<void>;
}

export type AgentConnectionFactory = (
  handlers: AgentHandlers,
  agentId: AgentId
) => AgentConnection;
