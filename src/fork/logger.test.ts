/**
 * FORK 2026-05-12 — tests for the fork-side structured logger.
 *
 * Test target: src/fork/logger.ts
 * Bible anchor: design-principles.md #9 (observability is a design property),
 * #10 (one correlation ID).
 */

import { describe, expect, it } from "vitest";
import { createLogger, logOnce, type LogLevel } from "./logger.js";

function captureLogger(opts?: { minLevel?: LogLevel }) {
  const lines: Array<{ level: LogLevel; line: string }> = [];
  const logger = createLogger({
    service: "test-service",
    minLevel: opts?.minLevel,
    out: (line, level) => lines.push({ level, line }),
  });
  return { logger, lines };
}

describe("createLogger", () => {
  it("emits JSON-line output with all required fields", () => {
    const { logger, lines } = captureLogger();
    const scoped = logger.withCorrelationId("test-corr-id");
    scoped.info("probe.called", { probe: "stuckSessions", thresholdMs: 60_000 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!.line);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.level).toBe("info");
    expect(parsed.service).toBe("test-service");
    expect(parsed.event).toBe("probe.called");
    expect(parsed.correlationId).toBe("test-corr-id");
    expect(parsed.probe).toBe("stuckSessions");
    expect(parsed.thresholdMs).toBe(60_000);
  });

  it("uses 'system' as correlationId when no scope is set", () => {
    const { logger, lines } = captureLogger();
    logger.info("boot.started");
    const parsed = JSON.parse(lines[0]!.line);
    expect(parsed.correlationId).toBe("system");
  });

  it("filters by minLevel", () => {
    const { logger, lines } = captureLogger({ minLevel: "warn" });
    logger.info("filtered.info");
    logger.warn("kept.warn");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.line).event).toBe("kept.warn");
  });

  it("warn and error go to the error stream (level discriminator)", () => {
    const { logger, lines } = captureLogger();
    logger.info("on.stdout");
    logger.warn("on.stderr");
    logger.error("also.on.stderr");
    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("merges staticFields into every record", () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "x",
      staticFields: { version: "1.2.3", pid: 1234 },
      out: (line) => lines.push(line),
    });
    logger.info("x.event", { specific: "value" });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.pid).toBe(1234);
    expect(parsed.specific).toBe("value");
  });

  it("withCorrelationId yields an independent scoped logger", () => {
    const { logger, lines } = captureLogger();
    const a = logger.withCorrelationId("id-a");
    const b = logger.withCorrelationId("id-b");
    a.info("from.a");
    b.info("from.b");
    expect(JSON.parse(lines[0]!.line).correlationId).toBe("id-a");
    expect(JSON.parse(lines[1]!.line).correlationId).toBe("id-b");
  });

  it("does not throw if fields is undefined", () => {
    const { logger } = captureLogger();
    expect(() => logger.info("no.fields")).not.toThrow();
  });
});

describe("logOnce", () => {
  it("emits a single record without throwing", () => {
    expect(() =>
      logOnce({
        service: "test",
        level: "info",
        event: "smoke",
        fields: { ok: true },
        correlationId: "fixed-corr",
      }),
    ).not.toThrow();
  });
});
