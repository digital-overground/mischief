import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import {
  authenticationFor,
  decodeTreeNavigationResult,
  elicitationRequest,
  promptContent,
  sessionOperations,
  terminalAuthentication,
  translateSessionUpdate,
} from "./acp";

describe("ACP adapter", () => {
  test("requires explicit message-target support, not legacy picker capabilities", () => {
    expect(
      sessionOperations({
        _meta: {
          "magpi-acp/branch-summary": true,
          "magpi-acp/fork-picker": true,
          "magpi-acp/tree-picker": true,
        },
      })
    ).toStrictEqual({
      branchSummary: true,
      forkMessage: false,
      treeNavigation: false,
    });
    expect(
      sessionOperations({
        _meta: { "magpi-acp/message-target-actions": true },
      })
    ).toStrictEqual({
      branchSummary: false,
      forkMessage: true,
      treeNavigation: true,
    });
    expect(
      sessionOperations({
        _meta: { "magpi-acp/message-target-actions": "true" },
      })
    ).toStrictEqual({
      branchSummary: false,
      forkMessage: false,
      treeNavigation: false,
    });
    expect(sessionOperations({ _meta: null })).toStrictEqual({
      branchSummary: false,
      forkMessage: false,
      treeNavigation: false,
    });
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

  test("offers standard Agent authentication but not MagPi's private terminal metadata to Codex", () => {
    const launch = { args: ["/codex/dist/index.js"], command: "node" };
    const required = {
      code: -32_000,
      data: { authMethods: [{ id: "chatgpt", name: "Log in with ChatGPT" }] },
    };
    expect(authenticationFor(required, launch, [], "codex-acp")).toStrictEqual({
      label: "Log in with ChatGPT",
      methodId: "chatgpt",
    });
    expect(
      authenticationFor(
        { code: -32_001 },
        launch,
        required.data.authMethods,
        "codex-acp"
      )
    ).toBeUndefined();
    expect(
      authenticationFor(
        { code: -32_000 },
        launch,
        [
          {
            _meta: { "terminal-auth": { args: [], command: "untrusted" } },
            id: "legacy",
            name: "MagPi login",
          },
        ],
        "codex-acp"
      )
    ).toStrictEqual({ label: "MagPi login", methodId: "legacy" });
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
        promptContent(
          workspace,
          "@src/projects.ts testing @../secret.txt",
          [],
          false
        )
      ).resolves.toStrictEqual([
        { text: "@src/projects.ts testing @../secret.txt", type: "text" },
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
            _meta: {
              "magpi-acp/command-source": "git:github.com/example/review",
            },
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
          source: "git:github.com/example/review",
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
