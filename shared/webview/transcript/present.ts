export const isDefined = <T>(value: T | undefined): value is T =>
  value !== undefined;
export const isNonEmpty = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value.length > 0;
export const isNonZero = (value: number | undefined): value is number =>
  value !== undefined && value !== 0;
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
