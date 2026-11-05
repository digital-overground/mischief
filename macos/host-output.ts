import type { Socket } from "node:net";

// shortcut: A snapshot over 8 MiB cannot be delivered; paginate if real libraries reach this size.
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

export const writeClient = (client: Socket, line: string): void => {
  if (client.destroyed) {
    return;
  }
  if (client.writableLength + Buffer.byteLength(line) > MAX_PENDING_BYTES) {
    client.destroy();
    return;
  }
  client.write(line);
};
