/**
 * The fact to forget, as regular expressions.
 *
 * Two shapes. A number (a phone, an account, an id: digits with spaces, dots, dashes, brackets
 * or a leading +) matches its digits with any of those separators between them, and never inside
 * a longer run of digits, so "+34 600 11 12 22" also finds "600111222" written another way only
 * if the caller passes that spelling as a variant. Anything else matches as text, case-insensitive,
 * any run of whitespace for a space, and not inside a longer word.
 *
 * Each shape is built twice: `scan` tests raw bytes decoded as latin1 (fast, never splits a
 * multi-byte character, safe on any file), `replace` rewrites decoded UTF-8 text.
 */

const MIN_VISIBLE_CHARS = 4;
const MAX_FACT_CHARS = 300;
const MIN_NUMBER_DIGITS = 6;
const NUMBER_SHAPE = /^[+\d\s().-]+$/;
const NUMBER_GAP = "[\\s().\\-]{0,3}";

export type FactKind = "text" | "number";

export type FactMatcher = {
  kind: FactKind;
  /** How many spellings the matcher covers (the fact plus its variants, deduplicated). */
  variants: number;
  /** Tests one latin1-decoded chunk of raw bytes. Not global: `test` keeps no state. */
  scan: RegExp;
  /** Rewrites UTF-8 text. Global. */
  replace: RegExp;
  /** Literal strings for `git log -S`, which cannot take our regexes. */
  literals: string[];
  /** Upper bound on one match's length in bytes, for the overlap between scanned chunks. */
  maxBytes: number;
};

export class FactError extends Error {}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNumberLike(fact: string): boolean {
  return NUMBER_SHAPE.test(fact) && fact.replace(/\D/g, "").length >= MIN_NUMBER_DIGITS;
}

function numberPattern(fact: string): string {
  const digits = fact.replace(/\D/g, "");
  const plus = fact.trimStart().startsWith("+") ? "\\+?" : "";
  return `(?<![\\d])${plus}${digits.split("").join(NUMBER_GAP)}(?![\\d])`;
}

function textPattern(fact: string): string {
  const words = fact.split(/\s+/).filter(Boolean).map(escapeRegExp);
  const body = words.join("\\s+");
  const head = /^[\p{L}\p{N}_]/u.test(fact) ? "(?<![\\p{L}\\p{N}_])" : "";
  const tail = /[\p{L}\p{N}_]$/u.test(fact) ? "(?![\\p{L}\\p{N}_])" : "";
  return `${head}${body}${tail}`;
}

/** The fact as it sits inside a JSON string, when that differs from the fact itself. */
function jsonEscaped(fact: string): string | null {
  const escaped = JSON.stringify(fact).slice(1, -1);
  return escaped === fact ? null : escaped;
}

function toLatin1(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

/** Trim, collapse whitespace, and refuse what would match too much or nothing useful. */
export function normalizeFact(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new FactError("the fact must be a string");
  }
  const fact = raw.trim().replace(/\s+/g, " ");
  if (fact.replace(/\s/g, "").length < MIN_VISIBLE_CHARS) {
    throw new FactError(`the fact needs at least ${MIN_VISIBLE_CHARS} characters`);
  }
  if (fact.length > MAX_FACT_CHARS) {
    throw new FactError(
      `the fact is longer than ${MAX_FACT_CHARS} characters; forget a shorter part of it`,
    );
  }
  return fact;
}

export function buildMatcher(fact: string, variants: readonly string[] = []): FactMatcher {
  const spellings = [...new Set([fact, ...variants].map(normalizeFact))];
  const kind: FactKind = isNumberLike(spellings[0]) ? "number" : "text";
  const scanParts: string[] = [];
  const replaceParts: string[] = [];
  const literals = new Set<string>();
  let maxBytes = 0;
  for (const s of spellings) {
    const forms = [s, jsonEscaped(s)].filter((f): f is string => f !== null);
    for (const form of forms) {
      const pattern = isNumberLike(form) ? numberPattern : textPattern;
      scanParts.push(pattern(toLatin1(form)));
      replaceParts.push(pattern(form));
      maxBytes = Math.max(maxBytes, Buffer.byteLength(form) * 4);
    }
    literals.add(s);
    if (isNumberLike(s)) {
      literals.add(s.replace(/\D/g, ""));
    }
  }
  return {
    kind,
    variants: spellings.length,
    scan: new RegExp(scanParts.map((p) => `(?:${p})`).join("|"), "iu"),
    replace: new RegExp(replaceParts.map((p) => `(?:${p})`).join("|"), "giu"),
    literals: [...literals],
    maxBytes: maxBytes + 64,
  };
}

/** What a forgotten copy becomes. Plain ASCII, so it is safe inside JSON and Markdown alike. */
export function forgottenToken(date: Date): string {
  return `[forgotten ${date.toISOString().slice(0, 10)}]`;
}
