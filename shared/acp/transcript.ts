import type { SessionUpdate } from "@agentclientprotocol/sdk";

import type {
  RenderedTranscriptItem,
  TranscriptImage,
} from "../webview/transcript/types";

export type TranscriptAgentUpdate =
  | {
      type: "message";
      kind: "user" | "assistant" | "thought" | "system" | "branchSummary";
      text?: string;
      images?: TranscriptImage[];
      messageId?: string;
    }
  | ({ type: "tool" } & TranscriptToolUpdate)
  | {
      type: "plan";
      text: string;
      allCompleted: boolean;
      entries: { content: string; status: string }[];
    };

export interface TranscriptToolUpdate {
  toolCallId: string;
  toolKind?:
    | "read"
    | "edit"
    | "delete"
    | "move"
    | "search"
    | "execute"
    | "think"
    | "fetch"
    | "switch_mode"
    | "other";
  title?: string;
  status?: string;
  input?: string;
  output?: string;
  terminalOutput?: string;
  locations?: { path: string; line?: number }[];
  diffs?: { path: string; oldText?: string; newText: string }[];
}

export interface TranscriptExtension {
  messageKind?: (
    update: SessionUpdate,
    meta?: Record<string, unknown> | null
  ) => "branchSummary" | undefined;
  visibleMessageText?: (sessionUpdate: string, text: string) => string;
}

const stringify = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const toolUpdate = (
  update: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call" | "tool_call_update" }
  >
): TranscriptToolUpdate => {
  const diffs = (update.content ?? [])
    .filter((content) => content.type === "diff")
    .map((content) => ({
      path: content.path,
      ...(content.oldText === undefined || content.oldText === null
        ? {}
        : { oldText: content.oldText }),
      newText: content.newText,
    }));
  const text = (update.content ?? [])
    .filter(
      (content) => content.type === "content" && content.content.type === "text"
    )
    .map((content) =>
      content.type === "content" && content.content.type === "text"
        ? content.content.text
        : ""
    )
    .join("");
  const terminalOutput = (
    update._meta as { terminal_output?: { data?: unknown } } | null | undefined
  )?.terminal_output?.data;
  return {
    ...(update.kind === undefined || update.kind === null
      ? {}
      : { toolKind: update.kind }),
    ...(update.title === undefined || update.title === null
      ? {}
      : { title: update.title }),
    ...(update.status === undefined || update.status === null
      ? {}
      : { status: update.status }),
    ...(update.rawInput === undefined
      ? {}
      : { input: stringify(update.rawInput) }),
    ...(update.rawOutput === undefined
      ? {}
      : { output: stringify(update.rawOutput) }),
    ...(update.locations
      ? {
          locations: update.locations.map((location) => ({
            path: location.path,
            ...(location.line === undefined || location.line === null
              ? {}
              : { line: location.line }),
          })),
        }
      : {}),
    ...(diffs.length > 0 ? { diffs } : {}),
    ...(text.length > 0 ? { output: text } : {}),
    ...(typeof terminalOutput === "string" ? { terminalOutput } : {}),
    toolCallId: update.toolCallId,
  };
};

// oxlint-disable-next-line complexity -- ACP transcript updates are a protocol union.
export const translateTranscriptUpdate = (
  update: SessionUpdate,
  meta?: Record<string, unknown> | null,
  extension?: TranscriptExtension
): TranscriptAgentUpdate | undefined => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text" && update.content.type !== "image") {
        return undefined;
      }
      let kind: Extract<TranscriptAgentUpdate, { type: "message" }>["kind"] =
        "thought";
      if (update.sessionUpdate === "user_message_chunk") {
        kind = "user";
      } else if (
        update.sessionUpdate === "agent_message_chunk" &&
        extension?.messageKind?.(update, meta) === "branchSummary"
      ) {
        kind = "branchSummary";
      } else if (update.sessionUpdate === "agent_message_chunk") {
        kind = "assistant";
      }
      return {
        ...(typeof update.messageId === "string" && update.messageId.length > 0
          ? { messageId: update.messageId }
          : {}),
        kind,
        ...(update.content.type === "text"
          ? {
              text:
                extension?.visibleMessageText?.(
                  update.sessionUpdate,
                  update.content.text
                ) ?? update.content.text,
            }
          : {
              images: [
                {
                  data: update.content.data,
                  mimeType: update.content.mimeType,
                },
              ],
            }),
        type: "message",
      };
    }
    case "tool_call":
    case "tool_call_update": {
      return { ...toolUpdate(update), type: "tool" };
    }
    case "plan": {
      return {
        allCompleted:
          update.entries.length > 0 &&
          update.entries.every((entry) => entry.status === "completed"),
        entries: update.entries.map(({ content, status }) => ({
          content,
          status,
        })),
        text: update.entries
          .map(
            (entry) =>
              `${entry.status === "completed" ? "✓" : "•"} ${entry.content}`
          )
          .join("\n"),
        type: "plan",
      };
    }
    case "available_commands_update":
    case "compaction_summary_chunk":
    case "compaction_update":
    case "config_option_update":
    case "current_mode_update":
    case "plan_removed":
    case "plan_update":
    case "session_info_update":
    case "usage_update": {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
};

// oxlint-disable-next-line complexity -- message chunks may update text and images independently.
const appendMessage = (
  items: RenderedTranscriptItem[],
  update: Extract<TranscriptAgentUpdate, { type: "message" }>
): RenderedTranscriptItem | undefined => {
  if ((update.text?.length ?? 0) === 0 && (update.images?.length ?? 0) === 0) {
    return undefined;
  }
  const id =
    update.messageId === undefined || update.messageId.length === 0
      ? undefined
      : `${update.kind}:${update.messageId}`;
  const existing =
    id === undefined ? items.at(-1) : items.find((item) => item.id === id);
  if (existing?.kind === update.kind) {
    existing.text = (existing.text ?? "") + (update.text ?? "");
    if ((update.images?.length ?? 0) > 0) {
      existing.images = [...(existing.images ?? []), ...(update.images ?? [])];
    }
    return existing;
  }
  const item: RenderedTranscriptItem = {
    id: id ?? globalThis.crypto.randomUUID(),
    kind: update.kind,
    ...(update.text === undefined || update.text.length === 0
      ? {}
      : { text: update.text }),
    ...((update.images?.length ?? 0) > 0 ? { images: update.images } : {}),
  };
  items.push(item);
  return item;
};

const upsertTool = (
  items: RenderedTranscriptItem[],
  update: Extract<TranscriptAgentUpdate, { type: "tool" }>
): RenderedTranscriptItem | undefined => {
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
  if ((update.diffs?.length ?? 0) > 0) {
    item.diffs = update.diffs;
  }
  if (update.terminalOutput !== undefined) {
    item.output = (item.output ?? "") + update.terminalOutput;
  }
  return item;
};

export const reduceTranscriptUpdate = (
  items: RenderedTranscriptItem[],
  update: TranscriptAgentUpdate
): RenderedTranscriptItem | undefined => {
  if (update.type === "message") {
    return appendMessage(items, update);
  }
  if (update.type === "tool") {
    return upsertTool(items, update);
  }
  const existing = items.find((item) => item.id === "plan");
  if (existing) {
    existing.text = update.text;
    existing.allCompleted = update.allCompleted;
    existing.planEntries = update.entries;
    return existing;
  }
  const plan: RenderedTranscriptItem = {
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
