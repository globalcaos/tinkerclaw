import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyUnhandledRejection,
  CONTAINED_REJECTION_CRASH_LOOP_MAX,
  CONTAINED_REJECTION_CRASH_LOOP_WINDOW_MS,
  isAbortError,
  isBenignUncaughtExceptionError,
  isTransientNetworkError,
  isTransientSqliteError,
  isTransientUnhandledRejectionError,
  recordContainedUnhandledRejection,
  resetContainedUnhandledRejectionTrackerForTest,
} from "./unhandled-rejections.js";

describe("isAbortError", () => {
  it("returns true for error with name AbortError", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
  });

  it('returns true for error with "This operation was aborted" message', () => {
    const error = new Error("This operation was aborted");
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for undici-style AbortError", () => {
    // Node's undici throws errors with this exact message
    const error = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isAbortError(error)).toBe(true);
  });

  it("returns true for object with AbortError name", () => {
    expect(isAbortError({ name: "AbortError", message: "test" })).toBe(true);
  });

  it("returns false for regular errors", () => {
    expect(isAbortError(new Error("Something went wrong"))).toBe(false);
    expect(isAbortError(new TypeError("Cannot read property"))).toBe(false);
    expect(isAbortError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with similar but different messages", () => {
    expect(isAbortError(new Error("Operation aborted"))).toBe(false);
    expect(isAbortError(new Error("aborted"))).toBe(false);
    expect(isAbortError(new Error("Request was aborted"))).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-abort input %#",
    (value) => {
      expect(isAbortError(value)).toBe(false);
    },
  );
});

describe("isTransientNetworkError", () => {
  it("returns true for errors with transient network codes", () => {
    const codes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "ECONNABORTED",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
      "EPROTO",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "ERR_SSL_PROTOCOL_RETURNED_AN_ERROR",
    ];

    for (const code of codes) {
      const error = Object.assign(new Error("test"), { code });
      expect(isTransientNetworkError(error), `code: ${code}`).toBe(true);
    }
  });

  it('returns true for TypeError with "fetch failed" message', () => {
    const error = new TypeError("fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with network cause", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for fetch failed with unclassified cause", () => {
    const cause = Object.assign(new Error("unknown socket state"), { code: "UNKNOWN" });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for nested cause chain with network error", () => {
    const innerCause = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const outerCause = Object.assign(new Error("wrapper"), { cause: innerCause });
    const error = Object.assign(new TypeError("fetch failed"), { cause: outerCause });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for Slack request errors that wrap network codes in .original", () => {
    const error = Object.assign(new Error("A request error occurred: getaddrinfo EAI_AGAIN"), {
      code: "slack_webapi_request_error",
      original: {
        errno: -3001,
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
        hostname: "slack.com",
      },
    });
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for network codes nested in .data payloads", () => {
    const error = {
      code: "slack_webapi_request_error",
      message: "A request error occurred",
      data: {
        code: "EAI_AGAIN",
      },
    };
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for AggregateError containing network errors", () => {
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const error = new AggregateError([networkError], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for wrapped fetch-failed messages from integration clients", () => {
    const error = new Error("Failed to get gateway information from Discord: fetch failed");
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns true for wrapped Discord upstream-connect parse failures", () => {
    const error = new Error(
      `Failed to get gateway information from Discord: Unexpected token 'u', "upstream connect error or disconnect/reset before headers. reset reason: overflow" is not valid JSON`,
    );
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it("returns false for non-network fetch-failed wrappers from tools", () => {
    const error = new Error("Web fetch failed (404): Not Found");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns true for TLS/SSL transient message snippets", () => {
    expect(isTransientNetworkError(new Error("write EPROTO 00A8B0C9:error"))).toBe(true);
    expect(
      isTransientNetworkError(
        new Error("SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER while connecting"),
      ),
    ).toBe(true);
    expect(isTransientNetworkError(new Error("tlsv1 alert protocol version"))).toBe(true);
  });

  it("returns false for regular errors without network codes", () => {
    expect(isTransientNetworkError(new Error("Something went wrong"))).toBe(false);
    expect(isTransientNetworkError(new TypeError("Cannot read property"))).toBe(false);
    expect(isTransientNetworkError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("returns false for errors with non-network codes", () => {
    const error = Object.assign(new Error("test"), { code: "INVALID_CONFIG" });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for Slack request errors without network indicators", () => {
    const error = Object.assign(new Error("A request error occurred"), {
      code: "slack_webapi_request_error",
    });
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it("returns false for non-transient undici codes that only appear in message text", () => {
    const error = new Error("Request failed with UND_ERR_INVALID_ARG");
    expect(isTransientNetworkError(error)).toBe(false);
  });

  it.each([null, undefined, "string error", 42, { message: "plain object" }])(
    "returns false for non-network input %#",
    (value) => {
      expect(isTransientNetworkError(value)).toBe(false);
    },
  );

  it("returns false for AggregateError with only non-network errors", () => {
    const error = new AggregateError([new Error("regular error")], "Multiple errors");
    expect(isTransientNetworkError(error)).toBe(false);
  });
});

describe("isTransientSqliteError", () => {
  it("returns true for named transient SQLite codes", () => {
    const codes = ["SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR"];

    for (const code of codes) {
      const error = Object.assign(new Error("sqlite transient"), { code });
      expect(isTransientSqliteError(error), `code: ${code}`).toBe(true);
    }
  });

  it("returns true for node:sqlite transient errcodes", () => {
    const sqliteCases = [
      { errcode: 14, errstr: "unable to open database file" },
      { errcode: 5, errstr: "database is locked" },
      { errcode: 6, errstr: "database table is locked" },
      { errcode: 10, errstr: "disk I/O error" },
    ] as const;

    for (const { errcode, errstr } of sqliteCases) {
      const error = Object.assign(new Error(errstr), {
        code: "ERR_SQLITE_ERROR",
        errcode,
        errstr,
      });
      expect(isTransientSqliteError(error), `errcode: ${errcode}`).toBe(true);
    }
  });

  it("returns true for wrapped SQLite message strings", () => {
    const error = new Error("SQLITE_BUSY: database is locked");
    expect(isTransientSqliteError(error)).toBe(true);
  });

  it("returns false for non-transient SQLite failures", () => {
    const constraintError = Object.assign(new Error("UNIQUE constraint failed"), {
      code: "SQLITE_CONSTRAINT",
    });
    const genericSqliteError = Object.assign(new Error("constraint failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 19,
      errstr: "constraint failed",
    });

    expect(isTransientSqliteError(constraintError)).toBe(false);
    expect(isTransientSqliteError(genericSqliteError)).toBe(false);
  });

  it("returns false for matching errcodes without SQLite context", () => {
    const error = Object.assign(new Error("plain error"), {
      code: "ERR_OTHER",
      errcode: 14,
      errstr: "unable to open database file",
    });

    expect(isTransientSqliteError(error)).toBe(false);
  });

  it("returns false for SQLite-like snippets without SQLite context", () => {
    const error = new Error("database is locked");

    expect(isTransientSqliteError(error)).toBe(false);
  });
});

describe("classifyUnhandledRejection", () => {
  it("classifies OOM / worker codes as fatal (still exits)", () => {
    expect(
      classifyUnhandledRejection(Object.assign(new Error("oom"), { code: "ERR_OUT_OF_MEMORY" })),
    ).toBe("fatal");
  });

  it("classifies configuration errors as config (still exits)", () => {
    expect(
      classifyUnhandledRejection(Object.assign(new Error("bad"), { code: "INVALID_CONFIG" })),
    ).toBe("config");
  });

  it("classifies AbortError as abort (survives)", () => {
    const error = new Error("x");
    error.name = "AbortError";
    expect(classifyUnhandledRejection(error)).toBe("abort");
  });

  it("classifies transient network errors as transient (survives)", () => {
    expect(
      classifyUnhandledRejection(Object.assign(new Error("reset"), { code: "ECONNRESET" })),
    ).toBe("transient");
  });

  it("contains an unrecognized generic error (the inverted default — gateway must survive)", () => {
    expect(classifyUnhandledRejection(new Error("Something went wrong"))).toBe("contain");
  });

  it("contains a playwright-core CDP assertion error (the browser-relay crash class, 2026-06-08/09)", () => {
    // Reproduces the exact gateway-death signature: an Assertion error thrown
    // deep inside playwright-core's CDP transport, surfacing as an unhandled
    // rejection no try/catch of ours can reach. It must NOT kill the gateway.
    const assertErr = new Error("Assertion error");
    assertErr.stack =
      "Error: Assertion error\n" +
      "    at assert (/x/node_modules/playwright-core/lib/utils/isomorphic/assert.js:26:11)\n" +
      "    at CRSession._onMessage (/x/node_modules/playwright-core/lib/server/chromium/crConnection.js:129:31)";
    expect(classifyUnhandledRejection(assertErr)).toBe("contain");
  });
});

describe("recordContainedUnhandledRejection (crash-loop circuit breaker)", () => {
  beforeEach(() => {
    resetContainedUnhandledRejectionTrackerForTest();
  });

  it("does not trip below the threshold", () => {
    let tripped = false;
    for (let i = 0; i < CONTAINED_REJECTION_CRASH_LOOP_MAX - 1; i++) {
      tripped = recordContainedUnhandledRejection(1_000 + i);
    }
    expect(tripped).toBe(false);
  });

  it("trips at the threshold within the rolling window", () => {
    let tripped = false;
    for (let i = 0; i < CONTAINED_REJECTION_CRASH_LOOP_MAX; i++) {
      tripped = recordContainedUnhandledRejection(1_000 + i);
    }
    expect(tripped).toBe(true);
  });

  it("does not trip when rejections are spread beyond the window", () => {
    let tripped = false;
    for (let i = 0; i < CONTAINED_REJECTION_CRASH_LOOP_MAX + 5; i++) {
      tripped = recordContainedUnhandledRejection(
        i * (CONTAINED_REJECTION_CRASH_LOOP_WINDOW_MS + 1),
      );
    }
    expect(tripped).toBe(false);
  });
});

describe("isTransientUnhandledRejectionError", () => {
  it("keeps uncaught exception suppression scoped to broken pipes", () => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const sqlite = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const network = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const generic = new Error("boom");

    expect(isBenignUncaughtExceptionError(epipe)).toBe(true);
    expect(isBenignUncaughtExceptionError(sqlite)).toBe(false);
    expect(isBenignUncaughtExceptionError(network)).toBe(false);
    expect(isBenignUncaughtExceptionError(generic)).toBe(false);
  });
  it("returns true for transient SQLite errors", () => {
    const error = Object.assign(new Error("unable to open database file"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 14,
      errstr: "unable to open database file",
    });

    expect(isTransientUnhandledRejectionError(error)).toBe(true);
  });
});
