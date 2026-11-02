import config from "./config.json";

export const AGENTS = config;
export type AgentId = keyof typeof AGENTS;
export const LEGACY_THREAD_AGENT: AgentId = "magpi-acp";
export const isAgentId = (id: unknown): id is AgentId =>
  typeof id === "string" && Object.hasOwn(AGENTS, id);
export const AGENT_IDS: AgentId[] = Object.keys(AGENTS).filter(isAgentId);

const parseVersion = (version: string) => {
  const groups =
    /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u.exec(
      version
    )?.groups;
  if (
    groups?.major === undefined ||
    groups.minor === undefined ||
    groups.patch === undefined
  ) {
    return null;
  }
  const prerelease = groups.prerelease?.split(".");
  if (
    prerelease?.some(
      (part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")
    ) ??
    false
  ) {
    return null;
  }
  return {
    major: BigInt(groups.major),
    minor: BigInt(groups.minor),
    patch: BigInt(groups.patch),
    prerelease,
  };
};

// The npm lookup and install target are fixed here, never taken from an Agent or the webview.
export const latestAgentVersion = async (
  id: AgentId,
  npmView: (spec: string) => Promise<string>
): Promise<string> => {
  const version = await npmView(`${AGENTS[id].package}@latest`);
  if (parseVersion(version) === null) {
    throw new Error(`Invalid ${AGENTS[id].name} release version`);
  }
  return version;
};

// npm's stable `latest` tag is authoritative; do not downgrade a local development version.
// oxlint-disable-next-line complexity -- numeric and prerelease SemVer parts have distinct ordering rules
export const compareVersions = (
  installed: string,
  latest: string
): -1 | 0 | 1 | undefined => {
  const a = parseVersion(installed);
  const b = parseVersion(latest);
  if (a === null || b === null) {
    return undefined;
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1;
    }
  }
  if (a.prerelease === undefined) {
    return b.prerelease === undefined ? 0 : 1;
  }
  if (b.prerelease === undefined) {
    return -1;
  }
  for (
    let index = 0;
    index < Math.max(a.prerelease.length, b.prerelease.length);
    index += 1
  ) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    if (left === right) {
      continue;
    }
    const numericLeft = /^\d+$/u.test(left);
    const numericRight = /^\d+$/u.test(right);
    if (numericLeft && numericRight) {
      return BigInt(left) < BigInt(right) ? -1 : 1;
    }
    if (numericLeft !== numericRight) {
      return numericLeft ? -1 : 1;
    }
    return left < right ? -1 : 1;
  }
  return 0;
};
