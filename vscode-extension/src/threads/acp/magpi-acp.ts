import { methods } from "@agentclientprotocol/sdk";
import type { ClientContext, SessionUpdate } from "@agentclientprotocol/sdk";

import { isRecord } from "../../present";
import type { AgentAuthentication, AgentHistoryEntry } from "../model";
import type {
  AcpExtension,
  AgentTreeNavigationOptions,
  AgentTreeNavigationResult,
} from "./models";

export const BRANCH_SUMMARY_CAPABILITY = "magpi-acp/branch-summary";
export const MESSAGE_TARGET_ACTIONS_CAPABILITY =
  "magpi-acp/message-target-actions";
export const NAVIGATE_TREE_METHOD = "_magpi-acp/session/navigate-tree";
export const FORK_MESSAGE_ID_META = "magpi-acp/fork-message-id";
export const COMMAND_SOURCE_META = "magpi-acp/command-source";

const metadata = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const supportsMessageActions = (capabilities: unknown): boolean => {
  const agent = metadata(capabilities);
  const session = metadata(agent?.sessionCapabilities);
  const meta = metadata(agent?._meta);
  return (
    metadata(session?.fork) !== undefined &&
    meta?.[MESSAGE_TARGET_ACTIONS_CAPABILITY] === true
  );
};

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const stringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const legacyTerminalAuthentication = (
  error: unknown,
  advertised: unknown[]
): AgentAuthentication | undefined => {
  const data = metadata(error)?.data;
  const authMethods = metadata(data)?.authMethods;
  const authMethodsToCheck = Array.isArray(authMethods)
    ? authMethods
    : advertised;
  for (const method of authMethodsToCheck) {
    const value = metadata(method);
    const meta = metadata(value?._meta);
    const terminal = metadata(meta?.["terminal-auth"]);
    if (!terminal) {
      continue;
    }
    const { args, command, env, label: terminalLabel } = terminal;
    if (typeof command !== "string" || !stringArray(args)) {
      continue;
    }
    let label = "Authenticate";
    if (typeof terminalLabel === "string") {
      label = terminalLabel;
    } else if (typeof value?.name === "string") {
      label = value.name;
    }
    return {
      args,
      command,
      ...(stringRecord(env) && Object.keys(env).length ? { env } : {}),
      label,
    };
  }
  return undefined;
};

export const decodeMagpiTreeNavigationResult = (
  value: unknown
): AgentTreeNavigationResult => {
  const response = metadata(value);
  if (
    !response ||
    (response.leafId !== null && typeof response.leafId !== "string")
  ) {
    throw new TypeError("Invalid MagPi tree navigation response");
  }
  if (
    response.draft === undefined ||
    response.draft === null ||
    response.draft === ""
  ) {
    return {};
  }
  if (typeof response.draft !== "string") {
    throw new TypeError("Invalid MagPi tree navigation response");
  }
  return { draft: response.draft };
};

export const magpiAcpExtension: AcpExtension = {
  authentication: (error, _launch, advertised) =>
    legacyTerminalAuthentication(error, advertised),
  command: (command) => {
    const source = metadata(command._meta)?.[COMMAND_SOURCE_META];
    return {
      skill: command.name.startsWith("skill:"),
      ...(typeof source === "string" ? { source } : {}),
    };
  },
  forkMessage: async (agent, sessionId, cwd, messageId) =>
    await agent.request(methods.agent.session.fork, {
      _meta: { [FORK_MESSAGE_ID_META]: messageId },
      cwd,
      mcpServers: [],
      sessionId,
    }),
  messageKind: (update: SessionUpdate, meta) =>
    update.sessionUpdate === "agent_message_chunk" &&
    meta?.[BRANCH_SUMMARY_CAPABILITY] === true
      ? "branchSummary"
      : undefined,
  missingCapabilities: (capabilities) =>
    supportsMessageActions(capabilities)
      ? []
      : [MESSAGE_TARGET_ACTIONS_CAPABILITY],
  navigateTreeMessage: async (
    agent: ClientContext,
    sessionId: string,
    messageId: string,
    options: AgentTreeNavigationOptions
  ) => {
    const response: unknown = await agent.request<
      unknown,
      AgentTreeNavigationOptions & { messageId: string; sessionId: string }
    >(NAVIGATE_TREE_METHOD, { ...options, messageId, sessionId });
    return decodeMagpiTreeNavigationResult(response);
  },
  operations: (capabilities) => {
    const agent = metadata(capabilities);
    const meta = metadata(agent?._meta);
    return {
      branchSummary: meta?.[BRANCH_SUMMARY_CAPABILITY] === true,
      forkMessage: supportsMessageActions(capabilities),
      treeNavigation: meta?.[MESSAGE_TARGET_ACTIONS_CAPABILITY] === true,
    };
  },
  sessionPreview: (
    meta
  ): Pick<AgentHistoryEntry, "preview" | "previewRole"> => {
    const preview = metadata(meta)?.magPiAcp;
    const value = metadata(preview);
    return typeof value?.preview === "string" &&
      value.preview.length <= 160 &&
      (value.previewRole === "user" || value.previewRole === "assistant")
      ? { preview: value.preview, previewRole: value.previewRole }
      : {};
  },
  visibleMessageText: (sessionUpdate, text) =>
    sessionUpdate === "user_message_chunk"
      ? (text.split("\n[Embedded Context] ", 1)[0] ?? "")
      : text,
};
