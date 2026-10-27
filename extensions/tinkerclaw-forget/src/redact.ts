/**
 * Find and redact one file, byte-exact everywhere else.
 *
 * The file is read in chunks and split on "\n". A line that does not match is copied as raw bytes,
 * so formatting, CRLF and a missing last newline all survive. A line that matches is decoded, the
 * fact replaced with the token, and, when the line was JSON before, parsed again: a replacement
 * that would break a JSONL record falls back to rewriting its string values one by one, and a line
 * that still cannot be cleaned is kept and counted as `unredacted` (the receipt says "failed").
 *
 * Writes go to a temp file beside the original and replace it with one rename. If the original
 * changed while it was being read (a live transcript), the pass starts over, up to three times.
 * There is no backup copy: a backup of a forgotten fact is one more copy of it.
 */

import { constants as fsConstants } from "node:fs";
import { chmod, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { FactMatcher } from "./matcher.js";

const CHUNK_BYTES = 1 << 20;
const SNIFF_BYTES = 8192;
const MAX_ATTEMPTS = 3;
const JSON_FILE_VALIDATE_MAX_BYTES = 64 << 20;
const NEWLINE = Buffer.from("\n");

export type FileKind = "text" | "binary";

export type RedactOutcome = {
  /** Lines that held the fact. */
  lines: number;
  /** Matches replaced (or, on a dry run, that would be). */
  copies: number;
  /** Lines that held it and could not be cleaned safely. */
  unredacted: number;
  /** The file was rewritten. */
  wrote: boolean;
};

/** A NUL byte in the first 8 KB marks a binary store (SQLite, vectors); text never has one. */
export async function sniffKind(path: string): Promise<FileKind> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0) ? "binary" : "text";
  } finally {
    await fh.close();
  }
}

/**
 * One read of the file: its kind (from the first 8 KB) and whether its raw bytes hold the fact.
 * Chunks overlap by the longest possible match. A binary store over `maxBinaryBytes` is not read
 * past its first chunk (`holds: null`).
 */
export async function scanFile(
  path: string,
  matcher: FactMatcher,
  maxBinaryBytes = Number.POSITIVE_INFINITY,
): Promise<{ kind: FileKind; holds: boolean | null }> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let carry = "";
    let pos = 0;
    let kind: FileKind = "text";
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK_BYTES, pos);
      if (bytesRead <= 0) {
        return { kind, holds: false };
      }
      if (pos === 0) {
        kind = buf.subarray(0, Math.min(bytesRead, SNIFF_BYTES)).includes(0) ? "binary" : "text";
        if (kind === "binary" && (await fh.stat()).size > maxBinaryBytes) {
          return { kind, holds: null };
        }
      }
      const text = carry + buf.toString("latin1", 0, bytesRead);
      if (matcher.scan.test(text)) {
        return { kind, holds: true };
      }
      carry = text.slice(-matcher.maxBytes);
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}

/** True when the file's raw bytes hold the fact anywhere. */
export async function fileHolds(path: string, matcher: FactMatcher): Promise<boolean> {
  return (await scanFile(path, matcher)).holds === true;
}

function deepReplace(value: unknown, re: RegExp, token: string): unknown {
  if (typeof value === "string") {
    return value.replace(re, token);
  }
  if (Array.isArray(value)) {
    return value.map((v) => deepReplace(v, re, token));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.replace(re, token)] = deepReplace(v, re, token);
    }
    return out;
  }
  return value;
}

function parses(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

/** One matching line → its clean form, or null when it cannot be cleaned without breaking it. */
function cleanLine(line: string, matcher: FactMatcher, token: string): string | null {
  const replaced = line.replace(matcher.replace, token);
  const trimmed = line.trimStart();
  const jsonish = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!jsonish || parses(replaced) || !parses(line)) {
    return matcher.scan.test(Buffer.from(replaced, "utf8").toString("latin1")) ? null : replaced;
  }
  // The fact was a bare JSON value ({"phone":600111222}): the token goes in as a string.
  const quoted = line.replace(matcher.replace, JSON.stringify(token));
  if (parses(quoted) && !matcher.scan.test(Buffer.from(quoted, "utf8").toString("latin1"))) {
    return quoted;
  }
  const walked = JSON.stringify(deepReplace(JSON.parse(line), matcher.replace, token));
  return matcher.scan.test(Buffer.from(walked, "utf8").toString("latin1")) ? null : walked;
}

type Pass = { outcome: RedactOutcome; tmp: string | null };

async function onePass(
  path: string,
  matcher: FactMatcher,
  token: string,
  dryRun: boolean,
): Promise<Pass> {
  const outcome: RedactOutcome = { lines: 0, copies: 0, unredacted: 0, wrote: false };
  const src = await open(path, "r");
  const tmp = dryRun ? null : join(dirname(path), `.${basename(path)}.forget-${process.pid}.tmp`);
  const dst = tmp
    ? await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600)
    : null;
  const queued: Buffer[] = [];
  let queuedBytes = 0;
  const flush = async () => {
    if (dst && queued.length > 0) {
      await dst.write(Buffer.concat(queued));
    }
    queued.length = 0;
    queuedBytes = 0;
  };
  try {
    const buf = Buffer.alloc(CHUNK_BYTES);
    let pending: Buffer = Buffer.alloc(0);
    let pos = 0;
    const handle = (line: Buffer, eol: boolean) => {
      const latin = line.toString("latin1");
      let out: Buffer = line;
      if (matcher.scan.test(latin)) {
        const text = line.toString("utf8");
        const copies = countMatches(text, matcher.replace);
        outcome.lines += 1;
        outcome.copies += Math.max(copies, 1);
        const clean = cleanLine(text, matcher, token);
        if (clean === null) {
          outcome.unredacted += 1;
        } else {
          out = Buffer.from(clean, "utf8");
        }
      }
      if (dst) {
        queued.push(eol ? Buffer.concat([out, NEWLINE]) : out);
        queuedBytes += out.length + 1;
      }
    };
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, CHUNK_BYTES, pos);
      if (bytesRead <= 0) {
        break;
      }
      pos += bytesRead;
      let data = Buffer.concat([pending, buf.subarray(0, bytesRead)]);
      let nl = data.indexOf(0x0a);
      while (nl >= 0) {
        handle(data.subarray(0, nl), true);
        data = data.subarray(nl + 1);
        nl = data.indexOf(0x0a);
      }
      pending = Buffer.from(data);
      if (queuedBytes >= CHUNK_BYTES) {
        await flush();
      }
    }
    if (pending.length > 0) {
      handle(pending, false);
    }
    await flush();
  } finally {
    await src.close();
    await dst?.close();
  }
  return { outcome, tmp };
}

/**
 * Redact every copy of the fact in one text file. `dryRun` counts and writes nothing. A file that
 * does not hold it is never rewritten.
 */
export async function redactFile(
  path: string,
  matcher: FactMatcher,
  token: string,
  opts: { dryRun: boolean },
): Promise<RedactOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const before = await stat(path);
    const { outcome, tmp } = await onePass(path, matcher, token, opts.dryRun || false);
    if (!tmp) {
      return outcome;
    }
    if (outcome.lines === 0 || outcome.lines === outcome.unredacted) {
      await rm(tmp, { force: true });
      return outcome;
    }
    if (path.endsWith(".json") && before.size <= JSON_FILE_VALIDATE_MAX_BYTES) {
      const [was, now] = await Promise.all([readFile(path, "utf8"), readFile(tmp, "utf8")]);
      if (parses(was) && !parses(now)) {
        await rm(tmp, { force: true });
        return { ...outcome, unredacted: outcome.lines };
      }
    }
    const after = await stat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      await rm(tmp, { force: true });
      if (attempt >= MAX_ATTEMPTS) {
        return { ...outcome, unredacted: outcome.lines };
      }
      continue;
    }
    await chmod(tmp, before.mode & 0o7777);
    await rename(tmp, path);
    return { ...outcome, wrote: true };
  }
}
