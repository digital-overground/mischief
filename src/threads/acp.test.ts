import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import {
  decodeForkTargets,
  decodeTreeNavigationResult,
  decodeTreeTargets,
  elicitationRequest,
  promptContent,
  sessionOperations,
  terminalAuthentication,
  translateSessionUpdate,
} from "./acp";

describe("ACP adapter", () => {
  test("reads only literal native operation capabilities", () => {
    expect(
      sessionOperations({
        _meta: {
          "magpi-acp/branch-summary": true,
          "magpi-acp/fork-picker": true,
          "magpi-acp/tree-picker": "true",
        },
      })
    ).toStrictEqual({
      branchSummary: true,
      forkPicker: true,
      treePicker: false,
    });
    expect(sessionOperations({ _meta: null })).toStrictEqual({
      branchSummary: false,
      forkPicker: false,
      treePicker: false,
    });
  });

  test("decodes fork targets in Agent order", () => {
    expect(
      decodeForkTargets({
        messages: [
          { entryId: "user-1", text: "First" },
          { entryId: "user-2", text: "Second\nline" },
        ],
      })
    ).toStrictEqual([
      { entryId: "user-1", text: "First" },
      { entryId: "user-2", text: "Second\nline" },
    ]);
  });

  test("rejects malformed fork responses as a whole", () => {
    expect(() =>
      decodeForkTargets({
        messages: [{ entryId: "user-1", text: "First" }, { text: "No ID" }],
      })
    ).toThrow("Invalid MagPi fork messages response");
  });

  test("flattens visible tree messages in preorder", () => {
    expect(
      decodeTreeTargets({
        leafId: "assistant-1",
        tree: [
          {
            children: [
              {
                children: [],
                entry: {
                  id: "assistant-1",
                  message: {
                    content: [{ text: "Done", type: "text" }],
                    role: "assistant",
                  },
                  type: "message",
                },
              },
            ],
            entry: {
              id: "user-1",
              message: { content: "Explain this", role: "user" },
              type: "message",
            },
          },
          {
            children: [
              {
                children: [],
                entry: {
                  id: "user-2",
                  message: { content: "Alternate", role: "user" },
                  type: "message",
                },
              },
            ],
            entry: { id: "custom-1", type: "compaction" },
          },
        ],
      })
    ).toStrictEqual([
      {
        activeBranch: true,
        current: false,
        depth: 0,
        entryId: "user-1",
        role: "user",
        text: "Explain this",
      },
      {
        activeBranch: true,
        current: true,
        depth: 0,
        entryId: "assistant-1",
        role: "assistant",
        text: "Done",
      },
      {
        activeBranch: false,
        current: false,
        depth: 0,
        entryId: "user-2",
        role: "user",
        text: "Alternate",
      },
    ]);
  });

  test("does not indent a linear conversation as nested branches", () => {
    expect(
      decodeTreeTargets({
        leafId: "assistant-2",
        tree: [
          {
            children: [
              {
                children: [
                  {
                    children: [],
                    entry: {
                      id: "assistant-2",
                      message: { content: "Second", role: "assistant" },
                      type: "message",
                    },
                  },
                ],
                entry: {
                  id: "assistant-1",
                  message: { content: "First", role: "assistant" },
                  type: "message",
                },
              },
            ],
            entry: {
              id: "user-1",
              message: { content: "Start", role: "user" },
              type: "message",
            },
          },
        ],
      }).map(({ depth }) => depth)
    ).toStrictEqual([0, 0, 0]);
  });

  test("indents alternatives at branch points", () => {
    expect(
      decodeTreeTargets({
        leafId: "assistant-1",
        tree: [
          {
            children: [
              {
                children: [],
                entry: {
                  id: "assistant-1",
                  message: { content: "First", role: "assistant" },
                  type: "message",
                },
              },
              {
                children: [],
                entry: {
                  id: "assistant-2",
                  message: { content: "Alternate", role: "assistant" },
                  type: "message",
                },
              },
            ],
            entry: {
              id: "user-1",
              message: { content: "Start", role: "user" },
              type: "message",
            },
          },
        ],
      }).map(({ depth }) => depth)
    ).toStrictEqual([0, 1, 1]);
  });

  test("keeps image prompts and excludes assistant tool-only entries", () => {
    expect(
      decodeTreeTargets({
        leafId: "user-1",
        tree: [
          {
            children: [],
            entry: {
              id: "user-1",
              message: {
                content: [{ type: "image", url: "image" }],
                role: "user",
              },
              type: "message",
            },
          },
          {
            children: [],
            entry: {
              id: "assistant-1",
              message: {
                content: [{ name: "read", type: "toolCall" }],
                role: "assistant",
              },
              type: "message",
            },
          },
        ],
      })
    ).toMatchObject([{ current: true, text: "Image prompt" }]);
    expect(() =>
      decodeTreeTargets({ leafId: null, tree: [{ children: [] }] })
    ).toThrow("Invalid MagPi tree response");
  });

  test("decodes optional tree navigation drafts", () => {
    expect(
      decodeTreeNavigationResult({ draft: "Try again", leafId: "user-1" })
    ).toStrictEqual({ draft: "Try again" });
    expect(
      decodeTreeNavigationResult({ draft: null, leafId: "assistant-1" })
    ).toStrictEqual({});
    expect(() =>
      decodeTreeNavigationResult({ draft: 42, leafId: "user-1" })
    ).toThrow("Invalid MagPi tree navigation response");
  });

  test("translates standard elicitation choice descriptions", () => {
    expect(
      elicitationRequest({
        message: "Choose a mode",
        mode: "form",
        requestedSchema: {
          properties: {
            mode: {
              oneOf: [
                {
                  const: "fast",
                  description: "Use less thinking",
                  title: "Fast",
                },
                {
                  _meta: { magPiAcp: { description: "Legacy slow help" } },
                  const: "slow",
                  title: "Slow",
                },
              ],
              type: "string",
            },
          },
          type: "object",
        },
        sessionId: "session-1",
      })
    ).toStrictEqual({
      fields: [
        {
          label: "mode",
          name: "mode",
          options: [
            {
              description: "Use less thinking",
              name: "Fast",
              value: "fast",
            },
            {
              description: "Legacy slow help",
              name: "Slow",
              value: "slow",
            },
          ],
          required: false,
          type: "select",
        },
      ],
      message: "Choose a mode",
    });
  });

  test("rejects unknown elicitation property types", () => {
    expect(() =>
      elicitationRequest({
        message: "Future input",
        mode: "form",
        requestedSchema: {
          properties: {
            future: { type: "future" },
          },
          type: "object",
        },
        sessionId: "session-1",
      })
    ).toThrow("Unsupported elicitation property schema");
  });

  test("prefers standard terminal authentication methods", () => {
    expect(
      terminalAuthentication(
        {
          data: {
            authMethods: [
              {
                _meta: {
                  "terminal-auth": {
                    args: ["--old"],
                    command: "old-agent",
                  },
                },
                name: "Old login",
              },
              {
                args: ["--login"],
                env: { MAGPI_TOKEN: "new" },
                name: "Log in",
                type: "terminal",
              },
            ],
          },
        },
        { args: ["--stdio"], command: "magpi", env: { BASE: "yes" } }
      )
    ).toStrictEqual({
      args: ["--stdio", "--login"],
      command: "magpi",
      env: { BASE: "yes", MAGPI_TOKEN: "new" },
      label: "Log in",
    });
  });

  test("keeps the legacy terminal authentication fallback", () => {
    expect(
      terminalAuthentication({
        data: {
          authMethods: [
            {
              _meta: {
                "terminal-auth": {
                  args: ["--login"],
                  command: "magpi-auth",
                  env: { MAGPI_TOKEN: "old" },
                  label: "Old login",
                },
              },
            },
          ],
        },
      })
    ).toStrictEqual({
      args: ["--login"],
      command: "magpi-auth",
      env: { MAGPI_TOKEN: "old" },
      label: "Old login",
    });
  });

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

  test("translates MagPi branch summaries into system transcript entries", () => {
    expect(
      translateSessionUpdate(
        {
          content: {
            text: "Preserve the adapter decision.",
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
        { "magpi-acp/branch-summary": true }
      )
    ).toStrictEqual({
      kind: "branchSummary",
      text: "Preserve the adapter decision.",
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

  test("translates advertised commands without leaking ACP input metadata", () => {
    expect(
      translateSessionUpdate({
        availableCommands: [
          {
            description: "Run a review",
            input: { _meta: { futureInputType: "text" }, hint: "[branch]" },
            name: "review",
          },
          {
            description: "Start fresh",
            input: null,
            name: "new",
          },
        ],
        sessionUpdate: "available_commands_update",
      })
    ).toStrictEqual({
      commands: [
        {
          description: "Run a review",
          inputHint: "[branch]",
          name: "review",
        },
        { description: "Start fresh", name: "new" },
      ],
      type: "commands",
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
        kind: "edit",
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
      toolKind: "edit",
      type: "tool",
    });
  });
});
