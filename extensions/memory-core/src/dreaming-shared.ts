export { asNullableRecord as asRecord } from "openclaw/plugin-sdk/text-runtime";

export function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
