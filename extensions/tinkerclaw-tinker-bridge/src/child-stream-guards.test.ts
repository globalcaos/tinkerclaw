import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { guardChildStreams } from "./child-stream-guards.js";

// The crash class this guards against: an EventEmitter 'error' with NO listener throws out of
// emit() — in a real child stdin pipe that is the uncaught `write EPIPE` that killed the gateway
// three times on 2026-09-14. The first test pins that baseline so the guard's value is measured,
// not assumed.

describe("guardChildStreams", () => {
  it("baseline: an unguarded stream 'error' throws out of emit()", () => {
    const stdin = new EventEmitter();
    expect(() => stdin.emit("error", new Error("write EPIPE"))).toThrow(/EPIPE/);
  });

  it("forwards stdin/stdout/stderr errors to the callback and never throws", () => {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const onError = vi.fn();

    const guarded = guardChildStreams({ stdin, stdout, stderr }, onError);
    expect(guarded).toEqual(["stdin", "stdout", "stderr"]);

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => stdin.emit("error", epipe)).not.toThrow();
    expect(() => stdout.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(() => stderr.emit("error", "not-an-error")).not.toThrow();

    expect(onError).toHaveBeenCalledTimes(3);
    expect(onError.mock.calls[0][0]).toBe("stdin");
    expect(onError.mock.calls[0][1]).toBe(epipe);
    expect(onError.mock.calls[1][0]).toBe("stdout");
    // Non-Error payloads are normalised so the callback can always read `.message`.
    expect(onError.mock.calls[2][0]).toBe("stderr");
    expect(onError.mock.calls[2][1]).toBeInstanceOf(Error);
    expect((onError.mock.calls[2][1] as Error).message).toBe("not-an-error");
  });

  it("skips absent streams (stdio: 'ignore' / inherit) instead of throwing", () => {
    const stdout = new EventEmitter();
    const onError = vi.fn();
    const guarded = guardChildStreams({ stdin: null, stdout, stderr: undefined }, onError);
    expect(guarded).toEqual(["stdout"]);
    expect(() => stdout.emit("error", new Error("x"))).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("a throwing callback is swallowed — the handler can never become the next crash", () => {
    const stdin = new EventEmitter();
    guardChildStreams({ stdin }, () => {
      throw new Error("handler bug");
    });
    expect(() => stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
  });
});
