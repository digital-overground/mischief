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
      threads: RenderedThreadsSnapshot;
    }
  | {
      type: "transcript";
      threadId: string;
      item: RenderedTranscriptItem;
      streaming: boolean;
    }
  | { type: "contextItems"; items: string[] };

export type WebviewToHostMessage =
  | { type: "ready" | "add" | "refresh" | "contextItems" | "newThread" }
  | { type: "openWorkspace" | "removeMembership"; path: string }
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
  | { type: "removeSteering" | "sendSteering"; id: string }
  | { type: "setConfig"; id: string; value: string | boolean }
  | { type: "respond"; id: string; response: ThreadInteractionResponse }
  | { type: "openLocation"; path: string; line?: number }
  | { type: "openDiff"; path: string };
