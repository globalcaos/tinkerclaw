/**
 * The one sentence the owner reads about a step that waits for him (2026-11-01): what changes, what cannot be undone, and
 * why it stopped. Built by code from the step's effect and the short names of its targets and scripts, so no command text
 * can reach him.
 */
import { stripHeredocs } from "./effect-class.js";
import { RULE_WORDS } from "./rules.js";
import type { Decision, EffectClass, ResolvedTarget, Situation } from "./types.js";

const WHAT: Record<EffectClass, (name: string | null) => string> = {
  delete: (n) => `This deletes ${n ?? "a file"}`,
  send: (n) => `This sends ${n ? `data to ${n}` : "data out of this machine"}`,
  spend: () => "This spends money",
  "restart-own-system": () => "This restarts the assistant's own service",
  "local-write": (n) => `This changes ${n ?? "a file"}`,
  other: (n) => `This runs a step on ${n ?? "this machine"}`,
  read: (n) => `This reads ${n ?? "a file"}`,
};

const UNDO: Record<EffectClass, string> = {
  delete: "it cannot be undone",
  send: "what is sent cannot be called back",
  spend: "the money cannot be taken back",
  "restart-own-system": "open chats pause until it is back",
  "local-write": "the earlier version is lost unless it was saved",
  other: "its effect may not be reversible",
  read: "nothing is lost",
};

/** Checked in this order: the most specific reason a step stopped comes first, the generic danger reading last. */
const WHY: readonly (readonly [string, string])[] = [
  ["weakens-own-check", "it may loosen a test that grades the agent's own work"],
  ["instruction-source", "the instruction came from something it read, not from you"],
  ["same-goal-as-held", "it retries a step that is already held"],
  [
    "first-contact",
    "it is the first message to this chat in 90 days, so check it is the right person",
  ],
  ["stops-own-system", "it would interrupt the assistant itself"],
  ["repeat-effect", "the same thing already ran in this task"],
  ["data-tier", "private data would go somewhere others can read it"],
  ["destination-privacy", "private data would go somewhere others can read it"],
  ["recent-investment", "that file holds recent work"],
  ["excess-scope", "it goes beyond what you asked"],
  ["fallback-level3", "the checker is out and this step is hard to reverse"],
];

const NAME_MAX = 40;

function nameOf(t: ResolvedTarget): string {
  if (t.kind === "url") {
    try {
      return new URL(t.path).host || t.path;
    } catch {
      return t.path;
    }
  }
  return t.path.replace(/\/+$/, "").split("/").pop() || t.path;
}

const short = (n: string): string => (n.length > NAME_MAX ? `${n.slice(0, NAME_MAX - 1)}…` : n);

function thing(targets: readonly ResolvedTarget[]): string | null {
  const first = targets[0];
  if (!first) return null;
  const name = short(nameOf(first));
  return targets.length > 1 ? `${name} and ${targets.length - 1} more` : name;
}

/** A script a step runs: after an interpreter, or by its own path at the head of a command. */
const RUNS_SCRIPT =
  /(?:\b(?:python3?|bash|sh|node|tsx)\s+(?:-\S+\s+)*|(?:^|[;&|(]\s*))([$~./\w-]*[\w-]\.(?:py|sh|mjs|cjs|js|ts))(?=[\s;&|)]|$)/gm;

const SCRIPTS_NAMED = 3;

/**
 * What an `other` step runs, in order. Its first target can be a scratch folder, and on 11-01 22:40 the card said only that
 * while the step ran a preview of a post to a group, so the owner's Allow rested on nothing he could read.
 */
function scriptsRun(command: string | null | undefined): string {
  const all = [...stripHeredocs(command ?? "").matchAll(RUNS_SCRIPT)];
  const names = [...new Set(all.map((m) => short(m[1].split("/").pop() ?? m[1])))];
  const shown = names.slice(0, SCRIPTS_NAMED);
  if (names.length > SCRIPTS_NAMED) {
    return `${shown.join(", ")} and ${names.length - SCRIPTS_NAMED} more`;
  }
  return shown.length < 2
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

const DELETE_WORD =
  /\b(?:rm|rmdir|unlink|shred|trash|git\s+(?:-C\s+\S+\s+)?worktree\s+remove)\s+(?:-\S+\s+)*([^\s;&|]+)/;

/**
 * What deleted files are and what they were for (2026-11-04): a path or a stock "these files" does not tell the owner
 * what he is letting go of, so a delete is described by its kind of file and where it comes from.
 */
const FILE_KIND: readonly (readonly [RegExp, string, string])[] = [
  [/\.(?:png|jpe?g|gif|webp|svg|heic|bmp)$/i, "image", "images"],
  [/\.(?:pdf|docx?|odt|pptx?|xlsx?|ods)$/i, "document", "documents"],
  [/\.(?:md|txt)$/i, "text file", "text files"],
  [/\.log$/i, "log file", "log files"],
  [/\.(?:py|sh|ts|js|mjs|cjs)$/i, "script", "scripts"],
  [/\.(?:json|jsonl|csv|db|sqlite)$/i, "data file", "data files"],
  [/\.(?:zip|tar|gz|tgz|xz|7z)$/i, "archive", "archives"],
  [/\.(?:mp4|mov|mkv|webm)$/i, "video", "videos"],
  [/\.(?:mp3|wav|ogg|m4a|opus)$/i, "recording", "recordings"],
];

const WORKTREE = /\/(?:tc-worktrees|\.worktrees)\/(?:wt-)?([^/]+)\/?$/;

/** Where a deleted file comes from, checked in order; the first match says what it was for. */
const PURPOSE: readonly (readonly [RegExp, (m: RegExpExecArray) => string])[] = [
  [/\/(?:node_modules|__pycache__)(?:\/|$)|\/\.cache\//, () => "from a cache that rebuilds itself"],
  [/^\/tmp\/jarvis\/([^/]+)\//, (m) => `scratch from the assistant's task "${short(m[1])}"`],
  [/^\/tmp\//, () => "temporary scratch"],
  [/\/\.openclaw\/media\//, () => "temporary, in the assistant's media folder"],
  [
    /^\/home\/[^/]+\/(Documents|Pictures|Downloads|Desktop|Videos|Music)\//,
    (m) => `from your ${m[1]} folder`,
  ],
  [/\/\.openclaw\//, () => "from the assistant's own data"],
  [/\/src\/([^/]+)\//, (m) => `in the ${short(m[1])} code`],
];

function kindOf(t: ResolvedTarget): readonly [string, string] {
  if (t.kind === "dir") return ["folder", "folders"];
  const hit = FILE_KIND.find(([re]) => re.test(t.path));
  return hit ? [hit[1], hit[2]] : ["file", "files"];
}

function purposeOf(path: string): string {
  for (const [re, say] of PURPOSE) {
    const m = re.exec(path);
    if (m) return say(m);
  }
  const parent = path.replace(/\/+$/, "").split("/").slice(-2, -1)[0];
  return parent ? `in the folder "${short(parent)}"` : "on this machine";
}

/** "an image, temporary, in the assistant's media folder"; "3 log files, from your Documents folder". */
function deletedWhat(named: readonly ResolvedTarget[]): string | null {
  const first = named[0];
  if (!first) return null;
  const more = named.length > 1 ? ` and ${named.length - 1} more` : "";
  const wt = WORKTREE.exec(first.path);
  if (wt) return `the spare copy of the code where "${short(wt[1])}" was built${more}`;
  const kinds = named.map(kindOf);
  const [one, many] = kinds.every((k) => k[0] === kinds[0][0]) ? kinds[0] : ["file", "files"];
  const noun =
    named.length === 1 ? `${/^[aeiou]/.test(one) ? "an" : "a"} ${one}` : `${named.length} ${many}`;
  return `${noun}, ${purposeOf(first.path)}`;
}

/** A compound step lists all it touches, so its first target can be a folder it creates: a delete opens on what it deletes. */
function deletedFirst(
  targets: readonly ResolvedTarget[],
  command: string | null | undefined,
): readonly ResolvedTarget[] {
  const word = DELETE_WORD.exec(command ?? "")?.[1];
  const hit = targets.find((t) => t.resolvedFrom === word);
  return hit ? [hit, ...targets.filter((t) => t !== hit)] : targets;
}

function reason(d: Decision, drivers: readonly string[]): string {
  const r = d.response;
  const ids = [...drivers, ...(r.kind === "hold" ? [r.ruleOrQuestion] : [])];
  for (const [id, why] of WHY) if (ids.includes(id)) return why;
  if (d.family === "hard-rule") return "a fixed safety rule covers it";
  return r.kind === "ask"
    ? "your request can be read more than one way"
    : "it looks hard to reverse";
}

/** The step's effect, what it names first and the scripts it runs: shared by the sentence and the question. */
function parts(s: Situation): {
  effect: EffectClass;
  targets: readonly ResolvedTarget[];
  scripts: string;
  label: string | null;
} {
  const effect = s.effectClass.value ?? "other";
  const targets = s.targets.value ?? [];
  const named = effect === "delete" ? deletedFirst(targets, s.command?.value) : targets;
  const scripts = effect === "other" ? scriptsRun(s.command?.value) : "";
  // A delete says what the files are and what they were for: neither a name nor a path tells the owner what he lets go of.
  const label = effect === "delete" && named[0]?.kind !== "url" ? deletedWhat(named) : thing(named);
  return { effect, targets, scripts, label };
}

export function plainStep(s: Situation, d: Decision, drivers: readonly string[]): string {
  const { effect, scripts, label } = parts(s);
  const what = scripts ? `This runs ${scripts}` : WHAT[effect](label);
  return `${what}, and ${UNDO[effect]}, because ${reason(d, drivers)}.`;
}

/**
 * Outward acts named by what they do (2026-11-03), checked before the effect class: the classifier reads a script that
 * publishes a post as "runs a script", and the owner decides on where the data goes. Display only; nothing gates on it.
 */
const OUTWARD: readonly (readonly [RegExp, string])[] = [
  [/\bWP_ALLOW_PUBLISH=1\b|\bwp\.sh\s+(?:POST|PUT|PATCH|DELETE)\b/, "publishing to the web"],
  [/\bclawhub\s+publish\b/, "publishing to ClawHub"],
  [/\bnpm\s+publish\b/, "publishing to npm"],
  [/slack-send|chat\.postMessage/, "posting to Slack"],
  [/\bgh\s+(?:pr|issue|release)\s+(?:create|comment)\b/, "posting to GitHub"],
  [/\bgit\s+(?:-C\s+\S+\s+)?push\b/, "pushing to git"],
  [/\bwacli\s+send\b|\bmessage\s+send\b/, "sending a message"],
  [/\b(?:sendmail|msmtp|mutt)\b|\bgmail\s+send\b/, "sending an email"],
];

/** What an Allow lets happen, as the end of "Allow …?". */
const ASK: Record<EffectClass, (name: string | null) => string> = {
  delete: (n) => `deleting ${n ?? "a file"}`,
  send: (n) => (n ? `sending data to ${n}` : "sending data out of this machine"),
  spend: () => "spending money",
  "restart-own-system": () => "restarting the assistant",
  "local-write": (n) => `changing ${n ?? "a file"}`,
  other: (n) => `running a step on ${n ?? "this machine"}`,
  read: (n) => `reading ${n ?? "a file"}`,
};

const OUTSIDE: ReadonlySet<ResolvedTarget["kind"]> = new Set(["url", "host", "address"]);

/** The stored secret a command names (`laptop-sudo.secret`, `.env`, `credentials.json`), or null. */
function secretName(command: string): string | null {
  const m =
    /([\w.-]*\.secret|\.env(?:\.[\w-]+)?|credentials[\w.-]*|id_(?:rsa|dsa|ecdsa|ed25519))\b/.exec(
      command,
    );
  return m ? short(m[1]) : null;
}

/**
 * The owner's Allow question for a step that waits for him (2026-11-03): one specific question in place of a card. A
 * fixed rule asks its own (rules.ts `RULE_WORDS`); otherwise a known outward act, then the step's effect.
 */
export function plainAsk(s: Situation, d: Decision): string {
  const { effect, targets, scripts, label } = parts(s);
  const r = d.response;
  const command = stripHeredocs(s.command?.value ?? "");
  const id = r.kind === "hold" && d.family === "hard-rule" ? r.ruleOrQuestion : "";
  const rule = RULE_WORDS[id];
  if (rule) {
    // A delete rule describes what it deletes even when the step was classed as something else (a worktree removal).
    const target = /SECRET|CREDENTIAL/.test(id)
      ? secretName(command)
      : effect === "delete"
        ? label
        : /DELETE/.test(id)
          ? deletedWhat(
              deletedFirst(
                targets.filter((t) => t.kind !== "url"),
                command,
              ),
            )
          : null;
    return rule.ask.replace("{target}", target ?? rule.noun ?? "it");
  }
  const outward = OUTWARD.find(([re]) => re.test(command))?.[1];
  if (outward) return `Allow ${outward}?`;
  // A send names where the data goes, not the first file it reads.
  const dest = targets.find((t) => OUTSIDE.has(t.kind));
  const name = effect === "send" ? (dest ? short(nameOf(dest)) : null) : label;
  return `Allow ${scripts ? `running ${scripts}` : ASK[effect](name)}?`;
}
