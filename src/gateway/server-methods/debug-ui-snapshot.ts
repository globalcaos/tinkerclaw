/**
 * FORK 2026-05-09 — `debug.dumpUiSnapshot` RPC.
 *
 * Tinker UI calls this on every chat re-render so I (the architect-side
 * Claude Code session) can introspect the actual rendered DOM by reading a
 * file on disk, instead of round-tripping through the browser relay or
 * asking the user "what does it look like?". File mirror lives at
 *   ~/.openclaw/data/tinker-ui-snapshot.html         (newest render, ANY session)
 *   ~/.openclaw/data/tinker-ui-snapshot.json         (ts + viewport + url + styles + identity)
 *   ~/.openclaw/data/tinker-ui-snapshot.<slug>.html  (per-session — see the CAVEAT under 3 below:
 *   ~/.openclaw/data/tinker-ui-snapshot.<slug>.json   no current caller passes `sessionKey`, so
 *                                                     these two do NOT exist on disk yet)
 *
 * FORK 2026-08-28 — the probe used to destroy itself. Three defects, all measured live:
 *
 *  1. FAIL-DESTRUCTIVE WRITES — FIXED HERE. Both paths were written with plain `fs.writeFile`
 *     inside a `Promise.all`. `writeFile` is open(O_WRONLY|O_CREAT|O_TRUNC) + write, so every call
 *     TRUNCATED the last good snapshot to zero BEFORE it had the new bytes. The browser fires this
 *     on every re-render (300 ms debounce, per tab) and several tabs write the SAME two paths, so
 *     handlers overlap inside one second:
 *         14:44:52.147 res debug.dumpUiSnapshot 7808ms
 *         14:44:52.152 res debug.dumpUiSnapshot 7825ms
 *         14:44:52.157 res debug.dumpUiSnapshot 7852ms
 *         14:44:52.680 res debug.dumpUiSnapshot  497ms
 *     Under that pressure the truncate landed and the write did not: at 14:48:12 both files were
 *     0 B, six polls over the next 12 s all read `json=0B CORRUPT html=0B`, and the pair only
 *     recovered at 14:50:30 (html 643,108 B) — a 2 min 20 s blind window in which the only honest
 *     reading of the file is "the UI lost the content". It had not. Now: stage both payloads under
 *     `<path>.tmp.<pid>.<seq>` and `rename()` them onto the targets (atomic within a filesystem),
 *     so a reader sees the old complete pair or the new complete pair, never a partial one.
 *
 *  2. THE META COULD ADVERTISE A RENDER THE HTML LACKED — FIXED HERE. `Promise.all` gave no
 *     ordering; the measured mtimes were json 14:50:30.637765024 vs html 14:50:30.711…, i.e. the
 *     meta landed FIRST. The meta is renamed LAST now, so `meta.ts`/`meta.bytes` never describe
 *     bytes the html has not yet received.
 *
 *  3. A SINGLE GLOBAL SLOT WITH NO IDENTITY — SERVER HALF ONLY; **NOT YET LIVE**. Both paths were
 *     fixed constants and nothing in the payload named the session, so every tab showing any
 *     session overwrote the same file, last writer wins. That produced a textbook FALSE
 *     content-loss report: an injected test stamp was present inside `#messages` at 12:52:49Z and
 *     gone at 12:53:06Z — not because the render path dropped it, but because the file now held a
 *     DIFFERENT conversation (stamped into `agent:main:tinker:mt4ata2g`; the file then showed
 *     `agent:main:tinker:mt79j0oy` for 12 consecutive samples). The message was durable on disk the
 *     whole time.
 *     CAVEAT — READ THIS BEFORE BELIEVING THE ARTEFACT HAS AN IDENTITY: this handler now ACCEPTS
 *     `sessionKey`/`tabId` and writes a per-session pair when it receives them, but the only
 *     production caller (`tinker-ui/src/app.ts` → `scheduleUiSnapshotDump`, ~line 6450) sends
 *     NEITHER. Until that call site is updated, `meta.sessionKey`/`meta.tabId`/`meta.sessionSlug`
 *     are `null` on every render, no `tinker-ui-snapshot.<slug>.*` file is ever created, and the
 *     artefact on disk is STILL the anonymous global slot. The client change is a separate unit.
 *
 * Also: the client ships `.right-panels` AHEAD of the chat area — 449 KB of a 632 KB payload (the
 * `<!--CHAT-AREA-->` marker sits at byte 449,279 of 635,822). The panels echo arbitrary strings
 * back (the amygdala panel repeats the architect's own query), which is the source of every
 * false-positive "the phrase IS in the snapshot" match. They are dropped unless the caller passes
 * `includePanels:true`, removing 70% of the payload and the false-positive surface at once. This
 * one IS live immediately, and it invalidates the "grep the whole file and you will match the
 * amygdala panel" step in `extensions/tinkerclaw-fractal-reflection/fractal-prompt.md` (~line 146)
 * and its copy in `tinker-ui/src/app.ts` (~line 12396) — both need the follow-up edit. A
 * `<!--PANELS-OMITTED …-->` breadcrumb is left in the file so a reader following the old playbook
 * finds the correction in the very file they are grepping.
 *
 * Trust model: writes known-name files under ~/.openclaw/data/ only. The caller cannot pick the
 * path — `sessionKey` is treated as UNTRUSTED: slugged to `[A-Za-z0-9_-]`, length-bounded,
 * suffixed with a digest of the RAW key so one session cannot hijack another's file by swapping
 * separators, and the resolved path is asserted to sit directly in the snapshot dir before any
 * write. Body capped at MAX_HTML_BYTES.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";

const SNAPSHOT_DIR = path.join(os.homedir(), ".openclaw/data");
const SNAPSHOT_STEM = "tinker-ui-snapshot";
/**
 * Cap on the mirrored HTML. Counted in UTF-16 code units, NOT bytes — the name is kept because
 * readers already parse the `bytes` field out of the meta. For the ASCII-dominant chat DOM the two
 * numbers coincide; for a CJK-heavy render this is a conservative under-count of real bytes.
 */
const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** The client concatenates SNAPVER + `.right-panels` + this marker + `#messages`. */
const CHAT_AREA_MARKER = "<!--CHAT-AREA-->";
const SNAPVER_RE = /^<!--SNAPVER:.*?-->/;
const PANELS_OMITTED_NOTE =
  "<!--PANELS-OMITTED 2026-08-28: the .right-panels blob is no longer mirrored here, so a " +
  "whole-file grep of this file is now SAFE (it can no longer match a panel echoing your own " +
  "query back). Pass includePanels:true to restore it.-->";
/** Longest human-readable label we put in a filename. Real session keys are ~26 chars. */
const MAX_SESSION_LABEL = 56;
/**
 * A `.tmp.*` sibling older than this is a crash leftover, not an in-flight write. Sized from the
 * measured latency of this very RPC (turn-latency.md: p50 2,231 ms · p90 11,075 ms · max
 * 35,771 ms) — 5 min is >8x the worst sample ever recorded, so the sweep cannot race a live write.
 */
const STALE_TMP_MS = 5 * 60_000;
/** Matches only tmp files this module creates: `<stem>….tmp.<pid>.<seq>`. */
const TMP_SUFFIX_RE = /\.tmp\.\d+\.\d+$/;

/**
 * Slug an untrusted session key into ONE filename component.
 *
 * Two stages, and both are load-bearing:
 *  - the LABEL keeps the key greppable: everything outside `[A-Za-z0-9_-]` collapses to a single
 *    `-`, so path separators, `..`, NUL and drive letters all become inert, then it is bounded;
 *  - the DIGEST makes it injective. The label alone is not: `agent:main:x`, `agent/main/x` and
 *    `agent.main.x` all collapse to `agent-main-x`, and the length bound merges any two keys
 *    sharing a 56-char prefix. `sessionKey` arrives over the RPC and is untrusted, so a collision
 *    is a HIJACK — caller B silently overwrites caller A's per-session artefact and the file stops
 *    holding one conversation, which is the exact bug this identity work exists to kill. The
 *    digest is taken over the RAW key, so distinct keys always get distinct files.
 *
 * Returns null when the input is not a usable string, or has no filename-safe character at all: a
 * caller passing no `sessionKey` (or a degenerate one) must still work, writing only the shared
 * convenience pair. That is the back-compat contract.
 *
 * The RAW `sessionKey` is stored in the meta and remains the authoritative identity.
 */
export function sanitizeSessionKeyForFilename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .slice(0, MAX_SESSION_LABEL)
    .replace(/^-+|-+$/g, "");
  if (label.length === 0) return null;
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `${label}-${digest}`;
}

/**
 * Never GUESS "is this path inside the dir" from the shape of the name — resolve it and check.
 * The slug above is supposed to be inert; this is the only claim the filesystem API will agree to.
 */
function resolveInside(dir: string, name: string): string | null {
  const root = path.resolve(dir);
  const full = path.resolve(root, name);
  return path.dirname(full) === root ? full : null;
}

let tmpSeq = 0;
function nextTmpSuffix(): string {
  tmpSeq = (tmpSeq + 1) % 1_000_000_000;
  return `tmp.${process.pid}.${tmpSeq}`;
}

/**
 * Drop the `.right-panels` blob the client prepends. MEASURED: the `<!--CHAT-AREA-->` marker sits
 * at byte 449,279 of a 635,822-byte payload — 70% of what we stored was panels, and the panels
 * echo arbitrary strings back, so a whole-file grep for "is my answer in the render?" matched the
 * panel and reported a false positive. The leading SNAPVER comment is kept (client-build
 * provenance) and a breadcrumb replaces the blob, so a reader who greps and misses a panel string
 * can tell "omitted" from "never present" — and finds the corrected playbook in the file itself.
 */
export function stripRightPanels(html: string): string {
  const idx = html.indexOf(CHAT_AREA_MARKER);
  // No marker: an older client, or a caller that already sent `#messages` only. Nothing to strip,
  // and guessing a boundary here would silently eat real chat.
  if (idx < 0) return html;
  const snapver = SNAPVER_RE.exec(html);
  const chat = html.slice(idx + CHAT_AREA_MARKER.length).replace(/^\r?\n/, "");
  const head = snapver ? `${snapver[0]}\n` : "";
  return `${head}${PANELS_OMITTED_NOTE}\n${chat}`;
}

/**
 * Cap the stored body. Split on a code-unit boundary that is NOT inside a surrogate pair: an
 * orphaned high surrogate becomes U+FFFD once `writeFile(…, "utf-8")` encodes it, corrupting the
 * last character of an already-lossy edge for no reason.
 */
export function truncateHtml(body: string, max: number): { payload: string; truncated: boolean } {
  if (body.length <= max) return { payload: body, truncated: false };
  const last = body.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return { payload: body.slice(0, end), truncated: true };
}

/**
 * A crash between `writeFile(tmp)` and `rename(tmp, target)` leaks a `.tmp.*` sibling forever.
 * Swept once per directory per process, on the first write rather than at import time — module
 * load doing async fs is both untestable and a startup hazard. Best-effort by construction: a
 * snapshot must never fail because the sweep could not read the directory.
 */
const sweptDirs = new Set<string>();
export async function sweepStaleTmpFiles(dir: string, now = Date.now()): Promise<number> {
  if (sweptDirs.has(dir)) return 0;
  // Claim the dir BEFORE the first await so concurrent first-writes cannot double-sweep.
  sweptDirs.add(dir);
  let removed = 0;
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith(`${SNAPSHOT_STEM}.`) || !TMP_SUFFIX_RE.test(name)) continue;
      const full = path.join(dir, name);
      const st = await fs.stat(full).catch(() => null);
      // Age, not pid-liveness: another gateway process may legitimately own a fresh tmp file.
      if (!st || now - st.mtimeMs < STALE_TMP_MS) continue;
      await fs.rm(full, { force: true }).catch(() => undefined);
      removed += 1;
    }
  } catch {
    /* unreadable dir — the write below will surface the real error */
  }
  return removed;
}

type QueuedWrite = { token: symbol; run: () => Promise<void> };
type QueueSlot = {
  /** ONE-DEEP: a newer payload REPLACES this; it is never appended behind it. */
  queued: QueuedWrite | null;
  waiters: Array<{
    token: symbol;
    resolve: (landed: boolean) => void;
    reject: (err: unknown) => void;
  }>;
  draining: boolean;
};
const writeQueues = new Map<string, QueueSlot>();

/**
 * One-deep coalescing queue, keyed on the HTML target. The html+meta pair is ONE unit under one
 * key, so the html-then-meta rename ordering survives coalescing.
 *
 * If a write is already in flight the new payload REPLACES the queued one instead of queueing
 * behind it, and exactly one more write runs when the current one settles. The newest state always
 * lands and render throughput is preserved. This bounds the depth of a queue of unsafe writes to
 * ONE file; it does not cap the UI, the user, or any concurrency the architect controls — no
 * render is refused, no tab is throttled, and the file always converges on the newest DOM.
 *
 * Resolves with whether THIS caller's payload is the one that reached disk. A superseded caller
 * must be told so: answering `ok:true, bytes:214880` for bytes that never reached the file is the
 * same lie as the 0-byte window, moved from the artefact into the RPC response.
 */
function enqueueCoalesced(key: string, run: () => Promise<void>): Promise<boolean> {
  let slot = writeQueues.get(key);
  if (!slot) {
    slot = { queued: null, waiters: [], draining: false };
    writeQueues.set(key, slot);
  }
  const s = slot;
  const token = Symbol("ui-snapshot-write");
  s.queued = { token, run };
  const settled = new Promise<boolean>((resolve, reject) => {
    s.waiters.push({ token, resolve, reject });
  });
  if (!s.draining) void drainQueue(key);
  return settled;
}

async function drainQueue(key: string): Promise<void> {
  const slot = writeQueues.get(key);
  if (!slot || slot.draining) return;
  slot.draining = true;
  try {
    while (slot.queued) {
      const { token, run } = slot.queued;
      const waiters = slot.waiters;
      slot.queued = null;
      slot.waiters = [];
      try {
        await run();
        // A superseded caller's PAYLOAD is dropped, never its promise — and never silently: it
        // settles `false`, which is what `coalesced` on the RPC result is built from.
        for (const w of waiters) w.resolve(w.token === token);
      } catch (err) {
        for (const w of waiters) w.reject(err);
      }
    }
  } finally {
    slot.draining = false;
    if (!slot.queued && slot.waiters.length === 0 && writeQueues.get(key) === slot) {
      writeQueues.delete(key);
    }
  }
}

/**
 * Stage both files, then rename HTML first and META second — ALWAYS. The meta advertises `ts` and
 * `bytes` for a render; if it landed first, a reader could believe in bytes the html file does not
 * hold yet. Measured inversion before this fix: json mtime 14:50:30.637765024 < html 14:50:30.711…
 *
 * Only the RENAME order carries meaning. The staging order is free — both tmp files are discarded
 * together if either write fails, so nothing observes which was created first.
 *
 * Do NOT try to verify the rename order from stat timestamps, however obvious that looks.
 * `rename()` does not touch mtime (mtime is inherited from the tmp file, so it records STAGING,
 * not landing), and ctime — which does track the rename — TIES: MEASURED on this repo, both
 * renames land inside a single kernel clock tick, so an mtime/ctime comparison passes IDENTICALLY
 * with the two renames swapped. That was verified by mutating this function and re-running the
 * suite: 20/20 still green. The regression test gates the ordering by observing the pair from
 * INSIDE the window instead, on the `rename:html` step below, where the html has already advanced
 * and the meta must still describe the previous render.
 */
async function writeSnapshotPair(
  htmlPath: string,
  metaPath: string,
  html: string,
  metaJson: string,
  onStep?: (step: string) => void,
): Promise<void> {
  const metaTmp = `${metaPath}.${nextTmpSuffix()}`;
  const htmlTmp = `${htmlPath}.${nextTmpSuffix()}`;
  const discardTmps = async () => {
    await fs.rm(htmlTmp, { force: true }).catch(() => undefined);
    await fs.rm(metaTmp, { force: true }).catch(() => undefined);
  };
  try {
    await fs.writeFile(metaTmp, metaJson, "utf-8");
    await fs.writeFile(htmlTmp, html, "utf-8");
  } catch (err) {
    await discardTmps();
    throw err;
  }
  // Both payloads are COMPLETE on disk under temporary names and the live pair is still the
  // previous, complete render. This is the instant the old code did not have: `writeFile` on the
  // target had already truncated it to 0 B here.
  onStep?.("staged");
  try {
    await fs.rename(htmlTmp, htmlPath);
  } catch (err) {
    await discardTmps();
    throw err;
  }
  onStep?.("rename:html");
  try {
    await fs.rename(metaTmp, metaPath);
  } catch (err) {
    await fs.rm(metaTmp, { force: true }).catch(() => undefined);
    // The html ALREADY landed and cannot be rolled back. Leaving the previous meta in place would
    // make it describe an OLDER render than the html holds, and a reader correlating `meta.ts`
    // against the html would conclude "the UI stopped rendering at meta.ts" — the same false
    // content-loss story, re-entering through the error path. ENOENT is an honest unknown; a stale
    // meta is not. The message names the partial success, because `ok:false` alone would imply
    // nothing happened.
    await fs.rm(metaPath, { force: true }).catch(() => undefined);
    const reason = (err as Error).message;
    throw new Error(
      `snapshot meta rename failed AFTER the html landed (stale meta removed): ${reason}`,
      { cause: err },
    );
  }
  onStep?.("rename:meta");
}

export type UiSnapshotInput = {
  html: string;
  url?: unknown;
  viewport?: unknown;
  computedStyles?: unknown;
  sessionKey?: unknown;
  tabId?: unknown;
  includePanels?: unknown;
  /** Test seam: fires on each REAL (non-coalesced) filesystem step. */
  onStep?: (step: string) => void;
  /** Test seam: defaults to ~/.openclaw/data. Deliberately NOT forwarded from the RPC params. */
  dir?: string;
};

export type UiSnapshotWriteResult = {
  htmlPath: string;
  metaPath: string;
  sessionHtmlPath: string | null;
  sessionMetaPath: string | null;
  sessionSlug: string | null;
  panelsIncluded: boolean;
  /**
   * `bytes`/`truncated` describe the payload the CALLER submitted. When `coalesced` is true a
   * newer render superseded it before it reached disk, so the file holds strictly newer bytes and
   * these two numbers do NOT describe what is on disk. Nothing was lost; read the meta for the
   * bytes that landed.
   */
  bytes: number;
  truncated: boolean;
  coalesced: boolean;
};

/**
 * NOTE: everything up to `enqueueCoalesced` is synchronous ON PURPOSE. `mkdir`/sweep live inside
 * the queued closure so that enqueue order equals CALL order — otherwise "the newest state wins"
 * would really mean "whichever mkdir the event loop finished last wins", which is not a guarantee.
 */
export async function writeUiSnapshot(input: UiSnapshotInput): Promise<UiSnapshotWriteResult> {
  const dir = input.dir ?? SNAPSHOT_DIR;
  const includePanels = input.includePanels === true;
  // Strip BEFORE the cap, never after: the panels are sent FIRST, so capping first would spend the
  // whole budget on the blob we are about to throw away and truncate the chat instead.
  const body = includePanels ? input.html : stripRightPanels(input.html);
  const { payload, truncated } = truncateHtml(body, MAX_HTML_BYTES);

  const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey : null;
  const tabId = typeof input.tabId === "string" ? input.tabId : null;
  const sessionSlug = sanitizeSessionKeyForFilename(sessionKey);

  const meta = {
    ts: new Date().toISOString(),
    bytes: payload.length,
    truncated,
    viewport: input.viewport ?? null,
    url: typeof input.url === "string" ? input.url : null,
    computedStyles: input.computedStyles ?? null,
    // FORK 2026-08-28 — identity. Without these the file is an anonymous global slot and a reader
    // cannot tell a re-render from a different conversation. `sessionKey` is the RAW key, and it
    // is `null` on every render until the `app.ts` call site starts sending it (see header §3).
    sessionKey,
    tabId,
    sessionSlug,
    panelsIncluded: includePanels,
  };
  const metaJson = `${JSON.stringify(meta, null, 2)}\n`;

  const htmlPath = path.join(dir, `${SNAPSHOT_STEM}.html`);
  const metaPath = path.join(dir, `${SNAPSHOT_STEM}.json`);
  let sessionHtmlPath: string | null = null;
  let sessionMetaPath: string | null = null;
  if (sessionSlug) {
    const h = resolveInside(dir, `${SNAPSHOT_STEM}.${sessionSlug}.html`);
    const m = resolveInside(dir, `${SNAPSHOT_STEM}.${sessionSlug}.json`);
    // Both or neither — a per-session html with no meta is a worse artefact than none.
    if (h && m) {
      sessionHtmlPath = h;
      sessionMetaPath = m;
    }
  }

  const writes: Array<Promise<boolean>> = [];
  if (sessionHtmlPath && sessionMetaPath) {
    const h = sessionHtmlPath;
    const m = sessionMetaPath;
    // Its OWN queue key: two different sessions must never coalesce each other away — that would
    // reintroduce exactly the identity bug this file exists to fix.
    writes.push(
      enqueueCoalesced(h, async () => {
        input.onStep?.("write:session");
        await fs.mkdir(dir, { recursive: true });
        await sweepStaleTmpFiles(dir);
        await writeSnapshotPair(h, m, payload, metaJson, input.onStep);
      }),
    );
  }
  writes.push(
    enqueueCoalesced(htmlPath, async () => {
      input.onStep?.("write:default");
      await fs.mkdir(dir, { recursive: true });
      await sweepStaleTmpFiles(dir);
      await writeSnapshotPair(htmlPath, metaPath, payload, metaJson, input.onStep);
    }),
  );

  const settled = await Promise.allSettled(writes);
  for (const r of settled) {
    if (r.status === "rejected") throw r.reason;
  }

  return {
    htmlPath,
    metaPath,
    sessionHtmlPath,
    sessionMetaPath,
    sessionSlug,
    panelsIncluded: includePanels,
    bytes: payload.length,
    truncated,
    coalesced: settled.some((r) => r.status === "fulfilled" && r.value === false),
  };
}

export const debugUiSnapshotHandlers: GatewayRequestHandlers = {
  "debug.dumpUiSnapshot": async ({ params, respond }) => {
    const p = (params ?? {}) as {
      html?: unknown;
      css?: unknown;
      viewport?: unknown;
      url?: unknown;
      computedStyles?: unknown;
      sessionKey?: unknown;
      tabId?: unknown;
      includePanels?: unknown;
    };
    const html = typeof p.html === "string" ? p.html : "";
    if (!html) {
      // CONTRACT — do not "fix" this into a server-side trigger. The CALLER supplies the DOM, so
      // there is nothing to dump without it; the bible's liveness probes call this with no params
      // on purpose and accept exactly this shape as proof the handler is loaded.
      respond(true, { ok: false, reason: "html required" }, undefined);
      return;
    }
    try {
      const res = await writeUiSnapshot({
        html,
        url: p.url,
        viewport: p.viewport,
        computedStyles: p.computedStyles,
        sessionKey: p.sessionKey,
        tabId: p.tabId,
        includePanels: p.includePanels,
      });
      // `htmlPath`/`metaPath` keep their old names and meaning for existing callers. `coalesced`
      // is the field that keeps `bytes` honest — see UiSnapshotWriteResult.
      respond(true, { ok: true, ...res }, undefined);
    } catch (err) {
      respond(true, { ok: false, reason: (err as Error).message }, undefined);
    }
  },
};
