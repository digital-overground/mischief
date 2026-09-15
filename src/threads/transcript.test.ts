import { describe, expect, test } from "vitest";

import type { TranscriptItem } from "./threads";
import { archiveCompletedPlan, reduceTranscript } from "./transcript";

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
      toolKind: "execute",
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
    reduceTranscript(items, {
      allCompleted: false,
      entries: [{ content: "Inspect", status: "pending" }],
      text: "• Inspect",
      type: "plan",
    });
    reduceTranscript(items, {
      allCompleted: false,
      entries: [{ content: "Inspect", status: "completed" }],
      text: "✓ Inspect",
      type: "plan",
    });

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
        toolKind: "execute",
      },
      {
        allCompleted: false,
        id: "plan",
        kind: "plan",
        planEntries: [{ content: "Inspect", status: "completed" }],
        text: "✓ Inspect",
        title: "Plan",
      },
    ]);
  });

  test("omits todo calls while retaining their plan updates", () => {
    const items: TranscriptItem[] = [];

    expect(
      reduceTranscript(items, {
        title: "todo",
        toolCallId: "todo-1",
        toolKind: "other",
        type: "tool",
      })
    ).toBeUndefined();
    expect(
      reduceTranscript(items, {
        output: "Updated #1 (in_progress → completed)",
        status: "completed",
        toolCallId: "todo-1",
        type: "tool",
      })
    ).toBeUndefined();
    reduceTranscript(items, {
      allCompleted: false,
      entries: [{ content: "Implement", status: "in_progress" }],
      text: "• Implement",
      type: "plan",
    });

    expect(items).toStrictEqual([
      {
        allCompleted: false,
        id: "plan",
        kind: "plan",
        planEntries: [{ content: "Implement", status: "in_progress" }],
        text: "• Implement",
        title: "Plan",
      },
    ]);
  });

  test("archives an all-completed plan into the transcript", () => {
    const items: TranscriptItem[] = [];
    reduceTranscript(items, {
      allCompleted: true,
      entries: [
        { content: "Inspect", status: "completed" },
        { content: "Test", status: "completed" },
      ],
      text: "✓ Inspect\n✓ Test",
      type: "plan",
    });

    archiveCompletedPlan(items);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "completedPlan",
      text: "✓ Inspect\n✓ Test",
      title: "Completed Plan",
    });
  });
});
