/**
 * FORK 2026-05-04: Outbound persona prefix for WhatsApp.
 *
 * Single source of truth for the icon/name string Jarvis prepends to every
 * WhatsApp message he sends. Cloners of this fork can change the persona
 * by either:
 *
 *   1. Setting `channels.whatsapp.messagePrefix` in `~/.openclaw/openclaw.json`
 *      (the recommended path — survives upstream merges, no code change).
 *      Examples: "🤖", "🤖 Jarvis:", "🦾 Atlas —".
 *
 *   2. Changing the `DEFAULT_OUTBOUND_PREFIX` constant below (used as the
 *      built-in fallback when no config value is set).
 *
 * The prefix is applied at TWO outbound surfaces, both consuming this module:
 *   - `inbound/send-api.ts:createWebSendApi` — explicit sends initiated via
 *     `openclaw message send`, the architect's `chat.send` dispatch, etc.
 *   - `auto-reply/deliver-reply.ts:deliverWebReply` — the auto-reply path
 *     for inbound-triggered Jarvis runs (DM and group replies).
 *
 * Idempotent: a body that already starts with the configured prefix is left
 * unchanged. Skipped for empty bodies and for reactions (the reaction's emoji
 * IS the icon).
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveWhatsAppAccount } from "./accounts.js";

/**
 * Built-in persona icon used when no `messagePrefix` is configured.
 * Change here OR in `channels.whatsapp.messagePrefix` to swap the icon/name
 * across every Jarvis WhatsApp send.
 */
export const DEFAULT_OUTBOUND_PREFIX = "🤖";

/**
 * The "thinking" emoji that alternates with the persona icon on the user's
 * inbound message while Jarvis is computing a reply. Changing this is the
 * cloner's lever for the heartbeat's "still working" half — the persona half
 * is derived from `messagePrefix` automatically.
 */
export const DEFAULT_THINKING_PRIMARY_EMOJI = "🤔";

/**
 * Done-separator message — sent as a fresh plain text message right after
 * Jarvis's reply lands, with no persona prefix applied. Visually marks
 * "this turn is over" so the next prompt is unambiguous.
 */
export const DEFAULT_DONE_SEPARATOR_MESSAGE = "⚡";

/**
 * Look up the configured prefix for an account, falling back to the global
 * default. Returns undefined when both the account-level and channel-level
 * fields are unset AND no built-in default is desired (rare; we always
 * return the default if no config — this is the "cloner-friendly default"
 * surface the user asked for).
 */
export function resolveOutboundPrefix(cfg: OpenClawConfig, accountId: string): string | undefined {
  try {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    const configured = account.messagePrefix?.trim();
    if (configured) {
      return configured;
    }
  } catch {
    // resolveWhatsAppAccount may throw if cfg is incomplete — fall through
    // to the built-in default.
  }
  return DEFAULT_OUTBOUND_PREFIX;
}

/**
 * Idempotent prefix application. If `prefix` is undefined/empty or `text`
 * is empty, returns text unchanged. If `text` already starts with `prefix`,
 * returns text unchanged. If `text` is a single pictographic grapheme (e.g.
 * "⚡" alone), returns text unchanged — single-emoji messages are end-of-turn
 * signature markers that WhatsApp jumbos at large size; appending the persona
 * prefix would defeat the jumbo and turn the visual marker into noise.
 * Otherwise prepends `${prefix} ${text}`.
 *
 * Used by both the explicit-send path (send-api.ts) and the auto-reply path
 * (deliver-reply.ts) so every outbound text from Jarvis carries the persona.
 */
export function applyOutboundPrefix(text: string, prefix: string | undefined): string {
  if (!prefix || !text) {
    return text;
  }
  if (text.startsWith(prefix)) {
    return text;
  }
  if (isSinglePictographicGrapheme(text)) {
    return text;
  }
  return `${prefix} ${text}`;
}

/**
 * Returns true when `text` (after trim) is exactly one extended-pictographic
 * grapheme cluster — i.e. a single emoji/symbol with optional variation
 * selectors and ZWJ sequences. WhatsApp renders such messages at jumbo size
 * IF the wire payload contains nothing else. Used by applyOutboundPrefix to
 * suppress the persona prefix on intentional single-emoji "signature" sends
 * (e.g. the ⚡ done-separator from the morning-briefing cron). Multi-character
 * messages, single ASCII letters, and emoji+text combinations all return false
 * and keep the prefix.
 */
export function isSinglePictographicGrapheme(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const SegmenterCtor = (globalThis as { Intl?: { Segmenter?: typeof Intl.Segmenter } }).Intl
    ?.Segmenter;
  if (!SegmenterCtor) {
    // Older runtimes — fall back to a permissive regex that matches a single
    // pictographic codepoint (with optional VS-16 / ZWJ sequences). Imperfect
    // but covers ⚡, 🔥, 🎯, ✅ etc. without false positives on ASCII.
    return /^\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*$/u.test(
      trimmed,
    );
  }
  const segmenter = new SegmenterCtor("en", { granularity: "grapheme" });
  const segments = Array.from(segmenter.segment(trimmed));
  if (segments.length !== 1) {
    return false;
  }
  return /\p{Extended_Pictographic}/u.test(segments[0]?.segment ?? "");
}

/**
 * Pull the leading emoji ("persona icon") from a `messagePrefix` string. We
 * use this for two things:
 *   1. The reaction heartbeat alternates between `DEFAULT_THINKING_PRIMARY_EMOJI`
 *      and the persona icon, so a custom icon shows up in the heartbeat too.
 *   2. (Future) any UI that wants to render "the icon, by itself".
 *
 * Returns the leading grapheme cluster IF it's a pictographic emoji (covers
 * skin-tone modifiers + ZWJ sequences). If the prefix is text-only ("Jarvis:"),
 * returns `DEFAULT_OUTBOUND_PREFIX` as a sane fallback so the heartbeat
 * doesn't accidentally try to react with a word.
 */
export function extractPersonaIcon(prefix: string | undefined): string {
  if (!prefix) {
    return DEFAULT_OUTBOUND_PREFIX;
  }
  const match = prefix.match(
    /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u,
  );
  return match?.[0] ?? DEFAULT_OUTBOUND_PREFIX;
}

/**
 * Resolve the persona icon for the given account by reading the live config
 * and extracting the leading emoji. Convenience wrapper used by callers
 * that need only the icon (not the full prefix).
 */
export function resolvePersonaIcon(cfg: OpenClawConfig, accountId: string): string {
  return extractPersonaIcon(resolveOutboundPrefix(cfg, accountId));
}

/**
 * The two emojis that alternate on the user's inbound message while Jarvis
 * is thinking: [thinking-emoji, persona-icon]. Resolved fresh per inbound so
 * config edits to messagePrefix flow through to the heartbeat without restart.
 */
export function resolveThinkingEmojis(cfg: OpenClawConfig, accountId: string): readonly string[] {
  return [DEFAULT_THINKING_PRIMARY_EMOJI, resolvePersonaIcon(cfg, accountId)];
}

/**
 * Done-separator message text. Configurable via
 * `channels.whatsapp.doneSeparator` (string), falls back to
 * `DEFAULT_DONE_SEPARATOR_MESSAGE` ("⚡"). Set to empty string to disable.
 */
export function resolveDoneSeparator(cfg: OpenClawConfig, _accountId: string): string {
  const configured = (cfg.channels?.whatsapp as { doneSeparator?: string } | undefined)
    ?.doneSeparator;
  if (typeof configured === "string") {
    return configured.trim();
  }
  return DEFAULT_DONE_SEPARATOR_MESSAGE;
}
