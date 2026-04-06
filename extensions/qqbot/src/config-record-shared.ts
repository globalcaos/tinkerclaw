import { asOptionalObjectRecord } from "openclaw/plugin-sdk/text-runtime";

export const asRecord = asOptionalObjectRecord;

export function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
