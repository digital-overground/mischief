import { describe, expect, test } from "vitest";

import { translateSessionUpdate } from "./acp";

describe("ACP adapter", () => {
  test("translates image chunks into Thread messages", () => {
    expect(
      translateSessionUpdate({
        content: {
          data: "c2NyZWVuc2hvdA==",
          mimeType: "image/png",
          type: "image",
        },
        messageId: "message-1",
        sessionUpdate: "user_message_chunk",
      })
    ).toStrictEqual({
      images: [{ data: "c2NyZWVuc2hvdA==", mimeType: "image/png" }],
      kind: "user",
      messageId: "message-1",
      type: "message",
    });
  });

  test("translates protocol updates into Thread events", () => {
    expect(
      translateSessionUpdate({
        content: [
          {
            newText: "new",
            oldText: "old",
            path: "/workspace/a.ts",
            type: "diff",
          },
        ],
        rawInput: { path: "a.ts" },
        sessionUpdate: "tool_call",
        status: "completed",
        title: "Edit file",
        toolCallId: "tool-1",
      })
    ).toStrictEqual({
      diffs: [{ newText: "new", oldText: "old", path: "/workspace/a.ts" }],
      input: '{\n  "path": "a.ts"\n}',
      status: "completed",
      title: "Edit file",
      toolCallId: "tool-1",
      type: "tool",
    });
  });
});
