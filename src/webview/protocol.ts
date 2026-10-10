import type { ProjectsSnapshot } from "../projects/projects";
import type { PromptImage } from "../threads/model";
import type {
  ThreadDetail,
  ThreadInteractionResponse,
  ThreadSessionOperation,
  ThreadsSnapshot,
  TranscriptItem,
} from "../threads/threads/models";

export interface AgentSetting {
  id: string;
  name: string;
  installedVersion?: string;
  latestVersion?: string;
  managed?: boolean;
  error?: string;
  state:
    | "waiting"
    | "checking"
    | "installing"
    | "updateAvailable"
    | "current"
    | "newer"
    | "unknown"
    | "missing";
}

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
  | {
      type: "showSettings";
      assignWorkspaceColors: boolean;
      agents: AgentSetting[];
    }
  | { type: "agents"; agents: AgentSetting[] };

export type WebviewToHostMessage =
  | {
      type:
        | "ready"
        | "contextItems"
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
        | "deactivateWorkspace"
        | "newWorkspace"
        | "openIssues"
        | "openWorkspace";
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
  | { type: "navigatorExpanded"; expanded: boolean }
  | { type: "setAssignWorkspaceColors"; value: boolean }
  | { type: "installAgent" | "checkAgent"; id: string }
  | { type: "removeSteering" | "sendSteering"; id: string }
  | { type: "setConfig"; id: string; value: string | boolean }
  | { type: "respond"; id: string; response: ThreadInteractionResponse }
  | { type: "openLocation"; path: string; line?: number }
  | { type: "openTranscriptLink"; href: string }
  | { type: "openDiff"; path: string };
