import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ClientSideConnection,
  CreateElicitationRequest as CreateElicitationRequestGuard,
  ElicitationPropertySchema as ElicitationPropertySchemaGuard,
  MultiSelectItems,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import type {
  AgentConnection,
  AgentConnectionFactory,
  AgentError,
  AgentElicitationRequest,
  AgentElicitationResponse,
  AgentHandlers,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentToolUpdate,
  AgentUpdate,
  ElicitationField,
  PromptImage,
  TerminalAuthentication,
  ThreadConfigChoice,
  ThreadConfigOption,
} from "./threads";

export interface AgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const MAX_CONTEXT_BYTES = 1_000_000;
const MAX_CONTEXT_FILES = 20;

const referencedPaths = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/(?:^|\s)@(?<path>[^\s]+)/gu)]
      .map((match) => match.groups?.path)
      .filter(
        (candidate): candidate is string =>
          Boolean(candidate) && !candidate?.endsWith("/")
      )
  ),
];

export const promptContent = async (
  cwd: string | undefined,
  text: string,
  images: PromptImage[]
): Promise<ContentBlock[]> => {
  const blocks: ContentBlock[] = [
    ...(text ? [{ text, type: "text" as const }] : []),
    ...images.map((image) => ({ ...image, type: "image" as const })),
  ];
  const references = referencedPaths(text);
  if (!cwd || !references.length) {
    return blocks;
  }
  if (references.length > MAX_CONTEXT_FILES) {
    throw new Error(`Attach at most ${MAX_CONTEXT_FILES} context files`);
  }

  const root = await realpath(cwd);
  const resolved = await Promise.all(
    references.map(async (reference) => {
      let file: string;
      try {
        file = await realpath(path.resolve(root, reference));
      } catch {
        return;
      }
      const relative = path.relative(root, file);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return;
      }
      const details = await stat(file);
      return details.isFile() ? { file, size: details.size } : undefined;
    })
  );
  const files = [
    ...new Map(
      resolved
        .filter((item): item is { file: string; size: number } => Boolean(item))
        .map((item) => [item.file, item])
    ).values(),
  ];
  if (files.reduce((total, file) => total + file.size, 0) > MAX_CONTEXT_BYTES) {
    throw new Error("Attached context exceeds 1 MB");
  }
  blocks.push(
    ...(await Promise.all(
      files.map(async ({ file }) => ({
        resource: {
          mimeType: "text/plain",
          text: await readFile(file, "utf-8"),
          uri: pathToFileURL(file).href,
        },
        type: "resource" as const,
      }))
    ))
  );
  return blocks;
};

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

const configChoice = (option: {
  value: string;
  name: string;
  description?: string | null;
}): ThreadConfigChoice => ({
  ...(option.description !== undefined && option.description !== null
    ? { description: option.description }
    : {}),
  name: option.name,
  value: option.value,
});

const configOptions = (
  options: SessionConfigOption[] | null | undefined
): ThreadConfigOption[] =>
  (options ?? []).map((option) => {
    const common = {
      ...(option.description !== undefined && option.description !== null
        ? { description: option.description }
        : {}),
      ...(option.category !== undefined && option.category !== null
        ? { category: option.category }
        : {}),
      id: option.id,
      name: option.name,
    };
    if (option.type === "boolean") {
      return { ...common, currentValue: option.currentValue, type: "boolean" };
    }
    return {
      ...common,
      currentValue: option.currentValue,
      options: option.options.map((candidate) =>
        "value" in candidate
          ? configChoice(candidate)
          : {
              name: candidate.name,
              options: candidate.options.map(configChoice),
            }
      ),
      type: "select",
    };
  });

const permissionRequest = (
  request: RequestPermissionRequest
): AgentPermissionRequest => ({
  message: request.toolCall.title ?? "Permission required",
  options: request.options.map((option) => ({
    id: option.optionId,
    kind: option.kind,
    name: option.name,
  })),
});

const permissionResponse = (
  response: AgentPermissionResponse
): RequestPermissionResponse =>
  "optionId" in response
    ? { outcome: { optionId: response.optionId, outcome: "selected" } }
    : { outcome: { outcome: "cancelled" } };

const elicitationOptionDescription = (
  meta: Record<string, unknown> | null | undefined
): string | undefined => {
  const magPiAcp = meta?.magPiAcp;
  if (!magPiAcp || typeof magPiAcp !== "object") {
    return;
  }
  const { description } = magPiAcp as Record<string, unknown>;
  return typeof description === "string" ? description : undefined;
};

const optionDescription = (option: {
  description?: string | null;
  _meta?: Record<string, unknown> | null;
}): string | undefined =>
  option.description ?? elicitationOptionDescription(option._meta);

type SupportedElicitationPropertySchema =
  | Extract<ElicitationPropertySchema, { type: "string" }>
  | Extract<ElicitationPropertySchema, { type: "number" }>
  | Extract<ElicitationPropertySchema, { type: "integer" }>
  | Extract<ElicitationPropertySchema, { type: "boolean" }>
  | Extract<ElicitationPropertySchema, { type: "array" }>;

const supportedElicitationSchema = (
  schema: ElicitationPropertySchema
): SupportedElicitationPropertySchema => {
  if (
    ElicitationPropertySchemaGuard.isString(schema) ||
    ElicitationPropertySchemaGuard.isNumber(schema) ||
    ElicitationPropertySchemaGuard.isInteger(schema) ||
    ElicitationPropertySchemaGuard.isBoolean(schema) ||
    ElicitationPropertySchemaGuard.isArray(schema)
  ) {
    return schema;
  }
  throw new Error("Unsupported elicitation property schema");
};

const elicitationOptions = (
  schema: ElicitationPropertySchema
): { value: string; name: string; description?: string }[] | undefined => {
  if (ElicitationPropertySchemaGuard.isString(schema)) {
    if (schema.oneOf) {
      return schema.oneOf.map((option) => ({
        ...(optionDescription(option)
          ? { description: optionDescription(option) }
          : {}),
        name: option.title,
        value: option.const,
      }));
    }
    if (schema.enum) {
      return schema.enum.map((value) => ({ name: value, value }));
    }
    return undefined;
  }
  if (ElicitationPropertySchemaGuard.isArray(schema)) {
    if (MultiSelectItems.isTitled(schema.items)) {
      return schema.items.anyOf.map((option) => ({
        ...(optionDescription(option)
          ? { description: optionDescription(option) }
          : {}),
        name: option.title,
        value: option.const,
      }));
    }
    if (MultiSelectItems.isString(schema.items)) {
      return schema.items.enum.map((value) => ({ name: value, value }));
    }
    throw new Error("Unsupported elicitation choice schema");
  }
  if (
    ElicitationPropertySchemaGuard.isBoolean(schema) ||
    ElicitationPropertySchemaGuard.isNumber(schema) ||
    ElicitationPropertySchemaGuard.isInteger(schema)
  ) {
    return undefined;
  }
  throw new Error("Unsupported elicitation property schema");
};

export const elicitationRequest = (
  request: Extract<CreateElicitationRequest, { mode: "form" }>
): AgentElicitationRequest => {
  const required = new Set(request.requestedSchema.required);
  const fields = Object.entries(request.requestedSchema.properties ?? {}).map(
    ([name, rawSchema]) => {
      const schema = supportedElicitationSchema(rawSchema);
      const options = elicitationOptions(schema);
      let type: ElicitationField["type"];
      if (ElicitationPropertySchemaGuard.isBoolean(schema)) {
        type = "boolean";
      } else if (
        ElicitationPropertySchemaGuard.isNumber(schema) ||
        ElicitationPropertySchemaGuard.isInteger(schema)
      ) {
        type = "number";
      } else if (ElicitationPropertySchemaGuard.isArray(schema)) {
        type = "multiselect";
      } else {
        type = options ? "select" : "text";
      }
      return {
        ...(schema.default !== undefined && schema.default !== null
          ? { defaultValue: schema.default }
          : {}),
        ...(schema.description ? { description: schema.description } : {}),
        ...(options ? { options } : {}),
        label: schema.title ?? name,
        name,
        required: required.has(name),
        type,
      };
    }
  );
  return {
    ...(request.requestedSchema.description
      ? { context: request.requestedSchema.description }
      : {}),
    fields,
    message: request.message,
  };
};

const stringValue = (
  name: string,
  schema: Extract<ElicitationPropertySchema, { type: "string" }>,
  value: unknown
): string => {
  if (typeof value !== "string") {
    throw new TypeError(`Invalid value for ${name}`);
  }
  const allowed = schema.oneOf?.map((option) => option.const) ?? schema.enum;
  if (allowed && !allowed.includes(value)) {
    throw new Error(`Invalid option for ${name}`);
  }
  if (
    schema.minLength !== undefined &&
    schema.minLength !== null &&
    value.length < schema.minLength
  ) {
    throw new Error(`${name} is too short`);
  }
  if (
    schema.maxLength !== undefined &&
    schema.maxLength !== null &&
    value.length > schema.maxLength
  ) {
    throw new Error(`${name} is too long`);
  }
  if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
    throw new Error(`${name} has an invalid format`);
  }
  return value;
};

const numberValue = (
  name: string,
  schema: Extract<ElicitationPropertySchema, { type: "number" | "integer" }>,
  value: unknown
): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (
    !Number.isFinite(number) ||
    (schema.type === "integer" && !Number.isInteger(number))
  ) {
    throw new Error(`Invalid number for ${name}`);
  }
  if (
    schema.minimum !== undefined &&
    schema.minimum !== null &&
    number < schema.minimum
  ) {
    throw new Error(`${name} is too small`);
  }
  if (
    schema.maximum !== undefined &&
    schema.maximum !== null &&
    number > schema.maximum
  ) {
    throw new Error(`${name} is too large`);
  }
  return number;
};

const choicesValue = (
  name: string,
  schema: Extract<ElicitationPropertySchema, { type: "array" }>,
  value: unknown
): string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Invalid choices for ${name}`);
  }
  const allowed =
    elicitationOptions(schema)?.map((option) => option.value) ?? [];
  if (value.some((item) => !allowed.includes(item))) {
    throw new Error(`Invalid choices for ${name}`);
  }
  if (
    schema.minItems !== undefined &&
    schema.minItems !== null &&
    value.length < schema.minItems
  ) {
    throw new Error(`Select more choices for ${name}`);
  }
  if (
    schema.maxItems !== undefined &&
    schema.maxItems !== null &&
    value.length > schema.maxItems
  ) {
    throw new Error(`Select fewer choices for ${name}`);
  }
  return value;
};

const elicitationValue = (
  name: string,
  schema: ElicitationPropertySchema,
  value: unknown
): ElicitationContentValue => {
  if (ElicitationPropertySchemaGuard.isString(schema)) {
    return stringValue(name, schema, value);
  }
  if (ElicitationPropertySchemaGuard.isBoolean(schema)) {
    if (typeof value !== "boolean") {
      throw new TypeError(`Invalid value for ${name}`);
    }
    return value;
  }
  if (
    ElicitationPropertySchemaGuard.isNumber(schema) ||
    ElicitationPropertySchemaGuard.isInteger(schema)
  ) {
    return numberValue(name, schema, value);
  }
  if (ElicitationPropertySchemaGuard.isArray(schema)) {
    return choicesValue(name, schema, value);
  }
  throw new Error(`Unsupported elicitation property schema for ${name}`);
};

const elicitationContent = (
  request: Extract<CreateElicitationRequest, { mode: "form" }>,
  values: Record<string, unknown>
): Record<string, ElicitationContentValue> => {
  const content: Record<string, ElicitationContentValue> = {};
  const required = new Set(request.requestedSchema.required);
  for (const [name, schema] of Object.entries(
    request.requestedSchema.properties ?? {}
  )) {
    if (!Object.hasOwn(values, name)) {
      if (required.has(name)) {
        throw new Error(`Missing required field: ${name}`);
      }
      continue;
    }
    content[name] = elicitationValue(name, schema, values[name]);
  }
  return content;
};

const elicitationResponse = (
  request: Extract<CreateElicitationRequest, { mode: "form" }>,
  response: AgentElicitationResponse
): CreateElicitationResponse =>
  response.action === "accept"
    ? {
        action: "accept",
        content: elicitationContent(request, response.values),
      }
    : { action: "cancel" };

const toolUpdate = (
  update: Extract<
    SessionUpdate,
    { sessionUpdate: "tool_call" | "tool_call_update" }
  >
): AgentToolUpdate => {
  const diffs = (update.content ?? [])
    .filter((content) => content.type === "diff")
    .map((content) => ({
      path: content.path,
      ...(content.oldText !== undefined && content.oldText !== null
        ? { oldText: content.oldText }
        : {}),
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
    ...(update.kind !== undefined && update.kind !== null
      ? { toolKind: update.kind }
      : {}),
    ...(update.title !== undefined && update.title !== null
      ? { title: update.title }
      : {}),
    ...(update.status !== undefined && update.status !== null
      ? { status: update.status }
      : {}),
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
            ...(location.line !== undefined && location.line !== null
              ? { line: location.line }
              : {}),
          })),
        }
      : {}),
    ...(diffs.length ? { diffs } : {}),
    ...(text ? { output: text } : {}),
    ...(typeof terminalOutput === "string" ? { terminalOutput } : {}),
    toolCallId: update.toolCallId,
  };
};

const sessionPreview = (
  meta: Record<string, unknown> | null | undefined
): { preview?: string; previewRole?: "user" | "assistant" } => {
  const value = meta?.magPiAcp;
  if (!value || typeof value !== "object") {
    return {};
  }
  const { preview, previewRole } = value as Record<string, unknown>;
  return typeof preview === "string" &&
    preview.length <= 160 &&
    (previewRole === "user" || previewRole === "assistant")
    ? { preview, previewRole }
    : {};
};

const visibleMessageText = (
  update: SessionUpdate["sessionUpdate"],
  text: string
): string =>
  update === "user_message_chunk"
    ? text.split("\n[Embedded Context] ", 1)[0]
    : text;

const allPlanEntriesCompleted = (entries: { status: string }[]): boolean =>
  entries.length > 0 && entries.every((entry) => entry.status === "completed");

// oxlint-disable-next-line complexity -- ACP session updates are a protocol union
export const translateSessionUpdate = (
  update: SessionUpdate
): AgentUpdate | undefined => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text" && update.content.type !== "image") {
        return undefined;
      }
      let kind: "user" | "assistant" | "thought" = "thought";
      if (update.sessionUpdate === "user_message_chunk") {
        kind = "user";
      } else if (update.sessionUpdate === "agent_message_chunk") {
        kind = "assistant";
      }
      return {
        ...(update.messageId ? { messageId: update.messageId } : {}),
        kind,
        ...(update.content.type === "text"
          ? {
              text: visibleMessageText(
                update.sessionUpdate,
                update.content.text
              ),
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
        allCompleted: allPlanEntriesCompleted(update.entries),
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
    case "usage_update": {
      return { type: "usage", usage: { size: update.size, used: update.used } };
    }
    case "available_commands_update": {
      return {
        commands: update.availableCommands.map((command) => ({
          description: command.description,
          ...(typeof command.input?.hint === "string"
            ? { inputHint: command.input.hint }
            : {}),
          name: command.name,
        })),
        type: "commands",
      };
    }
    case "config_option_update": {
      return { options: configOptions(update.configOptions), type: "config" };
    }
    case "session_info_update": {
      return {
        ...(update.title !== undefined && update.title !== null
          ? { title: update.title }
          : {}),
        ...(update.updatedAt !== undefined && update.updatedAt !== null
          ? { updatedAt: update.updatedAt }
          : {}),
        type: "sessionInfo",
      };
    }
    default: {
      return undefined;
    }
  }
};

const stringArguments = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((argument) => typeof argument === "string");

const stringEnvironment = (value: unknown): value is Record<string, string> =>
  Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );

const standardTerminalAuthentication = (
  method: unknown,
  launch: AgentLaunch
): TerminalAuthentication | undefined => {
  if (!method || typeof method !== "object") {
    return undefined;
  }
  const { args, env: rawEnv, name, type } = method as Record<string, unknown>;
  if (
    type !== "terminal" ||
    (args !== undefined && !stringArguments(args)) ||
    (rawEnv !== undefined && !stringEnvironment(rawEnv))
  ) {
    return undefined;
  }
  const launchArgs = args === undefined ? [] : (args as string[]);
  const env = {
    ...launch.env,
    ...(rawEnv === undefined ? {} : (rawEnv as Record<string, string>)),
  };
  return {
    args: [...launch.args, ...launchArgs],
    command: launch.command,
    ...(Object.keys(env).length ? { env } : {}),
    label: typeof name === "string" ? name : "Authenticate",
  };
};

const legacyTerminalAuthentication = (
  method: unknown
): TerminalAuthentication | undefined => {
  if (!method || typeof method !== "object") {
    return undefined;
  }
  const { _meta: rawMeta, name } = method as Record<string, unknown>;
  const meta = rawMeta as Record<string, unknown> | null | undefined;
  const privateLaunch = meta?.["terminal-auth"] as
    | Record<string, unknown>
    | null
    | undefined;
  const {
    args,
    command,
    env: rawEnv,
    label: privateLabel,
  } = privateLaunch ?? {};
  if (typeof command !== "string" || !stringArguments(args)) {
    return undefined;
  }
  const env = stringEnvironment(rawEnv) ? rawEnv : undefined;
  let label = typeof name === "string" ? name : "Authenticate";
  if (typeof privateLabel === "string") {
    label = privateLabel;
  }
  return {
    args,
    command,
    ...(env && Object.keys(env).length ? { env } : {}),
    label,
  };
};

export const terminalAuthentication = (
  error: unknown,
  launch?: AgentLaunch
): TerminalAuthentication | undefined => {
  const data = (error as { data?: unknown } | null)?.data as
    | { authMethods?: unknown }
    | null
    | undefined;
  if (!Array.isArray(data?.authMethods)) {
    return undefined;
  }
  if (launch) {
    for (const method of data.authMethods) {
      const authentication = standardTerminalAuthentication(method, launch);
      if (authentication) {
        return authentication;
      }
    }
  }
  for (const method of data.authMethods) {
    const authentication = legacyTerminalAuthentication(method);
    if (authentication) {
      return authentication;
    }
  }
  return undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const toAgentError = (error: unknown, launch?: AgentLaunch): AgentError =>
  error instanceof Error && "authentication" in error
    ? (error as AgentError)
    : Object.assign(new Error(errorMessage(error)), {
        authentication: terminalAuthentication(error, launch),
      });

class AcpConnection implements AgentConnection {
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientSideConnection;
  private cwd?: string;
  private starting?: Promise<void>;
  private disposed = false;
  private readonly launch: AgentLaunch;
  private readonly handlers: AgentHandlers;
  private readonly log: (message: string) => void;

  constructor(
    launch: AgentLaunch,
    handlers: AgentHandlers,
    log: (message: string) => void
  ) {
    this.launch = launch;
    this.handlers = handlers;
    this.log = log;
  }

  create(cwd: string) {
    this.cwd = cwd;
    return this.call(async () => {
      await this.start();
      const session = await this.requireConnection().newSession({
        cwd,
        mcpServers: [],
      });
      return {
        configOptions: configOptions(session.configOptions),
        sessionId: session.sessionId,
      };
    });
  }

  fork(sessionId: string, cwd: string, messageId: string) {
    return this.call(async () => {
      await this.start();
      const session = await this.requireConnection().unstable_forkSession({
        _meta: { "magpi-acp/client-message-id": messageId },
        cwd,
        mcpServers: [],
        sessionId,
      });
      return {
        configOptions: configOptions(session.configOptions),
        sessionId: session.sessionId,
      };
    });
  }

  history(cwd: string) {
    return this.call(async () => {
      await this.start();
      const sessions = [];
      let cursor: string | undefined;
      do {
        // Pagination is cursor-dependent and must remain sequential.
        // oxlint-disable-next-line no-await-in-loop
        const page = await this.requireConnection().listSessions({
          cwd,
          ...(cursor ? { cursor } : {}),
        });
        sessions.push(
          ...page.sessions
            .filter((session) => session.cwd === cwd)
            .map((session) => ({
              cwd: session.cwd,
              ...sessionPreview(session._meta),
              sessionId: session.sessionId,
              ...(session.title ? { title: session.title } : {}),
              ...(session.updatedAt &&
              Number.isFinite(Date.parse(session.updatedAt))
                ? { updatedAt: session.updatedAt }
                : {}),
            }))
        );
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return sessions;
    });
  }

  load(sessionId: string, cwd: string) {
    this.cwd = cwd;
    return this.call(async () => {
      await this.start();
      const session = await this.requireConnection().loadSession({
        cwd,
        mcpServers: [],
        sessionId,
      });
      return { configOptions: configOptions(session.configOptions), sessionId };
    });
  }

  prompt(
    sessionId: string,
    text: string,
    messageId: string,
    images: PromptImage[]
  ) {
    return this.call(async () => {
      await this.start();
      const response = await this.requireConnection().prompt({
        _meta: { "magpi-acp/client-message-id": messageId },
        prompt: await promptContent(this.cwd, text, images),
        sessionId,
      });
      return {
        stopReason:
          response.stopReason === "cancelled" ? "cancelled" : "completed",
      } as const;
    });
  }

  cancel(sessionId: string): Promise<void> {
    return this.call(async () => {
      await this.start();
      await this.requireConnection().cancel({ sessionId });
    });
  }

  rollback(sessionId: string, messageId: string): Promise<void> {
    return this.call(async () => {
      await this.start();
      await this.requireConnection().extMethod("_magpi-acp/session/rewind", {
        clientMessageId: messageId,
        sessionId,
      });
    });
  }

  setConfig(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<void> {
    return this.call(async () => {
      await this.start();
      await this.requireConnection().setSessionConfigOption(
        typeof value === "boolean"
          ? { configId, sessionId, type: "boolean", value }
          : { configId, sessionId, value }
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    this.connection = undefined;
    this.starting = undefined;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw toAgentError(error, this.launch);
    }
  }

  private async start(): Promise<void> {
    if (this.connection) {
      return;
    }
    this.disposed = false;
    this.starting ??= this.startInternal();
    try {
      await this.starting;
    } catch (error) {
      this.starting = undefined;
      this.dispose();
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.launch.command, this.launch.args, {
      env: { ...process.env, ...this.launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        this.log(message);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.connection = undefined;
      this.starting = undefined;
      if (!this.disposed) {
        this.handlers.error(
          toAgentError(
            new Error(
              `MagPi ACP exited${code === null ? ` (${signal ?? "unknown"})` : ` (${code})`}`
            ),
            this.launch
          )
        );
      }
    });

    const output = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (!child.stdin.writable) {
          throw new Error("MagPi ACP input closed");
        }
        if (!child.stdin.write(Buffer.from(chunk))) {
          await once(child.stdin, "drain");
        }
      },
    });
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout.on("data", (chunk: Buffer | string) => {
          controller.enqueue(new Uint8Array(Buffer.from(chunk)));
        });
        child.stdout.on("end", () => controller.close());
        child.stdout.on("error", (error) => controller.error(error));
      },
    });
    const client: Client = {
      createElicitation: async (request) => {
        if (!CreateElicitationRequestGuard.isForm(request)) {
          return { action: "decline" };
        }
        let translated: AgentElicitationRequest;
        try {
          translated = elicitationRequest(request);
        } catch {
          return { action: "decline" };
        }
        const response = await this.handlers.elicitation(translated);
        return elicitationResponse(request, response);
      },
      requestPermission: async (request) => {
        const response = await this.handlers.permission(
          permissionRequest(request)
        );
        return permissionResponse(response);
      },
      sessionUpdate: ({ update }) => {
        const translated = translateSessionUpdate(update);
        if (translated) {
          this.handlers.update(translated);
        }
        return Promise.resolve();
      },
    };
    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(output, input)
    );
    this.connection = connection;

    const initialized = connection.initialize({
      clientCapabilities: {
        _meta: { "terminal-auth": true },
        auth: { terminal: true },
        elicitation: { form: {} },
        plan: {},
      },
      clientInfo: { name: "mischief", title: "Mischief", version: "0.1.0" },
      protocolVersion: 1,
    });
    const childError = async (): Promise<never> => {
      const [error] = await once(child, "error");
      throw error;
    };
    await Promise.race([initialized, childError()]);
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("MagPi ACP is not connected");
    }
    return this.connection;
  }
}

export const acpConnectionFactory =
  (
    launch: AgentLaunch,
    log: (message: string) => void
  ): AgentConnectionFactory =>
  (handlers) =>
    new AcpConnection(launch, handlers, log);
