// FORK 2026-06-14 (the architect): every external (http/https) link rendered from the
// Tinker UI must open in a NEW TAB. The UI is a single-page app — a same-tab
// navigation to an external URL destroys the live session view (chat, panels,
// in-flight runs, EEG). This installs a markdown-it `link_open` render rule that
// adds target="_blank" + rel="noopener noreferrer" to every http(s) anchor, for
// every markdown-it instance the UI renders through. Local file references use
// the `.fs-link` <code> mechanism (NOT <a> anchors), so they are untouched.
import type MarkdownIt from "markdown-it";

/** Make external (http/https) links from this markdown-it instance open in a
 *  new tab. Idempotent-safe to call once per instance at construction. */
export function openExternalLinksInNewTab(md: MarkdownIt): void {
  const defaultRender =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet("target", "_blank");
      // noopener: external page can't reach window.opener; noreferrer: no leak.
      tokens[idx].attrSet("rel", "noopener noreferrer");
    }
    return defaultRender(tokens, idx, options, env, self);
  };
}

/** A rendered <code> holding a local path (`~/…` or an absolute path under a
 *  known root) that the `.fs-link` post-processor in app.ts makes clickable.
 *  FORK 2026-10-18 (the architect: "You failed to provide me with an easy-to-click
 *  link"): `&` reaches this regex as `&amp;` and was not in the class, so
 *  `~/Documents/Malleable Software - Ink & Switch.pdf` stayed dead text. The
 *  browser decodes `&amp;` back to `&` in data-path, so the opener gets the
 *  real name. Shared global regex: callers use it only through String.replace. */
export const FS_PATH_CODE_RE =
  /<code(\s[^>]*)?>(~\/(?:[\p{L}\p{M}\p{N}·./_()+,'@#~-]|&amp;| (?!-\S|\s))*(?:[\p{L}\p{M}\p{N}·/_()+,'@#~-]|&amp;)|\/(?:home|usr|tmp|var|opt|etc|mnt|media|data|srv)\/(?:[\p{L}\p{M}\p{N}·./_()+,'@#~-]|&amp;| (?!-\S|\s))*(?:[\p{L}\p{M}\p{N}·/_()+,'@#~-]|&amp;))<\/code>/gu;
