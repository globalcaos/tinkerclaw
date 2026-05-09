/**
 * FORK 2026-05-09: chat-profile prefetch — per-group strategy block.
 *
 * Reads `~/.openclaw/workspace/memory/chat-profiles/<slug>.md` and inlines its
 * content (or a bootstrap hint when missing) into the agent envelope. Profiles
 * carry the *purpose* and *consequences* of each chat — purpose-of-this-group,
 * stakes (financial / reputational / casual), audience expectations, format
 * preferences (length, media use, formality), and guardrails.
 *
 * Authorship is agent-driven: Jarvis updates `<slug>.md` (and/or appends to
 * `<slug>.notes.jsonl`) via Bash/Edit when he observes something profile-worthy.
 * No upfront seeding required. Lazy-as-we-go: an unprofiled chat gets a
 * bootstrap hint asking him to start the file when he has enough signal.
 *
 * Scope: groups only. DM strategy lives on the sender's people-profile (the
 * already-prefetched `[sender-profile]` block carries identity + format
 * preferences + guardrails for that person — no second source of truth).
 */
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";

const CHAT_PROFILES_DIR = resolveUserPath("~/.openclaw/workspace/memory/chat-profiles");
const MAX_PROFILE_CHARS = 1800;

/**
 * Derive a filesystem-safe slug for a group from its subject. Falls back to a
 * stable derivative of the chat JID when the subject is missing/empty.
 *
 * Rules:
 *   - Lowercase, ASCII-folded, kebab-case.
 *   - Spaces → hyphens; runs of non-alphanumeric → single hyphen.
 *   - Trim leading/trailing hyphens.
 *   - Cap at 50 chars to keep filenames sane.
 *   - Empty → fallback to "group-<jid-prefix>".
 */
export function deriveGroupSlug(params: { chatJid: string; groupSubject?: string }): string {
  const subject = (params.groupSubject ?? "").trim();
  if (subject) {
    const slug = subject
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, "");
    if (slug.length > 0) return slug;
  }
  const jidPrefix = params.chatJid.replace(/@.*$/, "").replace(/[^a-z0-9]+/gi, "");
  return `group-${jidPrefix.slice(0, 24)}`;
}

export type ChatProfileResult = {
  /** Full `[chat-profile]…[/chat-profile]` block ready to prepend. */
  block: string;
  /** Slug used for path resolution; useful so the agent knows where to write. */
  slug: string;
  /** True when an actual file exists; false when the block is the bootstrap hint. */
  loaded: boolean;
};

/**
 * Read the profile file for a group (when present) and render a `[chat-profile]`
 * block. When no profile exists, returns a bootstrap-hint block that tells
 * Jarvis where + how to start one.
 *
 * For DMs: returns null. Sender-profile already covers the case.
 */
export function prefetchChatProfile(params: {
  chatType: "direct" | "group";
  chatJid: string;
  groupSubject?: string;
}): ChatProfileResult | null {
  if (params.chatType !== "group") return null;
  const slug = deriveGroupSlug({
    chatJid: params.chatJid,
    groupSubject: params.groupSubject,
  });
  const profilePath = path.join(CHAT_PROFILES_DIR, `${slug}.md`);
  const notesPath = path.join(CHAT_PROFILES_DIR, `${slug}.notes.jsonl`);

  let content: string | null = null;
  try {
    if (fs.existsSync(profilePath)) {
      const raw = fs.readFileSync(profilePath, "utf8");
      content = raw.length > MAX_PROFILE_CHARS ? `${raw.slice(0, MAX_PROFILE_CHARS - 1)}…` : raw;
    }
  } catch {
    content = null;
  }

  if (content && content.trim().length > 0) {
    const block = [
      `[chat-profile slug=${slug} type=group]`,
      content.trim(),
      "[/chat-profile]",
      "",
      `[chat-profile-update]`,
      `Append observations to ${notesPath}`,
      `(JSON-Lines: {"timestamp":"<iso>", "observation":"…", "evidence":"…"}).`,
      `Edit ${profilePath} directly when you have enough signal to refine the structured fields.`,
      "[/chat-profile-update]",
    ].join("\n");
    return { block, slug, loaded: true };
  }

  const subject = params.groupSubject ?? "(unknown subject)";
  const block = [
    `[chat-profile slug=${slug} type=group status=unprofiled]`,
    `No profile yet for "${subject}" (${params.chatJid}).`,
    "Profile this chat lazily — when you observe its purpose, audience, stakes,",
    "or format preferences, write a starter file at:",
    `  ${profilePath}`,
    "Suggested frontmatter shape:",
    "  ---",
    `  slug: ${slug}`,
    `  chat_jid: ${params.chatJid}`,
    "  chat_type: group",
    `  display_name: ${subject}`,
    "  purpose: <one-line purpose of this chat>",
    "  stakes: <financial | reputational | casual>",
    "  audience: <who's in it, what they expect>",
    "  format_preferences:",
    "    default_length: <short | short-medium | medium | long>",
    "    formality: <casual | warm-professional | technical-peer>",
    "    language: <es | en | …>",
    "  guardrails:",
    "    - <thing to avoid>",
    "  last_reviewed: <iso>",
    "  ---",
    "  <free-form notes>",
    "Or append a single observation to:",
    `  ${notesPath}`,
    '  echo \'{"timestamp":"\'$(date -u +%FT%TZ)\'", "observation":"…", "evidence":"…"}\' >> ' +
      notesPath,
    "[/chat-profile]",
  ].join("\n");
  return { block, slug, loaded: false };
}
