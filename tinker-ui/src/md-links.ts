// FORK 2026-06-14 (Oscar): every external (http/https) link rendered from the
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
