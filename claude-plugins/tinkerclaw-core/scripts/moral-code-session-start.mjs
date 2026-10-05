#!/usr/bin/env node
/**
 * Claude Code SessionStart hook (startup | clear | compact): hand the TinkerClaw moral
 * code to the model as session context — once at the start of a conversation and again
 * after every compaction.
 *
 * It reads the pack the gateway's tinkerclaw-moral-code plugin materializes at
 * <state dir>/moral-code/moral-code.md, so it costs milliseconds and needs no running
 * gateway. No dependencies, by design: this runs on every new session.
 *
 * FORK 2026-09-23 — this is a SYMLINK to TinkerClaw, not a second owner. It never builds,
 * edits or decides the content; it only knows WHEN Claude's own context starts over. The file
 * is TinkerClaw's published contract (src/moral-code/contract.ts): the gateway withdraws it
 * when its moral code is off, and then this hook delivers nothing — the same as every other
 * model. (A `tinkerclaw` CLI call would be the literal symlink, but a plugin subcommand takes
 * ~11.6 s to start, over this hook's 10 s budget; measured 2026-09-23.)
 *
 * FORK 2026-10-02 (the owner: "Fix the moral code to be injected, in full, at the creation and
 * after compaction") — ONE PART PER INVOCATION. hooks.json runs this PART_SLOTS times, with
 * `--part 1` … `--part N`: the claude CLI cuts any hook additionalContext over 10,000 chars to a
 * ~2 KB preview, and until this change the whole ~40k pack went out as one, so the model got the
 * preview. Each slot now prints part i of the pack (moral-code-parts.mjs), every part a complete
 * block under the cap; a slot past the last part prints nothing.
 *
 * The same plugin can be loaded twice in one session (installed from the marketplace AND
 * passed with --plugin-dir by the Tinker bridge), which fires every slot twice. The first
 * invocation claims session+source+part with an exclusive lock file; the second stays silent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PART_SLOTS, splitMoralCode } from "./moral-code-parts.mjs";

const DEDUPE_WINDOW_MS = 10_000;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function stateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  }
  return path.join(os.homedir(), ".openclaw");
}

/** The slot this invocation fills: `--part <n>`, 1-based (no flag: part 1). */
function partArg() {
  const at = process.argv.indexOf("--part");
  const n = at >= 0 ? Number(process.argv[at + 1]) : 1;
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** True for the first invocation per session+source+part inside the window. */
function claim(sessionId, source, part) {
  if (!sessionId) {
    return true;
  }
  const dir = path.join(os.tmpdir(), "tinkerclaw-moral-code");
  const bucket = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
  const safe = `${sessionId}-${source}-p${part}-${bucket}`.replace(/[^A-Za-z0-9_-]/g, "_");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    return err?.code !== "EEXIST";
  }
}

const input = readStdin();
const source = typeof input.source === "string" ? input.source : "startup";
const part = partArg();
if (!claim(input.session_id, source, part)) {
  process.exit(0);
}

const packPath = path.join(stateDir(), "moral-code", "moral-code.md");
let pack = "";
try {
  pack = fs.readFileSync(packPath, "utf8").trim();
} catch {
  if (part === 1) {
    process.stderr.write(
      `tinkerclaw-core: no moral code published at ${packPath} — TinkerClaw owns it: enable the tinkerclaw-moral-code plugin and start the gateway once\n`,
    );
  }
  process.exit(0);
}
if (!pack) {
  process.exit(0);
}

const { parts } = splitMoralCode(pack);
if (part === PART_SLOTS && parts.length > PART_SLOTS) {
  // Never silent: the parts past the last slot are not delivered, and the resume check
  // (contract.ts moralCodeDeliveredIn) will not count this set as complete.
  process.stderr.write(
    `tinkerclaw-core: the moral code needs ${parts.length} parts and hooks.json has ${PART_SLOTS} slots — parts ${PART_SLOTS + 1}..${parts.length} were NOT delivered; add slots\n`,
  );
}
if (part > parts.length) {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: parts[part - 1] },
  }),
);
