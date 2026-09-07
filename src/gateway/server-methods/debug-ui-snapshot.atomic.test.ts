import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sanitizeSessionKeyForFilename,
  stripRightPanels,
  sweepStaleTmpFiles,
  truncateHtml,
  writeUiSnapshot,
} from "./debug-ui-snapshot.js";

/**
 * FORK 2026-08-28 — regression suite for the self-destructing UI snapshot probe.
 *
 * Every case is anchored to a live measurement, because each defect first surfaced as a FALSE bug
 * report: `json=0B CORRUPT html=0B` for 2 min 20 s (defect 1), a meta whose mtime preceded the html
 * it described (defect 2), and an injected stamp that "disappeared" from `#messages` when the file
 * had simply switched conversations (defect 3).
 *
 * Two of these tests are written to fail on the REVERTED implementation, not merely to pass on the
 * fixed one — the `"staged"` probe below fails if `fs.writeFile` goes back onto the target paths,
 * and the mtime/ctime pair fails if the two renames are swapped.
 */

// The panel blob is deliberately much larger than the chat, mirroring the measured 449,279 /
// 635,822 split, so the "70% of the payload" claim is actually exercised.
const PANEL_BLOB = `<div class="right-panels">${"amygdala-echo ".repeat(300)}</div>`;
const SNAPVER = "<!--SNAPVER:test-2026-08-28-->";
const NUL = String.fromCharCode(0);

function payload(stamp: string, chatRepeat = 1): string {
  const chat = `<div class="msg user">${stamp}</div>`.repeat(chatRepeat);
  return `${SNAPVER}${PANEL_BLOB}\n<!--CHAT-AREA-->\n<div id="messages">${chat}</div>`;
}

let dir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tinker-ui-snapshot-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("debug.dumpUiSnapshot — atomicity", () => {
  it("(a) never truncates the live file: the target still holds the PREVIOUS complete render while the next one is staged", async () => {
    const htmlPath = path.join(dir, "tinker-ui-snapshot.html");
    const first = stripRightPanels(payload("first"));
    const second = stripRightPanels(payload("second"));

    await writeUiSnapshot({ html: payload("first"), dir });
    expect(fsSync.readFileSync(htmlPath, "utf-8")).toBe(first);

    // Sampled synchronously at the exact instant both new payloads exist on disk and neither has
    // been renamed onto its target. Under the old `fs.writeFile(target)` this instant does not
    // exist at all — the target had already been truncated to 0 B, which is the measured
    // `html=0B CORRUPT` window. An array (not a nullable let) so TS keeps the type.
    const staged: Array<{ target: string; tmps: string[] }> = [];
    await writeUiSnapshot({
      html: payload("second"),
      dir,
      onStep: (step) => {
        if (step !== "staged") return;
        staged.push({
          target: fsSync.readFileSync(htmlPath, "utf-8"),
          tmps: fsSync.readdirSync(dir).filter((n) => n.includes(".tmp.")),
        });
      },
    });

    expect(staged).toHaveLength(1);
    expect(staged[0]!.tmps).toHaveLength(2); // html + meta, both staged before either rename
    expect(staged[0]!.target).toBe(first); // still the OLD render, complete — not 0 B, not partial
    expect(fsSync.readFileSync(htmlPath, "utf-8")).toBe(second);
    expect(fsSync.readdirSync(dir).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("a concurrent reader only ever sees a complete payload", async () => {
    // Complements the deterministic check above with the real-world shape: a SEPARATE process
    // (the architect's Read) polling the file while the gateway rewrites it. ~190 KB body so a
    // torn read would be wide enough to catch.
    const htmlPath = path.join(dir, "tinker-ui-snapshot.html");
    await writeUiSnapshot({ html: payload("seed", 4000), dir });

    const bodies = Array.from({ length: 12 }, (_, i) => payload(`stamp-${i}`, 4000));
    const valid = new Set([payload("seed", 4000), ...bodies].map((b) => stripRightPanels(b)));

    let stop = false;
    let reads = 0;
    let torn = 0;
    let firstTorn = "";
    const reader = (async () => {
      while (!stop) {
        const text = await fs.readFile(htmlPath, "utf-8");
        reads += 1;
        // Not merely "non-empty": the exact bytes of SOME complete payload. A torn write lands
        // here as a prefix that matches nothing; the old truncate-then-write landed here as "".
        if (!valid.has(text)) {
          torn += 1;
          if (!firstTorn) firstTorn = `${text.length} chars`;
        }
        await new Promise((r) => setImmediate(r));
      }
    })();

    try {
      await Promise.all(bodies.map((html) => writeUiSnapshot({ html, dir })));
    } finally {
      stop = true;
      await reader;
    }

    expect(reads).toBeGreaterThan(0);
    expect(torn, `torn or empty reads: ${torn}/${reads} (first: ${firstTorn})`).toBe(0);
  });

  it("(b) renames META after HTML, so the meta never advertises a render the html lacks", async () => {
    // Two payloads of DIFFERENT length, so `meta.bytes` alone identifies which render a meta
    // describes — no timestamps involved.
    const oldHtml = payload("ordering-old");
    const newHtml = payload("ordering-new", 9);
    const oldBytes = stripRightPanels(oldHtml).length;
    const newBytes = stripRightPanels(newHtml).length;
    expect(oldBytes).not.toBe(newBytes);

    await writeUiSnapshot({ html: oldHtml, dir });

    const htmlPath = path.join(dir, "tinker-ui-snapshot.html");
    const metaPath = path.join(dir, "tinker-ui-snapshot.json");
    const steps: string[] = [];
    // Sampled synchronously in the window BETWEEN the two renames. This is the only observation
    // that actually gates the ordering. The obvious check — compare the two files' stat times —
    // is a NO-OP here, and that is measured, not assumed: `rename()` leaves mtime inherited from
    // the tmp file (it records staging, not landing), and ctime, which does track the rename,
    // ties because both renames land inside one kernel clock tick. Mutating the implementation to
    // rename meta FIRST left an mtime/ctime pair fully green (20/20). The interleave probe below
    // fails on that same mutation, which is why it replaced it.
    const between: Array<{ html: string; metaBytes: number }> = [];
    await writeUiSnapshot({
      html: newHtml,
      dir,
      onStep: (s) => {
        steps.push(s);
        if (s !== "rename:html") return;
        between.push({
          html: fsSync.readFileSync(htmlPath, "utf-8"),
          metaBytes: JSON.parse(fsSync.readFileSync(metaPath, "utf-8")).bytes,
        });
      },
    });

    // Catches a swap that moves the labels with the renames...
    expect(steps.filter((s) => s.startsWith("rename:"))).toEqual(["rename:html", "rename:meta"]);
    // ...and this catches a swap that moves only the renames.
    expect(between).toHaveLength(1);
    expect(between[0]!.html).toBe(stripRightPanels(newHtml)); // html has ALREADY advanced
    expect(between[0]!.metaBytes).toBe(oldBytes); // meta still describes the PREVIOUS render

    // A meta that ran ahead is exactly the "the UI stopped rendering at meta.ts" false alarm.
    // Lagging is safe; leading is not. Once both renames land the pair agrees again.
    const metaText = await fs.readFile(metaPath, "utf-8");
    const htmlText = await fs.readFile(htmlPath, "utf-8");
    expect(JSON.parse(metaText).bytes).toBe(newBytes);
    expect(htmlText.length).toBe(newBytes);
  });

  it("(c) collapses N concurrent writes to exactly 2, the LAST payload wins, and superseded callers are TOLD", async () => {
    const actualWrites: string[] = [];
    const bodies = Array.from({ length: 8 }, (_, i) => payload(`burst-${i}`));

    const results = await Promise.all(
      bodies.map((html) =>
        writeUiSnapshot({
          html,
          dir,
          onStep: (s) => {
            if (s === "write:default") actualWrites.push(s);
          },
        }),
      ),
    );

    // Deterministic, not merely bounded: `writeUiSnapshot` has no `await` before `enqueueCoalesced`,
    // so all 8 callers enqueue in call order within one synchronous batch. Caller 0 starts the
    // drain; callers 1..6 each replace the queued payload; caller 7 is the survivor. One in flight
    // plus one coalesced replacement = 2 writes for 8 renders.
    expect(actualWrites).toHaveLength(2);

    const onDisk = await fs.readFile(path.join(dir, "tinker-ui-snapshot.html"), "utf-8");
    expect(onDisk).toBe(stripRightPanels(bodies[bodies.length - 1]!));

    // The dropped payloads must not be reported as written. `ok:true, bytes:N` for bytes that
    // never reached disk is the same lie as the 0-byte window, relocated into the RPC response.
    expect(results.map((r) => r.coalesced)).toEqual([
      false, // caller 0 — ran immediately
      true,
      true,
      true,
      true,
      true,
      true,
      false, // caller 7 — the survivor whose bytes are the ones on disk
    ]);
    expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("reports a partial write honestly when the meta rename fails after the html landed", async () => {
    await writeUiSnapshot({ html: payload("before"), dir });
    // Force the META rename to fail without mocking anything: on Linux `rename(file, dir)` is
    // EISDIR. This is the only branch that can leave the pair torn.
    const metaPath = path.join(dir, "tinker-ui-snapshot.json");
    await fs.rm(metaPath);
    await fs.mkdir(metaPath);
    await fs.writeFile(path.join(metaPath, "keep"), "x");

    await expect(writeUiSnapshot({ html: payload("after"), dir })).rejects.toThrow(
      /meta rename failed AFTER the html landed/,
    );

    // The html DID advance, and the error says so — `ok:false` on its own would imply that
    // nothing happened, which would send the next reader hunting for a phantom regression.
    expect(await fs.readFile(path.join(dir, "tinker-ui-snapshot.html"), "utf-8")).toContain(
      "after",
    );
    // No tmp sibling leaked on the failure path.
    expect((await fs.readdir(dir)).filter((n) => n.includes(".tmp."))).toEqual([]);
  });

  it("sweeps crash-leaked .tmp siblings but never a live one", async () => {
    const sweepDir = await fs.mkdtemp(path.join(os.tmpdir(), "tinker-ui-snapshot-sweep-"));
    const stale = path.join(sweepDir, "tinker-ui-snapshot.html.tmp.1234.1");
    const live = path.join(sweepDir, "tinker-ui-snapshot.html.tmp.5678.2");
    const other = path.join(sweepDir, "unrelated.txt");
    await fs.writeFile(stale, "x");
    await fs.writeFile(live, "y");
    await fs.writeFile(other, "z");
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(stale, longAgo, longAgo);

    expect(await sweepStaleTmpFiles(sweepDir)).toBe(1);
    expect((await fs.readdir(sweepDir)).sort()).toEqual([
      "tinker-ui-snapshot.html.tmp.5678.2",
      "unrelated.txt",
    ]);
    // Once per directory per process — the sweep is a startup cleanup, not a per-write cost.
    expect(await sweepStaleTmpFiles(sweepDir)).toBe(0);

    await fs.rm(sweepDir, { recursive: true, force: true });
  });
});

describe("debug.dumpUiSnapshot — identity", () => {
  it("(d) writes a per-session file and still updates the convenience copy", async () => {
    const res = await writeUiSnapshot({
      html: payload("mt4ata2g"),
      dir,
      sessionKey: "agent:main:tinker:mt4ata2g",
      tabId: "tab-7",
    });

    // Human-readable label + a digest of the RAW key (see the collision test below).
    expect(res.sessionSlug).toMatch(/^agent-main-tinker-mt4ata2g-[0-9a-f]{8}$/);
    expect(res.sessionHtmlPath).toBe(path.join(dir, `tinker-ui-snapshot.${res.sessionSlug}.html`));

    const perSession = await fs.readFile(res.sessionHtmlPath!, "utf-8");
    const convenience = await fs.readFile(path.join(dir, "tinker-ui-snapshot.html"), "utf-8");
    expect(perSession).toBe(convenience);

    const meta = JSON.parse(await fs.readFile(res.sessionMetaPath!, "utf-8"));
    // The RAW key is the identity; the filename slug is only a label.
    expect(meta.sessionKey).toBe("agent:main:tinker:mt4ata2g");
    expect(meta.tabId).toBe("tab-7");

    // The exact trap this unit exists to kill: a second session must NOT overwrite the first
    // session's file. Before the fix the stamp "vanished" here and read as content loss.
    await writeUiSnapshot({
      html: payload("mt79j0oy"),
      dir,
      sessionKey: "agent:main:tinker:mt79j0oy",
    });
    expect(await fs.readFile(res.sessionHtmlPath!, "utf-8")).toContain("mt4ata2g");
    expect(await fs.readFile(path.join(dir, "tinker-ui-snapshot.html"), "utf-8")).toContain(
      "mt79j0oy",
    );
  });

  it("gives two sessions that slug alike two DIFFERENT files", async () => {
    // `sessionKey` is untrusted RPC input. Without the digest, `agent:main:x` and `agent/main/x`
    // would collapse onto one filename and either caller could silently overwrite the other's
    // artefact — reintroducing the identity bug through the sanitizer.
    const a = await writeUiSnapshot({ html: payload("AAA"), dir, sessionKey: "agent:main:x" });
    const b = await writeUiSnapshot({ html: payload("BBB"), dir, sessionKey: "agent/main/x" });
    expect(a.sessionHtmlPath).not.toBe(b.sessionHtmlPath);
    expect(await fs.readFile(a.sessionHtmlPath!, "utf-8")).toContain("AAA");
    expect(await fs.readFile(b.sessionHtmlPath!, "utf-8")).toContain("BBB");

    // The length bound must not merge two keys sharing a long prefix either.
    const long1 = `${"k".repeat(60)}-one`;
    const long2 = `${"k".repeat(60)}-two`;
    expect(sanitizeSessionKeyForFilename(long1)).not.toBe(sanitizeSessionKeyForFilename(long2));
  });

  it("stays backward compatible when the caller passes no sessionKey", async () => {
    const res = await writeUiSnapshot({ html: payload("bare"), dir });
    expect(res.sessionSlug).toBeNull();
    expect(res.sessionHtmlPath).toBeNull();
    expect(res.sessionMetaPath).toBeNull();
    expect(res.coalesced).toBe(false);
    expect(res.htmlPath).toBe(path.join(dir, "tinker-ui-snapshot.html"));
    expect(await fs.readFile(res.htmlPath, "utf-8")).toContain("bare");
    expect(JSON.parse(await fs.readFile(res.metaPath, "utf-8")).sessionKey).toBeNull();

    // A key with no filename-safe character degrades to the no-key behaviour rather than to `..`.
    const empty = await writeUiSnapshot({ html: payload("empty"), dir, sessionKey: "///" });
    expect(empty.sessionHtmlPath).toBeNull();
  });

  it.each([
    ["traversal", "../../../../etc/passwd"],
    ["windows traversal", "..\\..\\windows\\system32"],
    ["embedded traversal", "a/../../b"],
    ["nul byte", `nul${NUL}byte`],
    ["absolute path", "/etc/shadow"],
    ["overlong", "x".repeat(4096)],
  ])("(e) a hostile sessionKey (%s) cannot escape the snapshot dir", async (_name, hostile) => {
    const res = await writeUiSnapshot({ html: payload("hostile"), dir, sessionKey: hostile });

    expect(res.sessionHtmlPath).not.toBeNull();
    expect(path.dirname(res.sessionHtmlPath!)).toBe(path.resolve(dir));
    expect(path.basename(res.sessionHtmlPath!)).toMatch(
      /^tinker-ui-snapshot\.[A-Za-z0-9_-]{1,65}\.html$/,
    );
    // Nothing landed outside the directory, and nothing landed under an unexpected name.
    for (const entry of await fs.readdir(dir)) {
      expect(entry.startsWith("tinker-ui-snapshot."), `unexpected file ${entry}`).toBe(true);
    }
    // The RAW hostile string still round-trips into the meta — sanitizing the filename must not
    // destroy the evidence of what the caller actually claimed.
    expect(JSON.parse(await fs.readFile(res.sessionMetaPath!, "utf-8")).sessionKey).toBe(hostile);
  });

  it("sanitizes a session key to one inert filename component", () => {
    expect(sanitizeSessionKeyForFilename("agent:main:tinker:mt4ata2g")).toMatch(
      /^agent-main-tinker-mt4ata2g-[0-9a-f]{8}$/,
    );
    expect(sanitizeSessionKeyForFilename("../../etc/passwd")).toMatch(/^etc-passwd-[0-9a-f]{8}$/);
    // 56-char label + "-" + 8 hex.
    expect(sanitizeSessionKeyForFilename("x".repeat(4096))).toHaveLength(65);
    expect(sanitizeSessionKeyForFilename("///")).toBeNull();
    expect(sanitizeSessionKeyForFilename(undefined)).toBeNull();
    expect(sanitizeSessionKeyForFilename(42)).toBeNull();
    // Deterministic: the same key must always resolve to the same file.
    expect(sanitizeSessionKeyForFilename("agent:main:x")).toBe(
      sanitizeSessionKeyForFilename("agent:main:x"),
    );
  });
});

describe("debug.dumpUiSnapshot — payload", () => {
  it("(f) omits the right-panels blob unless includePanels:true", async () => {
    const html = payload("panels");

    const stripped = await writeUiSnapshot({ html, dir });
    const strippedText = await fs.readFile(stripped.htmlPath, "utf-8");
    expect(stripped.panelsIncluded).toBe(false);
    expect(strippedText).not.toContain("amygdala-echo");
    expect(strippedText).toContain('id="messages"');
    expect(strippedText).toContain(SNAPVER); // client-build provenance survives
    // The breadcrumb is the mitigation for the now-stale "grep the whole file and you will match
    // the amygdala panel" playbook: the correction sits in the file the reader is grepping.
    expect(strippedText).toContain("PANELS-OMITTED");
    // The measured split is 449 KB panels / 632 KB total; anything under half is a real cut.
    expect(strippedText.length).toBeLessThan(html.length / 2);

    const full = await writeUiSnapshot({ html, dir, includePanels: true });
    expect(full.panelsIncluded).toBe(true);
    expect(await fs.readFile(full.htmlPath, "utf-8")).toBe(html);
  });

  it("leaves a payload with no CHAT-AREA marker untouched", () => {
    const bare = '<div id="messages">no marker here</div>';
    expect(stripRightPanels(bare)).toBe(bare);
  });

  it("truncates on a code-unit boundary that is not inside a surrogate pair", () => {
    expect(truncateHtml("abcd", 10)).toEqual({ payload: "abcd", truncated: false });
    expect(truncateHtml("abcdef", 4)).toEqual({ payload: "abcd", truncated: true });
    // "abcd" + U+1F600 (a surrogate PAIR occupying code units 4 and 5). Cutting at 5 would orphan
    // the high surrogate, which `writeFile(…, "utf-8")` encodes as U+FFFD.
    const withEmoji = `abcd${String.fromCodePoint(0x1f600)}`;
    expect(truncateHtml(withEmoji, 5)).toEqual({ payload: "abcd", truncated: true });
    // Cutting at 6 keeps the whole pair.
    expect(truncateHtml(withEmoji, 6)).toEqual({ payload: withEmoji, truncated: false });
  });

  it("records the identity and panel decision in the meta", async () => {
    const res = await writeUiSnapshot({
      html: payload("meta"),
      dir,
      url: "http://127.0.0.1:18790/#chat",
      viewport: { w: 1920, h: 1080, dpr: 2 },
      sessionKey: "agent:main:tinker:mt4ata2g",
      tabId: "tab-1",
    });
    const meta = JSON.parse(await fs.readFile(res.metaPath, "utf-8"));
    expect(meta).toMatchObject({
      url: "http://127.0.0.1:18790/#chat",
      viewport: { w: 1920, h: 1080, dpr: 2 },
      sessionKey: "agent:main:tinker:mt4ata2g",
      tabId: "tab-1",
      sessionSlug: res.sessionSlug,
      panelsIncluded: false,
      truncated: false,
    });
    expect(typeof meta.ts).toBe("string");
  });
});
