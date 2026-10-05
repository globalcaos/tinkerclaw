# Configuring indexers

The skill ships with **no third-party indexers**. Two sources are available:

## 1. archive.org — built in, on by default

Public domain and freely licensed material: films, books, scanned manuals,
engineering documents, software, concert recordings. Legal everywhere, and every
item is HTTP-webseeded, so downloads bypass BitTorrent entirely — no tracker, no
DHT, no peers, nothing to seed.

Nothing to configure. Disable with `"useArchiveOrg": false`.

Useful for this skill specifically: public-domain cinema (anything whose
copyright lapsed), technical manuals, and the NASA / Prelinger / Open Library
collections.

## 2. Torznab — bring your own

[Prowlarr](https://prowlarr.com/) (recommended) or
[Jackett](https://github.com/Jackett/Jackett) present hundreds of indexers behind
one API. Configure your indexers there once; this skill inherits all of them and
never needs updating when a site changes its markup or disappears.

### Prowlarr

1. Run Prowlarr (Docker, or a native package).
2. Add the indexers you want, in Prowlarr's own UI.
3. **Settings → General → API Key**, copy it.
4. For each indexer, **its Torznab feed URL** is
   `http://localhost:9696/api/v1/indexer/<id>/newznab` — the `<id>` is visible in
   the indexer's URL in Prowlarr's UI.

```jsonc
// ~/.torrent-scout/config.json
{
  "indexers": [
    {
      "name": "prowlarr-1",
      "url": "http://localhost:9696/api/v1/indexer/1/newznab",
      "apiKey": "YOUR_KEY",
      "categories": "2000,2040,5000",
    },
  ],
}
```

### Jackett

Same shape; Jackett's per-indexer Torznab feed is
`http://localhost:9117/api/v2.0/indexers/<indexer>/results/torznab/api`, and the
API key is on Jackett's dashboard.

### Categories

Standard Newznab category numbers, comma-separated. Useful ones:

| code | meaning      |
| ---- | ------------ |
| 2000 | Movies (all) |
| 2040 | Movies HD    |
| 2045 | Movies UHD   |
| 5000 | TV (all)     |
| 5040 | TV HD        |
| 7000 | Books        |
| 8000 | Other        |

Leave `categories` unset to search everything. `search.mjs --deeper` drops the
category filter regardless, which is exactly what "dig deeper" should mean.

## A note on what to point it at

That choice is yours and it is the part with legal weight. The tool does not
ship a list, does not recommend one, and does not know what any given indexer
carries. See the disclaimer in `README.md`.
