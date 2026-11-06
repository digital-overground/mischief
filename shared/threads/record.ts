import path from "node:path";

import agentConfig from "../agents/config.json";

export type AgentId = keyof typeof agentConfig;
export type ThreadStatus = "idle" | "running" | "waiting" | "error";

export interface ThreadData {
  agentId?: AgentId;
  createdAt: string;
  error?: string;
  id: string;
  manualName?: boolean;
  name: string;
  retryHasImages?: boolean;
  retryText?: string;
  sessionId?: string;
  status: ThreadStatus;
  unread?: boolean;
  updatedAt: string;
  usage?: { used: number; size: number };
  workspace: string;
}

export interface ThreadRecord extends ThreadData {
  version: 1;
  writtenAt: number;
}

export const THREAD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isAgentId = (value: unknown): value is AgentId =>
  typeof value === "string" && Object.hasOwn(agentConfig, value);
const isBoundedString = (
  value: unknown,
  maximum = 1_000_000
): value is string => typeof value === "string" && value.length <= maximum;
const isTimestamp = (value: unknown): value is string =>
  isBoundedString(value, 100) &&
  value.length > 0 &&
  Number.isFinite(Date.parse(value));
const isAbsolutePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 32_768 &&
  !/\p{Cc}/u.test(value) &&
  path.isAbsolute(value);
const isStatus = (value: unknown): value is ThreadStatus =>
  value === "idle" ||
  value === "running" ||
  value === "waiting" ||
  value === "error";
const isUsage = (value: unknown): value is NonNullable<ThreadData["usage"]> =>
  isRecord(value) &&
  typeof value.used === "number" &&
  Number.isFinite(value.used) &&
  value.used >= 0 &&
  typeof value.size === "number" &&
  Number.isFinite(value.size) &&
  value.size >= 0;

// oxlint-disable-next-line complexity -- validates every durable Thread field.
export const isThreadData = (value: unknown): value is ThreadData =>
  isRecord(value) &&
  typeof value.id === "string" &&
  THREAD_UUID_PATTERN.test(value.id) &&
  (value.agentId === undefined || isAgentId(value.agentId)) &&
  isAbsolutePath(value.workspace) &&
  (value.sessionId === undefined ||
    (isBoundedString(value.sessionId, 32_768) && value.sessionId.length > 0)) &&
  isBoundedString(value.name, 200) &&
  value.name.length > 0 &&
  !/[\r\n]/u.test(value.name) &&
  isTimestamp(value.createdAt) &&
  isTimestamp(value.updatedAt) &&
  isStatus(value.status) &&
  (value.error === undefined || isBoundedString(value.error)) &&
  (value.retryText === undefined || isBoundedString(value.retryText)) &&
  (value.retryHasImages === undefined ||
    typeof value.retryHasImages === "boolean") &&
  (value.manualName === undefined || typeof value.manualName === "boolean") &&
  (value.unread === undefined || typeof value.unread === "boolean") &&
  (value.usage === undefined || isUsage(value.usage));

export const copyThreadData = (value: ThreadData): ThreadData => ({
  ...(value.agentId === undefined ? {} : { agentId: value.agentId }),
  createdAt: value.createdAt,
  ...(value.error === undefined ? {} : { error: value.error }),
  id: value.id,
  ...(value.manualName === undefined ? {} : { manualName: value.manualName }),
  name: value.name,
  ...(value.retryHasImages === undefined
    ? {}
    : { retryHasImages: value.retryHasImages }),
  ...(value.retryText === undefined ? {} : { retryText: value.retryText }),
  ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  status: value.status,
  ...(value.unread === undefined ? {} : { unread: value.unread }),
  updatedAt: value.updatedAt,
  ...(value.usage === undefined ? {} : { usage: { ...value.usage } }),
  workspace: value.workspace,
});

export const parseThreadRecord = (source: string): ThreadRecord => {
  const value: unknown = JSON.parse(source);
  if (
    !isThreadData(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("writtenAt" in value) ||
    !Number.isSafeInteger(value.writtenAt) ||
    Number(value.writtenAt) < 0
  ) {
    throw new Error("Invalid Thread record");
  }
  return {
    ...copyThreadData(value),
    version: 1,
    writtenAt: Number(value.writtenAt),
  };
};
