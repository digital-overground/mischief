import { randomUUID } from "node:crypto";

import type { AgentToolUpdate, AgentUpdate, TranscriptItem } from "./threads";

const appendText = (
  items: TranscriptItem[],
  kind: "user" | "assistant" | "thought",
  text: string,
  messageId?: string
): void => {
  if (!text) {
    return;
  }
  const id = messageId ? `${kind}:${messageId}` : undefined;
  const existing = id ? items.find((item) => item.id === id) : items.at(-1);
  if (existing?.kind === kind) {
    existing.text = (existing.text ?? "") + text;
  } else {
    items.push({ id: id ?? randomUUID(), kind, text });
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

const upsertPlan = (items: TranscriptItem[], text: string): void => {
  const existing = items.find((item) => item.id === "plan");
  if (existing) {
    existing.text = text;
  } else {
    items.push({ id: "plan", kind: "plan", text, title: "Plan" });
  }
};

export const reduceTranscript = (
  items: TranscriptItem[],
  update: AgentUpdate
): void => {
  if (update.type === "message") {
    appendText(items, update.kind, update.text, update.messageId);
  } else if (update.type === "tool") {
    upsertTool(items, update);
  } else if (update.type === "plan") {
    upsertPlan(items, update.text);
  }
};
