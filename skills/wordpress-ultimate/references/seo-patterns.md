# SEO Patterns for WordPress Content

## On-Page SEO Checklist (per post)

1. **Title tag** — primary keyword near the front, under 60 chars
2. **Meta description** — compelling, 120-155 chars, includes keyword
3. **URL slug** — short, keyword-rich, hyphens only
4. **H1** — the post title (automatic in WordPress)
5. **H2/H3 structure** — logical hierarchy, keywords in subheadings
6. **First 100 words** — include primary keyword naturally
7. **Internal links** — 2-3 links to other posts/pages on the site
8. **External links** — 1-2 authoritative outbound links
9. **Image alt text** — descriptive, keyword-relevant
10. **Featured image** — every post needs one (social sharing)

## Keyword Strategy for Technical Content

### Primary Keywords (target one per post)
Format: `[action] + [specific thing] + [context]`
- "track AI token costs"
- "self-hosted AI agent setup"
- "OpenClaw fork comparison"

### Long-tail Keywords (natural inclusion)
- "how to reduce Claude API costs"
- "AI agent that improves itself"
- "run AI agent 24/7 tutorial"

## Yoast SEO Integration

Set via wp.sh when creating/updating posts:
```bash
scripts/wp.sh PUT "posts/42" '{
  "meta": {
    "_yoast_wpseo_title": "Track AI Token Costs in Real Time | The Tinker Zone",
    "_yoast_wpseo_metadesc": "See where every AI token goes before the bill arrives. Real-time cost tracking for OpenClaw agents.",
    "_yoast_wpseo_focuskw": "AI token costs"
  }
}'
```

## Content Structure for SEO

```
Title (H1): Contains primary keyword
├── Introduction (100-150 words, keyword in first sentence)
├── H2: Problem Section (what's broken)
│   └── H3: Specific pain points
├── H2: Solution Section (what we built)
│   └── H3: Feature breakdowns
├── H2: Evidence (real numbers, screenshots)
├── H2: How-To (step-by-step)
└── H2: Conclusion + CTA
```

Target: 1500-2500 words for pillar content, 800-1200 for regular posts.

## Cross-Linking Strategy

Every post links to:
- 2-3 internal pages (other posts, about page, project pages)
- GitHub repo (consistent CTA)
- At least 1 other external authoritative source

Every external publication (Dev.to, Reddit, HN) links back to the website.
```
Website ←→ GitHub repo
Website ←→ Dev.to article
Website ←→ YouTube video (future)
```
