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

const missingTranscriptActions = (): never => {
  throw new Error("Transcript actions provider is missing");
};

export const TranscriptActions = createContext<TranscriptActionHandler>(
  missingTranscriptActions
);
export const useTranscriptAction = (): TranscriptActionHandler =>
  useContext(TranscriptActions);
