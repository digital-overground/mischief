import type { AgentId } from "../../agents/update";
import type {
  AgentAuthentication,
  AgentToolKind,
  ElicitationField,
  PlanEntry,
  PromptImage,
  ThreadCommand,
  ThreadConfigOption,
  ThreadUsage,
} from "../model";

export interface ThreadHistoryEntry {
  agentId?: AgentId;
  sessionId: string;
  title: string;
  updatedAt?: string;
  preview?: string;
  previewRole?: "user" | "assistant";
}

export type ThreadStatus = "idle" | "running" | "waiting" | "error";
export type ThreadSessionOperation = "fork" | "navigateTree" | "branchSummary";
export type ThreadIndicator =
  | "active"
  | "waiting"
  | "completed"
  | "idle"
  | "error";

export interface TranscriptItem {
  id: string;
  kind:
    | "user"
    | "assistant"
    | "thought"
    | "tool"
    | "plan"
    | "completedPlan"
    | "system"
    | "branchSummary";
  text?: string;
  allCompleted?: boolean;
  planEntries?: PlanEntry[];
  images?: PromptImage[];
  title?: string;
  status?: string;
  toolKind?: AgentToolKind;
  input?: string;
  output?: string;
  locations?: { path: string; line?: number }[];
  diffs?: { path: string; oldText?: string; newText: string }[];
  queued?: number;
  cancelled?: boolean;
}

export interface ThreadSummary {
  agentId?: AgentId;
  id: string;
  workspace: string;
  name: string;
  indicator: ThreadIndicator;
  needsAttention: boolean;
  updatedAt: string;
}

export type ThreadInteraction =
  | {
      id: string;
      kind: "permission";
      message: string;
      options: { id: string; name: string; kind: string }[];
    }
  | {
      id: string;
      kind: "elicitation";
      message: string;
      context?: string;
      fields: ElicitationField[];
    };

export type ThreadInteractionResponse =
  | { action: "select"; optionId: string }
  | { action: "accept"; values: Record<string, unknown> }
  | { action: "cancel" };

export interface SteeringMessage {
  id: string;
  text: string;
}

export interface ThreadDetail {
  agentId?: AgentId;
  id: string | null;
  name: string;
  status: ThreadStatus;
  streaming: boolean;
  usage?: ThreadUsage;
  items: TranscriptItem[];
  commands: ThreadCommand[];
  configOptions: ThreadConfigOption[];
  interaction?: ThreadInteraction;
  authentication?: AgentAuthentication;
  error?: string;
  drafts: string[];
  forkSupported?: boolean;
  treeNavigationSupported?: boolean;
  sessionOperation?: ThreadSessionOperation;
  steering: SteeringMessage[];
}

export interface ThreadsSnapshot {
  workspace?: string;
  threads: ThreadSummary[];
  selected?: ThreadDetail;
}

export type ThreadsChange =
  | {
      type: "transcript";
      threadId: string;
      item: TranscriptItem;
      streaming: boolean;
    }
  | {
      type: "sessionOperation";
      threadId: string;
      operation: ThreadSessionOperation;
    };
