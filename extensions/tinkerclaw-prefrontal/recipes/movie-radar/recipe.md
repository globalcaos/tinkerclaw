---
schema: "kit/1.0"
slug: "movie-radar"
title: "Movie radar — trending new torrent releases as a poster grid"
summary: "The N most-trending recent film releases on torrent indexes, rendered in chat as a responsive poster grid: live IMDb rating ring, vote count, trend rank, runtime, genres, 4K badge, synopsis on hover, and Netflix / Disney+ links when the film is streamable in the operator's country. One script, ~7 s, stdlib only."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "research"
subdivision: "entertainment"
tags:
  [
    "good torrent movies lately",
    "latest movies",
    "new movies",
    "trending movies",
    "what should I watch",
    "movie radar",
    "top movies",
    "is it on netflix",
    "disney plus",
    "poster grid",
  ]
testedHarnesses: ["Claude Code"]
authoredBy: "jarvis-on-the-fly"
params:
  top: { type: "number", default: 14, description: "How many films to show (selected by trend)." }
  exclude: { type: "string", default: "Horror", description: "Comma list of genres to drop. Operator preference lives here, not in code." }
  min_rating: { type: "number", default: 6.0, description: "Live IMDb rating floor." }
  min_votes: { type: "number", default: 1000, description: "Credibility floor — a 9.2 from 40 voters is the director's family." }
  country: { type: "string", default: "ES", description: "JustWatch country for streaming availability." }
---

# Movie radar

**Run it:**

```bash
python3 ~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/recipes/movie-radar/build.py \
  [--top 14] [--exclude Horror] [--min-rating 6] [--min-votes 1000] [--country ES --lang es]
```

Default `--mode cross` (v1.1, 2026-09-19): **torrent seeders × IMDb**. `--mode imdb` = the v1.0
IMDb-trend-only grid. Writes `~/.openclaw/workspace/renders/movie-radar/{block.html,data.json,diff.json,preview.html}`
and prints the census lines to stderr (torrent titles · watchable · cam-only · excluded genre ·
overlap with the IMDb list).

### Cross mode — two independent signals
- **Torrent (unbiased demand):** `apibay.org/precompiled/data_top100_207.json` (HD movies, current
  top-100 by live seeders) + `data_top100_48h_207.json` (last 48 h). Seeders are **summed per IMDb
  id** across releases; titles whose every release is a cinema recording (CAM/TS/TELESYNC/"HQ Pre"…)
  are pulled out into their own "not watchable yet" list, never shown as options.
- **IMDb (opinion + attention):** live rating/votes and MOVIEmeter trend rank per title.
- The card: grid ranked by torrent seeders (🧲 #rank · seeders), each with rating ring, IMDb trend
  rank, "✓ both lists" marker, Netflix/Disney+ badges. Below it, the differences: IMDb-trending
  titles missing from the torrent top · heavily shared cam-only titles · **old films surging in the
  48 h list** (reshared classics) · titles removed by the genre rule.

## Steps

1. **Pool** — YTS `list_movies?sort_by=date_added`, 12 pages × 50, keep `year >= this year − 1`
   (date_added mixes in old back-catalogue).
2. **Enrich** — IMDb GraphQL, 50 ids per call: rating, votes, plot, poster, runtime, FULL genre
   list, `meterRanking` (MOVIEmeter trend rank + direction).
3. **Filter** — drop excluded genres against the full IMDb list, drop below `min_rating` /
   `min_votes`.
4. **Select by trend, display by rating** — top N by MOVIEmeter rank, then sort the shown set by
   rating. Trend answers "what's hot"; rating answers "what's good".
5. **Streaming** — JustWatch GraphQL per title, **matched on IMDb id** (never title text),
   FLATRATE/ADS/FREE offers only; Netflix and Disney+ become linked badges.
6. **Blend the watchable trending titles in** — an IMDb-trending title that is NOT in the torrent
   top survives only if Netflix or Disney+ carries it; the rest are dropped and counted ("N hidden,
   nowhere to watch"). Survivors that are **good enough** are promoted into the grid itself, marked
   `▶ stream`, displacing the weakest torrent rows so the grid stays `--top` wide (`--blend`, max 4).
   "Good enough" is measured against the grid, never against a fixed number: rating ≥ the grid's
   **median rating** AND votes ≥ `--blend-reach` (0.33) × the grid's **median votes**.
7. **Skip what he already has** — scan `--have` (default `~/Downloads/torrent-scout`, colon-separated,
   empty disables) and drop any film already downloaded or downloading, from BOTH lists, **before**
   the top-N cut so the grid backfills and stays `--top` wide. A release name is keyed by cutting it
   at the year (`Title.Words.2026.2160p.WEB-DL…`) and stripping non-alphanumerics; matching is exact
   on that key, or containment when the key is ≥ 10 chars. The header chip says "N already downloaded".
8. **Render** — the block from `block.html` goes into the answer verbatim inside a
   ` ```html-render ` fence (Tinker chat only).
9. **Look before shipping** — screenshot `preview.html` (it is wrapped in the chat iframe's own
   base reset) at 820 px and 400 px and READ both images. Then report the census line
   (pool / passed / shown / streaming) in one sentence.

## Constraints

- Tinker web chat only. On WhatsApp/voice, send a plain list: title · rating · Netflix/Disney+.
- Personal, non-commercial use of IMDb data (their API disclaimer).
- This recipe lists releases; it never downloads. Retrieval goes through the `torrent-scout`
  skill (search → swarm-check → explicit "get number N").

## Failures overcome (2026-09-19, three iterations with the operator)

- **v1.0's "trending" list was biased by its own pool.** It drew only from YTS's last ~600
  uploads, so the season's biggest releases (Toy Story 5, Mandalorian & Grogu, Supergirl — IMDb
  trend #7, Project Hail Mary) never entered it: first cross-run overlap was **2 of 14**. A single
  site's "recently added" window is a sample of that site's upload queue, not of what people watch.
  Cross against a demand signal (seeders) before calling anything "top".
- **A trending title he cannot watch is noise (2026-09-20, operator).** "It is not useful for me to
  know what movies are trending in imdb if I cannot watch them." Hence the streaming gate on the
  IMDb-only list, and the blend.
- **Rating alone is the wrong bar for blending.** First run promoted three regional releases rating
  7.2 / 7.1 / 6.8 on **6.7k / 3.5k / 38k votes** against a grid median of **34.6k** — two of them
  would have displaced films ten times more people had watched. The vote gate (median × 0.33) is
  what makes "good enough" mean good enough for THIS grid.
- **A film already on disk is not a recommendation (2026-09-20, operator: "skip the two that are
  already downloaded").** Hence the `--have` folder scan. Drop BEFORE the cut, never after, or the
  grid silently shrinks to 12.
- **Reshared classics only show in the 48 h window** (Masters of the Universe 1987 — #2 by 48 h
  seeders, invisible in the cumulative top-100). Keep the 48 h list as its own section.

- **"Looks like crap" = the `<style>` tag was stripped.** A ` ```html-render ` block with no
  `<script>` renders inline through DOMPurify, which drops `<style>`; class names survive and
  nothing is styled. The block ends in a `<script>` comment to force the sandboxed-iframe path.
  A standalone Chrome screenshot hid this — verify against the chat wrapper or the live
  snapshot `~/.openclaw/data/tinker-ui-snapshot.html`.
- **Horror leaked through** a check on YTS's first two genre tags. Filter on IMDb's full list.
- **YTS ratings are stale** (9.2 on tiny vote counts). Always use live IMDb rating + votes.
- **yts.mx is dead**; `yts.gg` serves the API (moving to `movies-api.accel.li`). IMDb GraphQL
  returns 403 without `Origin: https://www.imdb.com` + `x-imdb-client-name: imdb-web-next`.
- **Layout:** a rating ring beside the title truncated every title at 100 px; the ring sits on
  the poster's bottom edge instead. Nested links are invalid, so the poster (IMDb) and the
  streaming badges are separate `<a>`s, not one card-wide link.
- Operator preferences (2026-09-19): small posters side by side, no horror, sorted by rating,
  Netflix / Disney+ badges with links.
