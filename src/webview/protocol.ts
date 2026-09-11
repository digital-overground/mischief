import type { ProjectsSnapshot } from "../projects/projects";
import type {
  PromptImage,
  ThreadDetail,
  ThreadInteractionResponse,
  ThreadsSnapshot,
  TranscriptItem,
} from "../threads/threads";

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
  | { type: "contextItems"; items: string[] }
  | { type: "showSettings"; assignWorkspaceColors: boolean };

export type WebviewToHostMessage =
  | {
      type: "ready" | "add" | "refresh" | "contextItems" | "newThread";
    }
  | {
      type:
        | "newWorkspace"
        | "openIssues"
        | "openWorkspace"
        | "removeMembership";
      path: string;
    }
  | {
      type: "selectThread" | "removeThread" | "forkThread" | "rollbackThread";
      id: string;
    }
  | {
      type:
        | "renameThread"
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
  | { type: "removeSteering" | "sendSteering"; id: string }
  | { type: "setConfig"; id: string; value: string | boolean }
  | { type: "respond"; id: string; response: ThreadInteractionResponse }
  | { type: "openLocation"; path: string; line?: number }
  | { type: "openDiff"; path: string };
