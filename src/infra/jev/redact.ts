/**
 * Redaction for anything that leaves the machine toward Jev (design doc 1 C9, paper 7.3).
 *
 * MOVED from the amygdala extension (`extensions/tinkerclaw-amygdala/src/redact.ts`) with no change to a rule, so that
 * THALAMUS v4's standalone reads redact a tool's arguments with the very same code (phase H2). An extension cannot import
 * another extension, so the text and value redaction live in core and are published through `openclaw/plugin-sdk/fork-jev`.
 * The amygdala keeps `SendBlocked` and `redactForSend` (they are about ITS situation and questions) and imports these.
 */

export type TextOpts = { contactNames?: string[]; homeDir?: string };

const CONTENT_KEYS = new Set(["content", "new_string", "old_string"]);
/** Keys whose (long) strings are commands or paths and keep their text. */
const VERBATIM_KEYS = new Set(["command", "path", "file_path", "resolvedFrom", "notebook_path"]);
const LONG_TEXT = 400;
/**
 * Free text the judge must read to answer at all (a refusal, a claim, the request): a long value goes as a redacted
 * excerpt, head and tail, instead of just its length. Before 2026-09-30 an 866-character refusal reached Jev as
 * `{redacted: "text", len: 866}`, so the refusal question could not be answered.
 */
const EXCERPT_KEYS = new Set(["reply", "request"]);
const EXCERPT_HEAD = 300;
const EXCERPT_TAIL = 100;

function excerpt(text: string): string {
  if (text.length <= EXCERPT_HEAD + EXCERPT_TAIL) return text;
  const cut = text.length - EXCERPT_HEAD - EXCERPT_TAIL;
  return `${text.slice(0, EXCERPT_HEAD)} […${cut} chars…] ${text.slice(-EXCERPT_TAIL)}`;
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN ([A-Z ]+)-----[\s\S]*?-----END \1-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
];

const URL_RE =
  /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/?#@"'<>]*@)?([^\s/?#"'<>]*)([^\s?#"'<>]*)(\?[^\s#"'<>]*)?/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE_INTL_RE = /(?<![\w])(?:\+|00)\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?!\d)/g;
const PHONE_ES_RE =
  /(?<![\d\w.])[6-9]\d{2}(?:[ .-]?\d{3}[ .-]?\d{3}|[ .-]?\d{2}[ .-]?\d{2}[ .-]?\d{2})(?!\d)/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function label(labels: Map<string, string>, kind: string, raw: string): string {
  const key = `${kind}:${raw.toLowerCase()}`;
  const have = labels.get(key);
  if (have) {
    return have;
  }
  let n = 1;
  for (const k of labels.keys()) {
    if (k.startsWith(`${kind}:`)) {
      n++;
    }
  }
  const l = `${kind} ${n}`;
  labels.set(key, l);
  return l;
}

export function redactText(
  text: string,
  o: TextOpts,
  labels: Map<string, string> = new Map(),
): string {
  let s = text;
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, "[secret]");
  }
  s = s.replace(
    URL_RE,
    (_m, scheme: string, host: string, pathPart: string, query?: string) =>
      `${scheme}://${host}${pathPart}${query ? "?[redacted]" : ""}`,
  );
  s = s.replace(EMAIL_RE, (m) => label(labels, "Address", m));
  s = s.replace(PHONE_INTL_RE, (m) => label(labels, "Phone", m.replace(/\D/g, "")));
  s = s.replace(PHONE_ES_RE, (m) => label(labels, "Phone", m.replace(/\D/g, "")));
  if (o.homeDir) {
    const home = o.homeDir.replace(/\/+$/, "");
    if (home.length > 0) {
      s = s.replace(new RegExp(`${escapeRe(home)}(?=[/\\s"'\\\\]|$)`, "g"), "~");
    }
  }
  const names = [...(o.contactNames ?? [])]
    .filter((n) => n.trim().length > 0)
    .toSorted((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name.trim())}(?![\\p{L}\\p{N}_])`, "giu");
    s = s.replace(re, (m) => label(labels, "Person", m));
  }
  return s;
}

export function redactValue(
  v: unknown,
  o: TextOpts,
  labels: Map<string, string>,
  key: string | null,
): unknown {
  if (typeof v === "string") {
    if (key !== null && CONTENT_KEYS.has(key)) {
      return {
        redacted: "content",
        bytes: Buffer.byteLength(v, "utf-8"),
        lines: v.split("\n").length,
      };
    }
    if (key !== null && EXCERPT_KEYS.has(key) && v.length > LONG_TEXT) {
      // Redact the whole text first, then cut: a cut through a secret must not leave half of it unmatched.
      return excerpt(redactText(v, o, labels));
    }
    if (v.length > LONG_TEXT && !(key !== null && VERBATIM_KEYS.has(key))) {
      return { redacted: "text", len: v.length };
    }
    return redactText(v, o, labels);
  }
  if (Array.isArray(v)) {
    return v.map((x) => redactValue(x, o, labels, key));
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = redactValue(x, o, labels, k);
    }
    return out;
  }
  return v;
}
