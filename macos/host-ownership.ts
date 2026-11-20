import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";

const code = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

const isDead = (pid: number): boolean => {
  try {
    // shortcut: PID reuse can block recovery; require manual inspection rather than stealing a live owner.
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return code(error) === "ESRCH";
  }
};

const staleSocket = async (socketPath: string): Promise<boolean> => {
  const socket = connect(socketPath);
  socket.setTimeout(1000, () => {
    socket.destroy(new Error("Host endpoint probe timed out"));
  });
  try {
    await once(socket, "connect");
    return false;
  } catch (error) {
    if (code(error) === "ECONNREFUSED" || code(error) === "ENOENT") {
      return true;
    }
    throw error;
  } finally {
    socket.destroy();
  }
};

const removeStaleEndpoint = async (socketPath: string): Promise<void> => {
  let endpoint;
  try {
    endpoint = await lstat(socketPath);
  } catch (error) {
    if (code(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!endpoint.isSocket() || !(await staleSocket(socketPath))) {
    throw new Error("Host endpoint is occupied or cannot be verified");
  }
  const current = await lstat(socketPath);
  if (current.dev !== endpoint.dev || current.ino !== endpoint.ino) {
    throw new Error("Host endpoint changed during recovery");
  }
  await rm(socketPath);
};

/** Exclusively owns the Host's private profile before it can serve clients. */
export const acquireProfileOwnership = async (
  profilePath: string
): Promise<() => Promise<void>> => {
  await mkdir(profilePath, { mode: 0o700, recursive: true });
  const directory = await lstat(profilePath);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode % 0o100 !== 0
  ) {
    throw new Error("Host profile directory must be private to this user");
  }
  const lockPath = path.join(profilePath, "profile.lock");
  const recoveryPath = `${lockPath}.recovering`;
  const content = JSON.stringify({ nonce: randomUUID(), pid: process.pid });
  const recover = async (): Promise<void> => {
    // shortcut: a crash during recovery leaves this guard; require manual inspection before removal.
    const recovery = await open(recoveryPath, "wx", 0o600);
    await recovery.close();
    try {
      const existing = await readFile(lockPath, "utf-8");
      if (existing.length > 256) {
        throw new Error("Host profile ownership record is invalid");
      }
      const owner: unknown = JSON.parse(existing);
      if (
        typeof owner !== "object" ||
        owner === null ||
        !("pid" in owner) ||
        typeof owner.pid !== "number" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        !isDead(owner.pid)
      ) {
        throw new Error("Host profile ownership is held or cannot be verified");
      }
      if ((await readFile(lockPath, "utf-8")) !== existing) {
        throw new Error("Host profile ownership changed during recovery");
      }
      await rm(lockPath);
      await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
    } finally {
      await rm(recoveryPath);
    }
  };
  try {
    await writeFile(lockPath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (code(error) !== "EEXIST") {
      throw error;
    }
    await recover();
  }
  return async () => {
    if ((await readFile(lockPath, "utf-8")) === content) {
      await rm(lockPath);
    }
  };
};

/** The Host endpoint lock is acquired before a daemon can publish its local endpoint. */
export const acquireHostOwnership = async (
  socketPath: string
): Promise<() => Promise<void>> => {
  const lockPath = path.join(path.dirname(socketPath), "host.lock");
  const recoveryPath = `${lockPath}.recovering`;
  const content = JSON.stringify({ nonce: randomUUID(), pid: process.pid });
  const staged = `${lockPath}.${randomUUID()}.staged`;
  const publish = async (): Promise<boolean> => {
    try {
      await link(staged, lockPath);
      return true;
    } catch (error) {
      if (code(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
  };
  await writeFile(staged, content, { flag: "wx", mode: 0o600 });
  try {
    if (!(await publish())) {
      // shortcut: a crash during recovery leaves this guard; require manual inspection before removal.
      const recovery = await open(recoveryPath, "wx", 0o600);
      await recovery.close();
      try {
        const existing = await readFile(lockPath, "utf-8");
        if (existing.length > 256) {
          throw new Error("Host ownership record is invalid");
        }
        const owner: unknown = JSON.parse(existing);
        if (
          typeof owner !== "object" ||
          owner === null ||
          !("pid" in owner) ||
          typeof owner.pid !== "number" ||
          !Number.isSafeInteger(owner.pid) ||
          owner.pid <= 0 ||
          !isDead(owner.pid) ||
          !(await staleSocket(socketPath))
        ) {
          throw new Error("Host ownership is held or cannot be verified");
        }
        if ((await readFile(lockPath, "utf-8")) !== existing) {
          throw new Error("Host ownership changed during recovery");
        }
        await rm(lockPath);
        if (!(await publish())) {
          throw new Error("Another Host acquired ownership");
        }
      } finally {
        await rm(recoveryPath);
      }
    }
  } finally {
    await rm(staged);
  }
  try {
    await chmod(lockPath, 0o600);
    await removeStaleEndpoint(socketPath);
  } catch (error) {
    if ((await readFile(lockPath, "utf-8")) === content) {
      await rm(lockPath);
    }
    throw error;
  }
  return async () => {
    if ((await readFile(lockPath, "utf-8")) === content) {
      await rm(lockPath);
    }
  };
};
