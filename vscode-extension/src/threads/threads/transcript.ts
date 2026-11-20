import { randomUUID } from "node:crypto";

import { reduceTranscriptUpdate } from "../../../../shared/acp/transcript";
import type { AgentUpdate } from "../model";
import type { TranscriptItem } from "./models";

export const archiveCompletedPlan = (items: TranscriptItem[]): void => {
  const index = items.findIndex(
    (item) => item.kind === "plan" && item.allCompleted === true
  );
  if (index === -1) {
    return;
  }
  const [plan] = items.splice(index, 1);
  items.push({
    id: randomUUID(),
    kind: "completedPlan",
    text: plan.text,
    title: "Completed Plan",
  });
};

export const reduceTranscript = (
  items: TranscriptItem[],
  update: AgentUpdate
): TranscriptItem | undefined => {
  if (
    update.type !== "message" &&
    update.type !== "tool" &&
    update.type !== "plan"
  ) {
    return undefined;
  }
  return reduceTranscriptUpdate(items, update);
};
