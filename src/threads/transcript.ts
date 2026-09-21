import { randomUUID } from "node:crypto";

import { isNonEmpty, isNonZero } from "../present";
import type { AgentToolUpdate, AgentUpdate, TranscriptItem } from "./threads";

const appendMessage = (
  items: TranscriptItem[],
  kind: "user" | "assistant" | "thought" | "system" | "branchSummary",
  text?: string,
  images?: TranscriptItem["images"],
  messageId?: string
): TranscriptItem | undefined => {
  if (!isNonEmpty(text) && !isNonZero(images?.length)) {
    return undefined;
  }
  const id = isNonEmpty(messageId) ? `${kind}:${messageId}` : undefined;
  const existing = isNonEmpty(id)
    ? items.find((item) => item.id === id)
    : items.at(-1);
  if (existing?.kind === kind) {
    existing.text = (existing.text ?? "") + (text ?? "");
    if (isNonZero(images?.length)) {
      existing.images = [...(existing.images ?? []), ...images];
    }
  } else {
    items.push({
      id: id ?? randomUUID(),
      kind,
      ...(isNonEmpty(text) ? { text } : {}),
      ...(isNonZero(images?.length) ? { images } : {}),
    });
  }
  return existing?.kind === kind ? existing : items.at(-1);
};

const upsertTool = (
  items: TranscriptItem[],
  update: AgentToolUpdate
): TranscriptItem | undefined => {
  const id = `tool:${update.toolCallId}`;
  let item = items.find((candidate) => candidate.id === id);
  if (!item) {
    if (update.title === "todo" || update.title === undefined) {
      return undefined;
    }
    item = { id, kind: "tool" };
    items.push(item);
  }
  if (update.title !== undefined) {
    item.title = update.title;
  }
  if (update.toolKind !== undefined) {
    item.toolKind = update.toolKind;
  }
  if (update.status !== undefined) {
    item.status = update.status;
  }
  if (update.input !== undefined) {
    item.input = update.input;
  }
  if (update.output !== undefined) {
    item.output = update.output;
  }
  if (update.locations) {
    item.locations = update.locations;
  }
  if (isNonZero(update.diffs?.length)) {
    item.diffs = update.diffs;
  }
  if (update.terminalOutput !== undefined) {
    item.output = (item.output ?? "") + update.terminalOutput;
  }
  return item;
};

const upsertPlan = (
  items: TranscriptItem[],
  update: Extract<AgentUpdate, { type: "plan" }>
): TranscriptItem => {
  const existing = items.find((item) => item.id === "plan");
  if (existing) {
    existing.text = update.text;
    existing.allCompleted = update.allCompleted;
    existing.planEntries = update.entries;
    return existing;
  }
  const plan: TranscriptItem = {
    allCompleted: update.allCompleted,
    id: "plan",
    kind: "plan",
    planEntries: update.entries,
    text: update.text,
    title: "Plan",
  };
  items.push(plan);
  return plan;
};

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
  if (update.type === "message") {
    return appendMessage(
      items,
      update.kind,
      update.text,
      update.images,
      update.messageId
    );
  }
  if (update.type === "tool") {
    return upsertTool(items, update);
  }
  if (update.type === "plan") {
    return upsertPlan(items, update);
  }
  return undefined;
};
