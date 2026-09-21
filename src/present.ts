export const isDefined = <Value>(
  value: Value | null | undefined
): value is Value => value !== undefined && value !== null;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isNonEmpty = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

export const isNonZero = (value: number | null | undefined): value is number =>
  value !== undefined && value !== null && value !== 0;
