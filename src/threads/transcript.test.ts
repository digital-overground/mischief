import { describe, expect, test } from "vitest";

import type { TranscriptItem } from "./threads";
import { reduceTranscript } from "./transcript";

describe("transcript reducer", () => {
  test("merges streamed messages, tool updates, and plans", () => {
    const items: TranscriptItem[] = [];

    reduceTranscript(items, {
      kind: "assistant",
      messageId: "message-1",
      text: "Hel",
      type: "message",
    });
    reduceTranscript(items, {
      kind: "assistant",
      messageId: "message-1",
      text: "lo",
      type: "message",
    });
    reduceTranscript(items, {
      images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
      kind: "assistant",
      messageId: "message-1",
      type: "message",
    });
    reduceTranscript(items, {
      output: "result",
      title: "Run command",
      toolCallId: "tool-1",
      type: "tool",
    });
    reduceTranscript(items, {
      status: "completed",
      terminalOutput: "\nline 1",
      toolCallId: "tool-1",
      type: "tool",
    });
    reduceTranscript(items, {
      terminalOutput: "\nline 2",
      toolCallId: "tool-1",
      type: "tool",
    });
    reduceTranscript(items, { text: "• Inspect", type: "plan" });
    reduceTranscript(items, { text: "✓ Inspect", type: "plan" });

    expect(items).toStrictEqual([
      {
        id: "assistant:message-1",
        images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
        kind: "assistant",
        text: "Hello",
      },
      {
        id: "tool:tool-1",
        kind: "tool",
        output: "result\nline 1\nline 2",
        status: "completed",
        title: "Run command",
      },
      { id: "plan", kind: "plan", text: "✓ Inspect", title: "Plan" },
    ]);
  });
});
