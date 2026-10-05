---
name: wallapop
description: Code-based HTTP scraper scaffold for Wallapop (Spain second-hand marketplace). As of 2026-05-24 the HTTP path returns BLOCKED — the search API is auth-gated (HTTP 403 for unauthenticated callers) and the HTML page lazy-loads results client-side — so Wallapop still needs the browser-relay CDP path. The script reliably returns `BLOCKED: http-403` so the marketplace-watcher cron's fallback logic kicks in immediately; it exists as scaffolding for a future headless-renderer revision. Split out of the former combined `marketplace-search` skill (2026-09-19) so Milanuncios and Wallapop each stand alone.
metadata:
  openclaw:
    emoji: 🛒
    requires:
      bins: [node]
    why: Bug task-mpie1ypb-1e8i6 ("Overnight cron uses browser to explore milanuncios and wallapop") — the cron was using the shared browser tab as the primary scraping path, consuming the only authenticated session. This script is the HTTP fallback scaffold; it currently returns BLOCKED so the browser-relay path is used deliberately, not by default. Split from marketplace-search 2026-09-19 so each marketplace is its own skill.
---

# wallapop

A single Node script that TARGETS Wallapop's search without the browser-relay shared tab. It prints one JSON object to stdout (listings + meta) on success, or exits non-zero with `BLOCKED: <reason>` to stderr — which, as of 2026-05-24, is what it always does.

## Usage — HTTP path currently BLOCKED (browser-relay is unavoidable, for now)

```bash
node ~/.openclaw/workspace/skills/wallapop/scripts/wallapop.mjs \
  --keywords "leica m6" \
  --limit 10
```

The script targets `https://api.wallapop.com/api/v3/general/search` — the public search JSON API — but that endpoint returns **HTTP 403** for unauthenticated callers regardless of header tuning. Wallapop's HTML page at `https://es.wallapop.com/app/search?keywords=...` returns a Next.js shell with `__NEXT_DATA__` but ZERO embedded listings — the actual results are fetched client-side via the same auth-gated API after the page hydrates.

Until a headless renderer (Playwright) is wired into a future revision of this skill, **Wallapop must continue to use the browser-relay CDP path.** The script exists as scaffolding for that future revision; for now it reliably returns `BLOCKED: http-403 Forbidden` so the cron's fallback logic kicks in immediately.

## Browser-relay safety note

When the browser-relay path is used for Wallapop, FORK 2026-05-24 (`a5d54492e7`) added a cross-site `Page.navigate` guard in the extension — the cron CAN'T accidentally navigate the user's shared tab to a different domain. Same-site (`wallapop.com` → `es.wallapop.com`, etc.) is allowed.

## When to use vs fall back to CDP

ALWAYS try the script FIRST. It currently returns BLOCKED — so go straight to the browser-relay CDP path (the user's shared `wallapop.com` tab). Re-check the script after any revision that wires a headless renderer; the day the HTTP path works, it becomes the primary and the shared tab is freed.

## Authoritative reference

See `~/.claude/projects/-home-globalcaos-src-jarvis-icu/memory/reference_marketplace_watcher_scrape.md` for the historical scrape-recipe context.
