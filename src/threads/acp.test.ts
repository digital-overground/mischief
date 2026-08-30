import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { promptContent, translateSessionUpdate } from "./acp";

describe("ACP adapter", () => {
  test("embeds referenced Workspace files without allowing path escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mischief-context-"));
    const workspace = path.join(root, "workspace");
    const file = path.join(workspace, "src/projects.ts");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await Promise.all([
        writeFile(file, "export const projects = true;\n"),
        writeFile(path.join(root, "secret.txt"), "do not attach\n"),
      ]);

      await expect(
        promptContent(workspace, "@src/projects.ts testing @../secret.txt", [])
      ).resolves.toStrictEqual([
        {
          text: "@src/projects.ts testing @../secret.txt",
          type: "text",
        },
        {
          resource: {
            mimeType: "text/plain",
            text: "export const projects = true;\n",
            uri: pathToFileURL(await realpath(file)).href,
          },
          type: "resource",
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps embedded file contents out of replayed prompt text", () => {
    expect(
      translateSessionUpdate({
        content: {
          text: "@src/projects.ts testing\n[Embedded Context] file:///workspace/src/projects.ts (text/plain)\nexport const projects = true;",
          type: "text",
        },
        sessionUpdate: "user_message_chunk",
      })
    ).toStrictEqual({
      kind: "user",
      text: "@src/projects.ts testing",
      type: "message",
    });
  });

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

  test("translates completed plans into Thread events", () => {
    expect(
      translateSessionUpdate({
        entries: [
          {
            content: "Inspect",
            priority: "medium",
            status: "completed",
          },
          {
            content: "Test",
            priority: "medium",
            status: "completed",
          },
        ],
        sessionUpdate: "plan",
      })
    ).toStrictEqual({
      allCompleted: true,
      entries: [
        { content: "Inspect", status: "completed" },
        { content: "Test", status: "completed" },
      ],
      text: "✓ Inspect\n✓ Test",
      type: "plan",
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
