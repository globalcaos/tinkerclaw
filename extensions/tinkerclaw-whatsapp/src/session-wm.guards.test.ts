import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  checkWhatsmeowBinaryOverride,
  createWmClient,
  elfMachineMismatch,
  guardWmChildStreams,
} from "./session-wm.js";

// FORK 2026-10-19 (JarvisPi EPIPE crash loop): an x86-64 whatsmeow override on the arm64 Pi
// exited at once, and the next write to its stdin killed the gateway with an uncaught EPIPE, 18
// times. These tests pin both cures in session-wm.ts: the CPU refusal and the stdio guards.

// The optional Go addon, replaced by a fake shaped like its dist/index.js (see createWmClient
// below). Hoisted so the vi.mock factory can hand it out.
const whatsmeowLibrary = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@whatsmeow-node/whatsmeow-node", () => whatsmeowLibrary);

// Byte for byte the first 20 bytes of the Linux binaries @whatsmeow-node ships (read with
// `od -t x1 -N 20`): ELF magic, ELFCLASS64, little-endian, EV_CURRENT, ET_EXEC, e_machine.
function elfHeader(machine: number): Uint8Array {
  const header = new Uint8Array(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
  header[16] = 0x02;
  header[18] = machine & 0xff;
  header[19] = machine >> 8;
  return header;
}

const ELF_ARM64 = elfHeader(0xb7);
const ELF_X86_64 = elfHeader(0x3e);

const tmpRoot = mkdtempSync(path.join(tmpdir(), "wm-guards-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("elfMachineMismatch", () => {
  it("flags an x86-64 binary on an arm64 host and names both CPUs and the fix", () => {
    const reason = elfMachineMismatch(ELF_X86_64, "arm64");
    expect(reason).toContain("built for x86-64 but this host is arm64");
    expect(reason).toContain("scripts/build-whatsmeow-node.sh");
    expect(reason).toContain("GOARCH=arm64");
  });

  it("flags an arm64 binary on an x86-64 host", () => {
    const reason = elfMachineMismatch(ELF_ARM64, "x64");
    expect(reason).toContain("built for arm64 but this host is x86-64");
    expect(reason).toContain("GOARCH=amd64");
  });

  it("returns null when the binary matches the host", () => {
    expect(elfMachineMismatch(ELF_ARM64, "arm64")).toBeNull();
    expect(elfMachineMismatch(ELF_X86_64, "x64")).toBeNull();
  });

  it("accepts the 32-bit sibling of the host's CPU family", () => {
    expect(elfMachineMismatch(elfHeader(0x28), "arm64")).toBeNull();
    expect(elfMachineMismatch(elfHeader(0x03), "x64")).toBeNull();
    expect(elfMachineMismatch(ELF_ARM64, "arm")).toBeNull();
  });

  it("names a machine it has no label for by its number", () => {
    expect(elfMachineMismatch(elfHeader(0xf3), "arm64")).toContain("built for ELF machine 0xf3");
  });

  it("reads e_machine relative to the view, not to the underlying buffer", () => {
    const backing = new Uint8Array(64);
    backing.set(ELF_X86_64, 7);
    expect(elfMachineMismatch(backing.subarray(7, 27), "arm64")).toContain("built for x86-64");
  });

  it("returns null when it cannot tell", () => {
    const script = Buffer.from("#!/bin/sh\nexec /usr/bin/env true\n");
    const bigEndian = elfHeader(0x3e);
    bigEndian[5] = 0x02;
    expect(elfMachineMismatch(script, "arm64")).toBeNull(); // not ELF
    expect(elfMachineMismatch(ELF_X86_64.subarray(0, 19), "arm64")).toBeNull(); // truncated
    expect(elfMachineMismatch(bigEndian, "arm64")).toBeNull(); // big-endian
    expect(elfMachineMismatch(ELF_X86_64, "riscv64")).toBeNull(); // arch not in the table
    expect(elfMachineMismatch(ELF_X86_64, "constructor")).toBeNull(); // nor a prototype key
  });
});

describe("checkWhatsmeowBinaryOverride reads the binary's CPU", () => {
  const hostIsArm = process.arch === "arm64" || process.arch === "arm";
  const hostIsX86 = process.arch === "x64" || process.arch === "ia32";
  const nativeHeader = hostIsArm ? ELF_ARM64 : ELF_X86_64;
  const foreignHeader = hostIsArm ? ELF_X86_64 : ELF_ARM64;

  function writeBinary(name: string, bytes: Uint8Array, mode: number): string {
    const file = path.join(tmpRoot, name);
    writeFileSync(file, bytes);
    chmodSync(file, mode);
    return file;
  }

  it.runIf(hostIsArm || hostIsX86)("refuses the other CPU family and accepts this one", () => {
    const foreign = writeBinary("foreign", foreignHeader, 0o755);
    expect(checkWhatsmeowBinaryOverride(foreign)).toMatch(
      /^file is built for .+ but this host is /,
    );
    const native = writeBinary("native", nativeHeader, 0o755);
    expect(checkWhatsmeowBinaryOverride(native)).toBeNull();
  });

  // Execute-only: open() fails with EACCES for a non-root owner. Root reads it anyway, so skip.
  it.runIf((hostIsArm || hostIsX86) && process.getuid?.() !== 0)(
    "does not refuse a binary whose header it cannot read",
    () => {
      const unreadable = writeBinary("exec-only", foreignHeader, 0o111);
      expect(checkWhatsmeowBinaryOverride(unreadable)).toBeNull();
    },
  );
});

describe("guardWmChildStreams", () => {
  it("baseline: an unguarded stdin 'error' throws out of emit()", () => {
    const stdin = new EventEmitter();
    expect(() => stdin.emit("error", new Error("write EPIPE"))).toThrow(/EPIPE/);
  });

  it("swallows an EPIPE on the child's stdin and reports it once", () => {
    const child = {
      stdin: new EventEmitter(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    };
    const onError = vi.fn();
    expect(guardWmChildStreams(child, onError)).toBe(3);

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => child.stdin.emit("error", epipe)).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith("stdin", epipe);
  });

  it("guards only the streams that are there", () => {
    expect(guardWmChildStreams(null, vi.fn())).toBe(0);
    expect(guardWmChildStreams(undefined, vi.fn())).toBe(0);
    const partial = { stdin: null, stdout: {}, stderr: new EventEmitter() };
    expect(guardWmChildStreams(partial, vi.fn())).toBe(1);
  });

  it("swallows a throwing callback too", () => {
    const stdin = new EventEmitter();
    guardWmChildStreams({ stdin }, () => {
      throw new Error("handler bug");
    });
    expect(() => stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
  });
});

describe("createWmClient", () => {
  it("guards the Go child's stdin before init() writes to it", async () => {
    vi.stubEnv("OPENCLAW_WHATSMEOW_BINARY", "");
    const child = {
      stdin: new EventEmitter(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    };
    // Shaped like @whatsmeow-node's GoProcess: start() spawns once, then returns early.
    const goProcess = {
      proc: null as typeof child | null,
      start() {
        if (this.proc) {
          return;
        }
        this.proc = child;
      },
    };
    const client = Object.assign(new EventEmitter(), {
      _isStub: true, // keeps bindWmHistoryCapture from arming its backfill timers
      proc: goProcess,
      async init() {
        goProcess.start();
        // The library writes to stdin in this same tick and a dead child answers with EPIPE.
        // Without a listener already in place, this emit throws and init() rejects.
        child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        return {};
      },
    });
    whatsmeowLibrary.createClient.mockReturnValueOnce(client);

    const storePath = path.join(tmpRoot, "store-guarded", "whatsmeow.db");
    await expect(createWmClient({ storePath })).resolves.toBe(client);
  });

  it("still initialises when the library internals are not where it expects them", async () => {
    vi.stubEnv("OPENCLAW_WHATSMEOW_BINARY", "");
    const init = vi.fn(async () => ({}));
    const client = Object.assign(new EventEmitter(), { _isStub: true, init });
    whatsmeowLibrary.createClient.mockReturnValueOnce(client);

    const storePath = path.join(tmpRoot, "store-bare", "whatsmeow.db");
    await expect(createWmClient({ storePath })).resolves.toBe(client);
    expect(init).toHaveBeenCalledOnce();
  });
});
