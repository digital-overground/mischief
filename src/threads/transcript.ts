import { randomUUID } from "node:crypto";

import type { AgentToolUpdate, AgentUpdate, TranscriptItem } from "./threads";

const appendMessage = (
  items: TranscriptItem[],
  kind: "user" | "assistant" | "thought",
  text?: string,
  images?: TranscriptItem["images"],
  messageId?: string
): void => {
  if (!text && !images?.length) {
    return;
  }
  const id = messageId ? `${kind}:${messageId}` : undefined;
  const existing = id ? items.find((item) => item.id === id) : items.at(-1);
  if (existing?.kind === kind) {
    existing.text = (existing.text ?? "") + (text ?? "");
    if (images?.length) {
      existing.images = [...(existing.images ?? []), ...images];
    }
  } else {
    items.push({
      id: id ?? randomUUID(),
      kind,
      ...(text ? { text } : {}),
      ...(images?.length ? { images } : {}),
    });
  }
};

const upsertTool = (items: TranscriptItem[], update: AgentToolUpdate): void => {
  const id = `tool:${update.toolCallId}`;
  let item = items.find((candidate) => candidate.id === id);
  if (!item) {
    item = { id, kind: "tool" };
    items.push(item);
  }
  if (update.title !== undefined) {
    item.title = update.title;
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
  if (update.diffs?.length) {
    item.diffs = update.diffs;
  }
  if (update.terminalOutput !== undefined) {
    item.output = (item.output ?? "") + update.terminalOutput;
  }
};

const upsertPlan = (
  items: TranscriptItem[],
  update: Extract<AgentUpdate, { type: "plan" }>
): void => {
  const existing = items.find((item) => item.id === "plan");
  if (existing) {
    existing.text = update.text;
    existing.allCompleted = update.allCompleted;
  } else {
    items.push({
      allCompleted: update.allCompleted,
      id: "plan",
      kind: "plan",
      text: update.text,
      title: "Plan",
    });
  }
};

export const archiveCompletedPlan = (items: TranscriptItem[]): void => {
  const index = items.findIndex(
    (item) => item.kind === "plan" && item.allCompleted
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
): void => {
  if (update.type === "message") {
    appendMessage(
      items,
      update.kind,
      update.text,
      update.images,
      update.messageId
    );
  } else if (update.type === "tool") {
    upsertTool(items, update);
  } else if (update.type === "plan") {
    upsertPlan(items, update);
  }
};
