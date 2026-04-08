import os from "node:os";
import path from "node:path";
import {
  registerLogTransport,
  resetLogger,
  setLoggerOverride,
  type LogTransportRecord,
} from "../logger.js";

export function createWarnLogCapture(prefix: string) {
  const records: LogTransportRecord[] = [];
  setLoggerOverride({
    level: "warn",
    consoleLevel: "silent",
    file: path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}.log`),
  });
  const unregister = registerLogTransport((record) => {
    records.push(record);
  });
  return {
    findText(needle: string): string | undefined {
      return records
        .flatMap((record) => Object.values(record))
        .filter((value): value is string => typeof value === "string")
        .find((value) => value.includes(needle));
    },
    cleanup() {
      unregister();
      setLoggerOverride(null);
      resetLogger();
    },
  };
}
