// FORK 2026-08-19 (the architect: classify items so a skim tells you if you must
// answer, act, just read, or skip). The colored circle was a machine kind
// (FLAG/CHANGED). The tag is a human verb. Display maps both the new tokens
// and the leftover FLAG/CHANGED kinds sitting on tonight's boards.

export type CronSkimTag = "ask" | "act" | "watch" | "broke" | "found" | "fyi";

export const CRON_SKIM: Record<CronSkimTag, { label: string; hint: string }> = {
  ask: { label: "Ask", hint: "Needs an answer from you" },
  act: { label: "Act", hint: "Do something — not just read" },
  watch: { label: "Watch", hint: "A warning. Read it. Not tonight-urgent." },
  broke: { label: "Broke", hint: "Something failed" },
  found: { label: "Found", hint: "A discovery or a lesson" },
  fyi: { label: "FYI", hint: "Just so you know. No fuss." },
};

const KIND_PREFIX =
  /^\s*(ASK|ACT|WATCH|BROKE|FOUND|FYI|FLAG|CHANGED|REALIZED|DEAD|FAILED|NOTE|SHIPPED|QUERY|WARN|WARNING)\s*:\s*/i;

export function stripCronKindPrefix(text: string): string {
  return text.replace(KIND_PREFIX, "").trim();
}

/**
 * Collapsed-card chrome. LEFT is the cron's registry name (loud, stable).
 * RIGHT is the beginning of what the prompt asks it to do (quiet, also
 * stable) — never tonight's report headline. Findings live in the items.
 *
 * 2026-08-22: an earlier cut inverted these slots (headline left, name
 * right). the architect: "the name of the cron on the left … beginning of summary
 * on the right … not a summary of the issues found, but a summary of what
 * the actual prompt of the cron is asking it to do."
 */
export function cronCardChrome(job: { name: string; description?: string }): {
  name: string;
  promptSkim: string;
} {
  const name = job.name.trim();
  const raw = (job.description ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { name, promptSkim: "" };
  const sentence = /^(.{12,80}?[.!?])(?:\s|$)/.exec(raw);
  const skim = sentence?.[1]?.trim() ?? (raw.length <= 80 ? raw : `${raw.slice(0, 77).trimEnd()}…`);
  return { name, promptSkim: skim };
}

export function cronSkimTag(kind: string): CronSkimTag {
  switch (kind.toLowerCase()) {
    case "ask":
    case "query":
    case "question":
      return "ask";
    case "act":
    case "flag":
      return "act";
    case "watch":
    case "warn":
    case "warning":
      return "watch";
    case "broke":
    case "failed":
    case "fail":
      return "broke";
    case "found":
    case "realized":
    case "dead":
    case "discovery":
      return "found";
    default:
      return "fyi";
  }
}

function looksLikePath(s: string): boolean {
  const t = s.trim().replace(/^[`'"]+|[`'"]+$/g, "");
  if (!t) return false;
  if (/^(memory|scripts|skills|docs|sessions|src|extensions|tinker-ui)\//.test(t)) return true;
  if ((t.startsWith("~") || t.startsWith("/")) && /\.\w{1,8}$/.test(t)) return true;
  if (/^[a-z0-9._-]+\.(md|json|txt|ts|js|html)$/i.test(t)) return true;
  if (/[\/\\]/.test(t) && /\.(md|json|txt|ts|js|html)\b/i.test(t)) return true;
  return false;
}

export function pathToFsLink(raw: string): string {
  const cleaned = raw.replace(/^[`'"]+|[`'"]+$/g, "").trim();
  if (!cleaned) return "";
  if (cleaned.startsWith("~") || cleaned.startsWith("/")) return `\`${cleaned}\``;
  if (/^(memory|scripts|skills|docs)\//.test(cleaned)) {
    return `\`~/.openclaw/workspace/${cleaned}\``;
  }
  return `\`${cleaned}\``;
}

const BARE_PATH =
  /(?:~\/|\/(?:home|usr|tmp|var|opt|etc)\/|(?:memory|scripts|skills|docs|sessions|src|extensions|tinker-ui)\/)[\w.@%+,'#~\/-]+(?:\.[A-Za-z0-9]{1,8})?/g;

function stripPathsFromTitle(title: string): { title: string; paths: string[] } {
  const paths: string[] = [];
  let next = title.replace(/`([^`]+)`/g, (_m, p: string) => {
    paths.push(p);
    return " ";
  });
  next = next.replace(BARE_PATH, (p) => {
    paths.push(p);
    return " ";
  });
  next = next
    .replace(/\s+(?:to|in|at|from|into|onto)\s*$/i, "")
    .replace(/^[—–:,;.\s-]+|[—–:,;.\s-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { title: next, paths };
}

function firstSentence(text: string): string {
  const m = /^(.{8,80}?[.!?])(?:\s|$)/.exec(text.trim());
  if (m?.[1]) return m[1].replace(/[.!?]$/, "").trim();
  const line = text.trim().split(/\n/)[0] ?? "";
  return line.length <= 80 ? line : `${line.slice(0, 77).trimEnd()}…`;
}

export function parseCronItemText(text: string): { title: string; body: string } {
  const stripped = stripCronKindPrefix(text);
  if (!stripped) return { title: "", body: "" };

  let title: string;
  let body: string;
  const nl = stripped.search(/\r?\n/);
  if (nl >= 0) {
    title = stripped.slice(0, nl).trim();
    body = stripped.slice(nl + 1).trim();
  } else {
    const sentence = /^(.{8,80}?[.!?])\s+(\S[\s\S]+)$/.exec(stripped);
    if (sentence?.[1] && sentence[2]) {
      title = sentence[1].trim();
      body = sentence[2].trim();
    } else {
      title = stripped;
      body = "";
    }
  }

  const pulled = stripPathsFromTitle(title);
  const leftoverPaths = pulled.paths;
  title = pulled.title;

  if (!title || looksLikePath(title)) {
    const pathBits = looksLikePath(title) ? [title, ...leftoverPaths] : leftoverPaths;
    if (body) {
      title = firstSentence(body) || "Something to read";
    } else {
      title = "Something to read";
    }
    leftoverPaths.length = 0;
    leftoverPaths.push(...pathBits);
  }

  if (title.length > 80) title = `${title.slice(0, 77).trimEnd()}…`;

  const pathBlock = leftoverPaths
    .filter(Boolean)
    .map((p) => pathToFsLink(p))
    .join(" ");
  if (pathBlock) body = body ? `${body}\n\n${pathBlock}` : pathBlock;

  return { title, body };
}
