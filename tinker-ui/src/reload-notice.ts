/**
 * FORK 2026-11-12 — the words a person reads after the page reloaded itself or a restart paused a chat.
 *
 * The notice read "new build assets/index-CX6VXhR0.js from pid 3795185 (/home/…/node …): upgrade: … (7d2f7da1a44f)
 * (develop 7d2f7da1a44)": a file name, a process number and two commit ids around the one part the owner wanted. It
 * now says what changed first, then who asked, and none of the ids. The full cause still goes to the reload log
 * (POST /api/page-load), where the ids are useful.
 */

/** A commit id: 7 to 40 hex characters holding at least one digit and one letter (so no plain word or year). */
const COMMIT_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/** The reason with its ids taken out: commit ids, "(develop <id>)", bundle file names. */
export function plainReason(reason: string): string {
  const text = reason
    .replace(/\([^()]*assets\/[^()]*\)/g, "") // "(assets/index-….js, this page runs assets/index-….js)"
    .replace(/\bassets\/[\w.-]+/g, "")
    .replace(/\((?:develop\s+)?[0-9a-f]{7,40}\)/g, "")
    .replace(COMMIT_ID, "")
    .replace(/\(\s*(?:develop)?\s*\)/g, "")
    .replace(/\s+([,.:;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s:;,·-]+$/, "")
    .trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

/**
 * Who asked, as a name: the Tinker tab's title, a scheduled job's name, a terminal's name, or a plain word for the
 * rest. `titleOf` gives the title of the tab that holds a chat, when this page knows it.
 */
export function plainRequester(
  requester: string,
  titleOf: (sessionKey: string) => string | null = () => null,
): string {
  const who = requester.trim();
  const tab = /^tab "(.+)" \((agent:[^)]*)\)$/.exec(who);
  if (tab) {
    return `tab “${titleOf(tab[2]) || tab[1]}”`;
  }
  const chat = /^chat (agent:\S+)$/.exec(who);
  if (chat) {
    const title = titleOf(chat[1]);
    if (title) {
      return `tab “${title}”`;
    }
    const cron = /^agent:[^:]+:cron:([^:]+)/.exec(chat[1]);
    return cron ? `scheduled job “${cron[1]}”` : "a chat with no tab open";
  }
  const terminal = /^terminal "(.+)" \(/.exec(who);
  if (terminal) {
    return `terminal “${terminal[1]}”`;
  }
  if (/^terminal\b/.test(who)) {
    return "a terminal session";
  }
  if (/^pid\b/.test(who)) {
    return "a background job";
  }
  if (who === "Tinker page button" || who === "page") {
    return "the ↻ button on this page";
  }
  if (!who || who === "agent" || /^an agent\b/.test(who) || who === "unknown") {
    return "an agent";
  }
  return plainReason(who) || "an agent";
}

export type ReloadNotice = { what: string; who: string | null };

/**
 * The two lines of the notice. A pushed build names its reason and its requester (tinker-prod-ui's `cause`); any
 * other self-reload has only its detail text.
 */
export function reloadNotice(
  detail: string,
  pushed: { requester?: string; by?: string; reason?: string } | null | undefined,
  titleOf?: (sessionKey: string) => string | null,
): ReloadNotice {
  if (pushed) {
    return {
      what: plainReason(pushed.reason ?? "") || "A new version of this page",
      who: plainRequester(pushed.requester || pushed.by || "", titleOf),
    };
  }
  // A page older than the `pushed` field stored only the detail, "new build <bundle> from <who>: <reason>"
  // (describePushedBuild). Its first reload after the change showed the session key and the bundle name.
  const old = /^new build \S+ from (.+?): (.+)$/s.exec(detail);
  if (old) {
    return {
      what: plainReason(old[2]) || "A new version of this page",
      who: plainRequester(old[1], titleOf),
    };
  }
  return { what: plainReason(detail) || "A new version of this page", who: null };
}
