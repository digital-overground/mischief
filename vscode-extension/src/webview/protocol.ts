import type { AgentStatus } from "../agents/manager";
import type { AgentId } from "../agents/update";
import type { ProjectsSnapshot } from "../projects/projects";
import type { PromptImage } from "../threads/model";
import type {
  ThreadDetail,
  ThreadInteractionResponse,
  ThreadSessionOperation,
  ThreadsSnapshot,
  TranscriptItem,
} from "../threads/threads/models";

export interface RenderedTranscriptItem extends TranscriptItem {
  html?: string;
}

export interface SetupOption {
  description: string;
  id: string;
  label: string;
}

export interface SetupStep {
  id: string;
  message: string;
  options?: SetupOption[];
}

export interface RenderedSetupStep extends Omit<SetupStep, "message"> {
  item: RenderedTranscriptItem;
}

export interface RenderedThreadDetail extends Omit<ThreadDetail, "items"> {
  items: RenderedTranscriptItem[];
}

export interface RenderedThreadsSnapshot extends Omit<
  ThreadsSnapshot,
  "selected"
> {
  selected?: RenderedThreadDetail;
}

export type HostToWebviewMessage =
  | {
      type: "state";
      font: string;
      agentIcons?: Partial<Record<AgentId, string>>;
      projects: ProjectsSnapshot;
      setup?: RenderedSetupStep;
      threads: RenderedThreadsSnapshot;
    }
  | {
      type: "transcript";
      threadId: string;
      item: RenderedTranscriptItem;
      streaming: boolean;
    }
  | {
      type: "sessionOperation";
      threadId: string;
      operation: ThreadSessionOperation;
    }
  | { type: "contextItems"; items: string[] }
  | { type: "setAllExpanded"; expanded: boolean }
  | { type: "toggleProjectsMenu" }
  | {
      type: "showSettings";
      assignWorkspaceColors: boolean;
      defaultAgent: string;
      todoExtensionEnabled?: boolean;
      agents: AgentStatus[];
    }
  | { type: "agents"; agents: AgentStatus[] }
  | {
      type: "showProjectSetup";
      project: string;
      entries: string[];
      selected: string[];
      creating: boolean;
      workspace?: { branch: string; path: string };
      command: string;
      suggestions: string[];
      review: boolean;
    };

export type WebviewToHostMessage =
  | {
      type:
        | "ready"
        | "contextItems"
        | "addWorkspace"
        | "refresh"
        | "showSettings"
        | "newThread"
        | "threadHistory"
        | "chooseAgent";
    }
  | {
      type: "forkThread" | "navigateThreadTree";
      threadId: string;
      messageId: string;
    }
  | {
      type:
        | "closeWorkspace"
        | "focusWorkspace"
        | "newWorkspace"
        | "openIssues"
        | "openWorkspace"
        | "projectSetup";
      path: string;
    }
  | {
      type: "selectThread" | "removeThread" | "renameThread";
      id: string;
    }
  | {
      type:
        | "cancel"
        | "clearPlan"
        | "clearSteering"
        | "retry"
        | "draftsConsumed"
        | "authenticate";
    }
  | { type: "prompt"; text: string; images: PromptImage[] }
  | { type: "setupContinue"; selected: string[] }
  | { type: "setAssignWorkspaceColors"; value: boolean }
  | { type: "setTodoExtensionEnabled"; value: boolean }
  | { type: "setDefaultAgent"; id: string }
  | {
      type: "saveProjectSetup";
      project: string;
      selected: string[];
      command: string;
    }
  | { type: "dismissProjectSetup"; project: string }
  | { type: "installAgent" | "checkAgent"; id: string }
  | { type: "removeSteering" | "sendSteering"; id: string }
  | { type: "setConfig"; id: string; value: string | boolean }
  | { type: "respond"; id: string; response: ThreadInteractionResponse }
  | { type: "openLocation"; path: string; line?: number }
  | { type: "openTranscriptLink"; href: string }
  | { type: "openDiff"; path: string };
