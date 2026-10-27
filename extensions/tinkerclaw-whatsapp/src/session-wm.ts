/**
 * FORK: WhatsApp session module using whatsmeow-node.
 * Drop-in alternative to session.ts (Baileys).
 *
 * whatsmeow-node is an OPTIONAL Go-native addon. It may be absent on
 * machines without the Go toolchain (dev laptops, CI runners, Docker).
 * To keep the gateway bootable in that case, the package is loaded
 * LAZILY — only when createWmClient() is actually called. The top-level
 * type is declared structurally so tsc can still type-check without the
 * real module's types.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import { bindWmHistoryCapture } from "../../tinkerclaw-whatsapp/src/history/live-capture.js";

// FORK: structural type for WhatsmeowClient. Matches the subset of methods
// we actually call. The real module's type is imported dynamically below.
export type WhatsmeowClient = {
  // biome-ignore lint/suspicious/noExplicitAny: optional Go-native addon shape
  on(event: string, handler: (payload: any) => void): void;
  init(): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic
  [key: string]: any;
};

// Lazy holder for the createClient function from the optional module.
// biome-ignore lint/suspicious/noExplicitAny: optional module
let _createClient: ((opts: { store: string; binaryPath?: string }) => WhatsmeowClient) | null =
  null;
async function loadCreateClient(): Promise<
  (opts: { store: string; binaryPath?: string }) => WhatsmeowClient
> {
  if (_createClient) {
    return _createClient;
  }
  try {
    // biome-ignore lint/suspicious/noExplicitAny: optional module
    const mod = (await import("@whatsmeow-node/whatsmeow-node" as string)) as any;
    _createClient = mod.createClient;
    return _createClient!;
  } catch (err) {
    throw new Error(
      "whatsmeow-node is not installed. Install the optional Go addon with " +
        "`pnpm add @whatsmeow-node/whatsmeow-node` (requires Go toolchain). " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

const DEFAULT_STORE_PATH = "~/.openclaw/credentials/whatsapp/default/whatsmeow.db";

/**
 * FORK 2026-08-29: escape hatch for the whatsmeow Go binary.
 *
 * WhatsApp enforces a minimum client version and raised it on ~2026-07-29.
 * Every published @whatsmeow-node release (0.5.3 through 0.7.0) embeds the same
 * Go library, `whatsmeowVersion 0.0.0-20260305`, so the channel died and NO npm
 * upgrade could revive it: WhatsApp answered `getQRChannel` with
 * `qr:error / err-client-outdated` and refused to issue a pairing code at all.
 *
 * The cure is a binary rebuilt against current go.mau.fi/whatsmeow. It cannot
 * live in node_modules, because a deploy builds in a clean worktree and
 * `pnpm install` restores the stale one. Point this at a rebuilt binary
 * instead; unset, behaviour is exactly as before.
 *
 * This WILL recur the next time WhatsApp raises the floor. Rebuild with
 * scripts/build-whatsmeow-node.sh and the symptom is the same:
 * `err-client-outdated` on a FRESH store.
 */
const BINARY_PATH_ENV = "OPENCLAW_WHATSMEOW_BINARY";

function resolveWhatsmeowBinaryPath(): string | undefined {
  const raw = process.env[BINARY_PATH_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  const resolved = resolveUserPath(raw);
  const problem = checkWhatsmeowBinaryOverride(resolved);
  if (problem) {
    // Refuse rather than fall back: a silently ignored override would hide the
    // misconfiguration and run a different binary than the operator asked for.
    throw new Error(`${BINARY_PATH_ENV} rejected (${resolved}): ${problem}`);
  }
  return resolved;
}

/**
 * The override is spawned as a subprocess with the WhatsApp session store, so
 * only accept a binary the gateway user controls: an absolute path to a regular
 * executable file, owned by the current user (or root), and not writable by
 * group or others. It must also be built for this host's CPU (see
 * elfMachineMismatch). Returns a reason string when the path is not acceptable.
 */
export function checkWhatsmeowBinaryOverride(binaryPath: string): string | null {
  if (!path.isAbsolute(binaryPath)) {
    return "path must be absolute";
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(binaryPath);
  } catch {
    return "file does not exist";
  }
  if (!st.isFile()) {
    return "not a regular file";
  }
  if ((st.mode & 0o111) === 0) {
    return "file is not executable";
  }
  if ((st.mode & 0o022) !== 0) {
    return "file is writable by group or others";
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) {
    return "file is not owned by the gateway user or root";
  }
  // FORK 2026-10-19 (JarvisPi EPIPE crash loop): refuse a binary built for another CPU. An
  // x86-64 override copied from a laptop to the arm64 Pi passed every check above; glibc's
  // execvp then ran it through /bin/sh, the child exited 2, and the gateway died 18 times on
  // the EPIPE that followed. A header that cannot be read means "cannot tell", never a refusal.
  const head = readFileHead(binaryPath, ELF_HEADER_PROBE_BYTES);
  return head ? elfMachineMismatch(head, process.arch) : null;
}

// FORK 2026-10-19 (JarvisPi EPIPE crash loop): ELF header probe for checkWhatsmeowBinaryOverride.
const ELF_HEADER_PROBE_BYTES = 20; // e_machine sits at offset 18 in both ELF32 and ELF64
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const; // "\x7fELF"
const ELF_DATA_OFFSET = 5; // EI_DATA
const ELF_DATA_LITTLE_ENDIAN = 1; // ELFDATA2LSB
const ELF_MACHINE_OFFSET = 18; // e_machine, a uint16 in the file's byte order

const EM_386 = 0x03;
const EM_ARM = 0x28;
const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

const ELF_MACHINE_NAMES = new Map<number, string>([
  [EM_386, "x86 (32-bit)"],
  [EM_ARM, "arm (32-bit)"],
  [EM_X86_64, "x86-64"],
  [EM_AARCH64, "arm64"],
]);

type ElfHost = { name: string; goarch: string; machines: readonly number[] };

/**
 * The hosts the probe knows, keyed by Node's `process.arch`; other arches are not checked. Each
 * host also accepts its 32-bit sibling: a 64-bit kernel usually runs 32-bit binaries (the Pi 5
 * runs AArch32), and a 32-bit Node can sit on a 64-bit kernel. So a binary is refused only when
 * its machine is outside the host's family (x86 or ARM).
 */
const ELF_HOSTS = new Map<string, ElfHost>([
  ["x64", { name: "x86-64", goarch: "amd64", machines: [EM_X86_64, EM_386] }],
  ["ia32", { name: "x86 (32-bit)", goarch: "386", machines: [EM_386, EM_X86_64] }],
  ["arm64", { name: "arm64", goarch: "arm64", machines: [EM_AARCH64, EM_ARM] }],
  ["arm", { name: "arm (32-bit)", goarch: "arm", machines: [EM_ARM, EM_AARCH64] }],
]);

/**
 * FORK 2026-10-19 (JarvisPi EPIPE crash loop): why a binary with this ELF header cannot run on a
 * host whose Node reports `arch`, fix included, or null. Null also means "cannot tell": not an
 * ELF file, a big-endian one, fewer than ELF_HEADER_PROBE_BYTES bytes, or an arch missing from
 * ELF_HOSTS. Pure, so it can be tested without a file.
 */
export function elfMachineMismatch(header: Uint8Array, arch: string): string | null {
  const host = ELF_HOSTS.get(arch);
  if (!host || header.length < ELF_HEADER_PROBE_BYTES) {
    return null;
  }
  const isElf = ELF_MAGIC.every((byte, index) => header[index] === byte);
  if (!isElf || header[ELF_DATA_OFFSET] !== ELF_DATA_LITTLE_ENDIAN) {
    return null;
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const machine = view.getUint16(ELF_MACHINE_OFFSET, true);
  if (host.machines.includes(machine)) {
    return null;
  }
  const builtFor = ELF_MACHINE_NAMES.get(machine) ?? `ELF machine 0x${machine.toString(16)}`;
  return (
    `file is built for ${builtFor} but this host is ${host.name}; rebuild it: run ` +
    "scripts/build-whatsmeow-node.sh on this host, or cross-compile with " +
    `CGO_ENABLED=0 GOOS=linux GOARCH=${host.goarch} go build ./cmd/whatsmeow-node`
  );
}

/** The first `length` bytes of a file, or null when it cannot be opened or read. */
function readFileHead(filePath: string, length: number): Uint8Array | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const head = new Uint8Array(length);
    const bytesRead = readSync(fd, head, 0, length, 0);
    return head.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The bytes are already read; a failed close changes nothing here.
      }
    }
  }
}

/**
 * Raw event tracing for debugging the whatsmeow bridge. OFF by default: when
 * on, it writes the first 1500 characters of every message, receipt, presence
 * and history-sync event (including message text) to the gateway log.
 */
const EVENT_TRACE_ENV = "OPENCLAW_WHATSMEOW_EVENT_TRACE";

function isEventTraceEnabled(): boolean {
  return process.env[EVENT_TRACE_ENV]?.trim() === "1";
}

let activeClient: WhatsmeowClient | null = null;

const logger = getChildLogger({ module: "wm-session" });

export interface CreateWmClientOptions {
  storePath?: string;
  onQr?: (code: string) => void;
  verbose?: boolean;
}

const WM_CHILD_STREAMS = ["stdin", "stdout", "stderr"] as const;

type WmStreamLike = { on?: (event: "error", listener: (err: unknown) => void) => unknown };

/**
 * FORK 2026-10-19 (JarvisPi EPIPE crash loop): 'error' listeners on the whatsmeow Go child's
 * stdio pipes.
 *
 * whatsmeow-node writes each command to the child's stdin with no error callback (GoProcess.send
 * in its dist/index.js). If the child is already dead, node raises the EPIPE on a later tick as
 * an 'error' event on the stdin socket, and with no listener that is an uncaught exception. On
 * 2026-10-19 that killed the JarvisPi gateway 18 times: an x86-64 override binary on the arm64
 * Pi exited 2 at once, and the next write hit the closed pipe. inbound/lifecycle.ts named this
 * cure on 2026-09-03, but it was never wired in.
 *
 * Attaches one listener to each stream that is present and passes the error to `onError`. A
 * throwing `onError` is swallowed too: an error handler that throws is the crash this prevents.
 * Returns how many streams were guarded. tinkerclaw-tinker-bridge/src/child-stream-guards.ts has
 * the same shape; extensions do not import from each other, hence this local copy.
 */
export function guardWmChildStreams(
  child: unknown,
  onError: (stream: string, err: unknown) => void,
): number {
  if (!child || typeof child !== "object") {
    return 0;
  }
  const stdio = child as Partial<Record<(typeof WM_CHILD_STREAMS)[number], unknown>>;
  let guarded = 0;
  for (const name of WM_CHILD_STREAMS) {
    const stream = stdio[name] as WmStreamLike | null | undefined;
    if (!stream || typeof stream.on !== "function") {
      continue;
    }
    stream.on("error", (err: unknown) => {
      try {
        onError(name, err);
      } catch {
        // Never let the error handler become the next uncaught exception.
      }
    });
    guarded += 1;
  }
  return guarded;
}

/** The parts of @whatsmeow-node/whatsmeow-node's GoProcess that the guard below relies on. */
type WmGoProcessInternals = { start?: () => void; proc?: unknown };

/**
 * FORK 2026-10-19 (JarvisPi EPIPE crash loop): spawn the Go child before init() and guard its
 * stdio. init() calls GoProcess.start() and writes its first command to stdin in the same tick,
 * so the listeners must exist before init() runs; start() returns early once a child exists, so
 * init() reuses this one. Checked against @whatsmeow-node/whatsmeow-node dist/index.js:
 * `client.proc` is the GoProcess wrapper (start(), proc) and `client.proc.proc` the ChildProcess.
 * If those internals move, this logs at debug level and init() runs exactly as it did before.
 */
function startAndGuardWmChild(client: WhatsmeowClient): void {
  let warned = false;
  const onStreamError = (stream: string, err: unknown) => {
    const rawCode = (err as { code?: unknown } | null | undefined)?.code;
    const code = typeof rawCode === "string" ? rawCode : undefined;
    const fields = { stream, code, error: String(err) };
    const message = `whatsmeow Go child ${stream} error (${code ?? "no code"}) swallowed`;
    // One warning per child: a dying child can fail several writes in a row.
    if (warned) {
      logger.debug(fields, `${message} again`);
      return;
    }
    warned = true;
    logger.warn(fields, `${message}; the child has probably exited`);
  };
  try {
    const goProcess = (client as unknown as { proc?: WmGoProcessInternals | null }).proc;
    goProcess?.start?.();
    if (guardWmChildStreams(goProcess?.proc, onStreamError) === 0) {
      logger.debug("whatsmeow: Go child stdio not found; stream guards skipped");
    }
  } catch (err) {
    // A spawn that throws here throws again inside init(), which reports it as before.
    logger.debug({ error: String(err) }, "whatsmeow: could not start the Go child early");
  }
}

/**
 * Create and initialise a whatsmeow-node client.
 * Does NOT call connect() — caller decides when to connect.
 */
export async function createWmClient(opts: CreateWmClientOptions = {}): Promise<WhatsmeowClient> {
  const storePath = resolveUserPath(opts.storePath ?? DEFAULT_STORE_PATH);
  const storeDir = storePath.replace(/\/[^/]+$/, "");
  await ensureDir(storeDir);

  const createClient = await loadCreateClient();
  const binaryPath = resolveWhatsmeowBinaryPath();
  if (binaryPath) {
    logger.info({ binaryPath }, "whatsmeow: using binary override");
  }
  const client = createClient(binaryPath ? { store: storePath, binaryPath } : { store: storePath });

  // ── QR events ──
  if (opts.onQr) {
    client.on("qr", ({ code }) => opts.onQr!(code));
  }

  // ── Connection lifecycle ──
  client.on("connected", ({ jid }) => {
    logger.info({ jid }, "whatsmeow connected");
  });

  client.on("disconnected", () => {
    logger.warn("whatsmeow disconnected");
  });

  client.on("logged_out", ({ reason }) => {
    logger.error({ reason }, "whatsmeow logged out");
  });

  // ── Forward whatsmeow internal logs when verbose ──
  if (opts.verbose) {
    client.on("log", ({ level, msg }) => {
      logger.debug({ wmLevel: level }, msg);
    });
  }
  // Payload event trace for self-DM diagnosis. Only when
  // OPENCLAW_WHATSMEOW_EVENT_TRACE=1: it logs message text to the journal.
  if (isEventTraceEnabled()) {
    logger.warn(`${EVENT_TRACE_ENV}=1: logging whatsmeow event payloads`);
    const allEvents = [
      "message",
      "message:receipt",
      "history_sync",
      "chat_presence",
      "presence",
      "stream_error",
    ];
    for (const ev of allEvents) {
      client.on(ev, (payload: unknown) => {
        try {
          const summary = JSON.stringify(payload).slice(0, 1500);
          console.log(`[wm-event-full] ${ev}: ${summary}`);
        } catch {
          console.log(`[wm-event-full] ${ev}: <unserializable>`);
        }
      });
    }
  }

  // ── Error safety net ──
  client.on("error", (err) => {
    logger.error({ error: String(err) }, "whatsmeow client error");
  });

  // ── Bind history capture ──
  try {
    bindWmHistoryCapture(client);
    logger.info("whatsmeow history live-capture bound");
  } catch (err) {
    logger.warn({ error: String(err) }, "whatsmeow history capture failed to bind");
  }

  // FORK 2026-10-19 (JarvisPi EPIPE crash loop): guard the Go child's stdio before init() writes
  // to it, so a child that dies at once cannot take the gateway down with an uncaught EPIPE.
  startAndGuardWmChild(client);

  // Init (loads store, but does not connect). InitResult carries the stored
  // self JID for already-paired sessions — this is DETERMINISTIC, unlike the
  // "connected" event listener which raced on some boots and left
  // sock.user.id=null. Stash on the client so the adapter can seed selfJid
  // from a known-non-null source.
  const initResult = await client.init();
  if (initResult?.jid) {
    (client as unknown as { __initJid?: string }).__initJid = initResult.jid;
    console.log(`[wm-session] init() returned jid=${initResult.jid}`);
  } else {
    console.log("[wm-session] init() returned no jid (unpaired or fresh store)");
  }

  activeClient = client;
  return client;
}

/** Get the currently active whatsmeow client (if any). */
export function getWmClient(): WhatsmeowClient | null {
  return activeClient;
}

/** Connect + wait for connection (with timeout). */
export async function connectWmClient(client: WhatsmeowClient, timeoutMs = 60_000): Promise<void> {
  // FORK 2026-08-29: capture the REASON the link failed.
  //
  // This used to report only `connection timed out after ${timeoutMs}ms`, which
  // was doubly misleading: whatsmeow answers in seconds (waitForConnection
  // resolves false as soon as the socket gives up — observed 2-5s, never 60s),
  // and the specific cause was being thrown away. For a month the channel
  // reported a timeout while whatsmeow was in fact emitting
  // `qr:error / err-client-outdated` — WhatsApp rejecting an outdated client
  // build. Nobody could act on it because the message never named it.
  //
  // Record the last diagnostic event and put it in the thrown error.
  let reason: string | null = null;
  const note = (label: string) => (payload: unknown) => {
    if (reason) {
      return;
    }
    let detail = "";
    try {
      // Never log a QR payload: it is a pairing secret.
      detail = label === "qr" ? "" : (JSON.stringify(payload) ?? "").slice(0, 300);
    } catch {
      detail = "<unserializable>";
    }
    reason = detail ? `${label}: ${detail}` : label;
  };
  for (const ev of ["qr:error", "stream_error", "logged_out", "error", "disconnected"]) {
    try {
      client.on(ev, note(ev));
    } catch {
      // best-effort: an older addon may not emit every event
    }
  }

  const startedAt = Date.now();
  await client.connect();
  const connected = await client.waitForConnection(timeoutMs);
  if (!connected) {
    const waitedMs = Date.now() - startedAt;
    const because = reason ? ` (${reason})` : " (no diagnostic event received)";
    const hint = reason?.includes("err-client-outdated")
      ? " — WhatsApp rejected this client as OUTDATED; the whatsmeow Go binary must be" +
        ` rebuilt against a current go.mau.fi/whatsmeow and pointed at via ${BINARY_PATH_ENV}`
      : "";
    throw new Error(
      `whatsmeow: connection failed after ${waitedMs}ms (budget ${timeoutMs}ms)${because}${hint}`,
    );
  }
}

/** Gracefully disconnect AND terminate the Go subprocess.
 *
 * FORK 2026-05-01: whatsmeow-node's `client.disconnect()` only sends a
 * "disconnect" IPC message — the Go subprocess keeps running. On every
 * reconnect cycle that left the prior subprocess alive, so over a day
 * we accumulated 6 leaked `whatsmeow-node` processes all holding the
 * same SQLite store open. We now also call `client.close()` (which does
 * `this.proc.kill()`) so the subprocess actually exits. */
export async function disconnectWmClient(client?: WhatsmeowClient): Promise<void> {
  const c = client ?? activeClient;
  if (!c) {
    return;
  }
  try {
    await c.disconnect();
  } catch {
    // best-effort
  }
  try {
    // biome-ignore lint/suspicious/noExplicitAny: optional addon, see top-of-file structural type
    (c as any).close?.();
  } catch {
    // best-effort
  }
  if (c === activeClient) {
    activeClient = null;
  }
}
