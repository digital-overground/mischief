import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import {
  authenticationFor,
  elicitationRequest,
  promptContent,
  translateSessionUpdate,
} from "./acp";
import {
  BRANCH_SUMMARY_CAPABILITY,
  COMMAND_SOURCE_META,
  MESSAGE_TARGET_ACTIONS_CAPABILITY,
  decodeMagpiTreeNavigationResult,
  magpiAcpExtension,
} from "./magpi-acp";

describe("ACP adapter", () => {
  test("requires advertised ACP fork and MagPi message-target capabilities", () => {
    expect(
      magpiAcpExtension.operations?.({
        _meta: {
          [BRANCH_SUMMARY_CAPABILITY]: true,
          "magpi-acp/fork-picker": true,
          "magpi-acp/tree-picker": true,
        },
        sessionCapabilities: { fork: {} },
      })
    ).toStrictEqual({
      branchSummary: true,
      forkMessage: false,
      treeNavigation: false,
    });
    expect(
      magpiAcpExtension.operations?.({
        _meta: { [MESSAGE_TARGET_ACTIONS_CAPABILITY]: true },
        sessionCapabilities: { fork: {} },
      })
    ).toStrictEqual({
      branchSummary: false,
      forkMessage: true,
      treeNavigation: true,
    });
    expect(
      magpiAcpExtension.operations?.({
        _meta: { [MESSAGE_TARGET_ACTIONS_CAPABILITY]: true },
      })
    ).toStrictEqual({
      branchSummary: false,
      forkMessage: false,
      treeNavigation: true,
    });
    expect(magpiAcpExtension.operations?.({ _meta: null })).toStrictEqual({
      branchSummary: false,
      forkMessage: false,
      treeNavigation: false,
    });
  });

  test("decodes optional MagPi tree navigation drafts", () => {
    expect(
      decodeMagpiTreeNavigationResult({ draft: "Try again", leafId: "user-1" })
    ).toStrictEqual({ draft: "Try again" });
    expect(
      decodeMagpiTreeNavigationResult({ draft: null, leafId: "assistant-1" })
    ).toStrictEqual({});
    expect(() =>
      decodeMagpiTreeNavigationResult({ draft: 42, leafId: "user-1" })
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

  test("translates standard terminal authentication methods", () => {
    expect(
      authenticationFor(
        {
          code: -32_000,
          data: {
            authMethods: [
              {
                args: ["--login"],
                env: { TOKEN: "new" },
                name: "Log in",
                type: "terminal",
              },
            ],
          },
        },
        { args: ["--stdio"], command: "agent", env: { BASE: "yes" } },
        []
      )
    ).toStrictEqual({
      args: ["--stdio", "--login"],
      command: "agent",
      env: { BASE: "yes", TOKEN: "new" },
      label: "Log in",
    });
  });

  test("keeps MagPi legacy terminal authentication inside its extension", () => {
    const error = {
      code: -32_000,
      data: {
        authMethods: [
          {
            _meta: {
              "terminal-auth": {
                args: ["--login"],
                command: "magpi-auth",
                env: { TOKEN: "old" },
                label: "Old login",
              },
            },
          },
        ],
      },
    };
    expect(
      authenticationFor(
        error,
        { args: [], command: "magpi" },
        [],
        magpiAcpExtension
      )
    ).toStrictEqual({
      args: ["--login"],
      command: "magpi-auth",
      env: { TOKEN: "old" },
      label: "Old login",
    });
    expect(
      authenticationFor(error, { args: [], command: "agent" }, [])
    ).toBeUndefined();
    expect(
      authenticationFor(
        { code: -32_000 },
        { args: [], command: "magpi" },
        error.data.authMethods,
        magpiAcpExtension
      )
    ).toStrictEqual({
      args: ["--login"],
      command: "magpi-auth",
      env: { TOKEN: "old" },
      label: "Old login",
    });
  });

  test("offers standard Agent authentication without MagPi's private metadata", () => {
    const launch = { args: ["/codex/dist/index.js"], command: "node" };
    const required = {
      code: -32_000,
      data: { authMethods: [{ id: "chatgpt", name: "Log in with ChatGPT" }] },
    };
    expect(authenticationFor(required, launch, [])).toStrictEqual({
      label: "Log in with ChatGPT",
      methodId: "chatgpt",
    });
    expect(
      authenticationFor({ code: -32_001 }, launch, required.data.authMethods)
    ).toBeUndefined();
    expect(
      authenticationFor(
        {
          code: -32_000,
          data: {
            authMethods: [
              {
                _meta: { "terminal-auth": { args: [], command: "untrusted" } },
                id: "legacy",
                name: "MagPi login",
              },
            ],
          },
        },
        launch,
        []
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

  test("keeps protocol updates generic and applies MagPi markers only through its extension", () => {
    const userUpdate = {
      content: {
        text: "@src/projects.ts testing\n[Embedded Context] file:///workspace/src/projects.ts (text/plain)\nexport const projects = true;",
        type: "text" as const,
      },
      sessionUpdate: "user_message_chunk" as const,
    };
    expect(translateSessionUpdate(userUpdate)).toMatchObject({
      kind: "user",
      text: "@src/projects.ts testing\n[Embedded Context] file:///workspace/src/projects.ts (text/plain)\nexport const projects = true;",
    });
    expect(
      translateSessionUpdate(userUpdate, undefined, magpiAcpExtension)
    ).toMatchObject({ kind: "user", text: "@src/projects.ts testing" });

    const summary = {
      content: {
        text: "Preserve the adapter decision.",
        type: "text" as const,
      },
      sessionUpdate: "agent_message_chunk" as const,
    };
    expect(
      translateSessionUpdate(summary, { [BRANCH_SUMMARY_CAPABILITY]: true })
    ).toMatchObject({ kind: "assistant" });
    expect(
      translateSessionUpdate(
        summary,
        { [BRANCH_SUMMARY_CAPABILITY]: true },
        magpiAcpExtension
      )
    ).toMatchObject({ kind: "branchSummary" });
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

  test("translates every standard advertised command; MagPi metadata stays extension-owned", () => {
    const update = {
      availableCommands: [
        {
          _meta: {
            [COMMAND_SOURCE_META]: "git:github.com/example/review",
          },
          description: "Run a review",
          input: { _meta: { futureInputType: "text" }, hint: "[branch]" },
          name: "skill:review",
        },
        {
          description: "Clear context",
          input: null,
          name: "clear",
        },
        {
          description: "Codex skill",
          name: "$review",
        },
      ],
      sessionUpdate: "available_commands_update" as const,
    };
    expect(translateSessionUpdate(update)).toStrictEqual({
      commands: [
        {
          description: "Run a review",
          inputHint: "[branch]",
          name: "skill:review",
        },
        { description: "Clear context", name: "clear" },
        { description: "Codex skill", name: "$review" },
      ],
      type: "commands",
    });
    expect(
      translateSessionUpdate(update, undefined, magpiAcpExtension)
    ).toStrictEqual({
      commands: [
        {
          description: "Run a review",
          inputHint: "[branch]",
          name: "skill:review",
          skill: true,
          source: "git:github.com/example/review",
        },
        { description: "Clear context", name: "clear", skill: false },
        { description: "Codex skill", name: "$review", skill: false },
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
