import { createContext, useContext } from "react";

export type TranscriptAction =
  | { type: "openTranscriptLink"; href: string }
  | { type: "openLocation"; path: string; line?: number }
  | { type: "openDiff"; path: string }
  | {
      type: "forkThread" | "navigateThreadTree";
      threadId: string;
      messageId: string;
    };

export type TranscriptActionHandler = (action: TranscriptAction) => void;

export const TranscriptActions = createContext<TranscriptActionHandler>(
  () => {}
);
export const useTranscriptAction = (): TranscriptActionHandler =>
  useContext(TranscriptActions);
