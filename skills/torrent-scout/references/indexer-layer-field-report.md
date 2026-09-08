# Torrent Indexer / Site Layer — Jackett Cardigann Report

**Generated:** 2026-09-06 · **Host:** local machine · **Method:** on-disk inspection + live Jackett instance + GitHub API fetches.
Every number below came from a command run during this session. Items I could not verify are marked **[UNVERIFIED]**.

---

## 0. TL;DR

| Fact                                          | Value                                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Jackett install                               | `~/.local/share/jackett/Jackett/` (self-contained .NET, `./jackett` launcher)             |
| Config dir                                    | `~/.config/Jackett/` (`ServerConfig.json`, `Indexers/`, `log.txt`)                        |
| Cardigann YAML definitions on disk            | **554**                                                                                   |
| Native (C#-coded) indexers                    | **65**                                                                                    |
| **Total indexers loaded**                     | **619** (554 + 65, verified in startup log)                                               |
| Public / semi-private / private (YAML)        | **87 / 61 / 406**                                                                         |
| Upstream `Jackett/Jackett@master` definitions | **554** — byte-identical filename set to local                                            |
| Latest upstream release                       | `v0.24.2541`, published 2026-09-06T05:55Z                                                 |
| Public indexers' live `links:`                | **197** base URLs                                                                         |
| Public indexers' `legacylinks:`               | **335** dead/alternate URLs                                                               |
| All 554 defs combined                         | **707** links + **618** legacylinks                                                       |
| Unique registrable domains across public defs | **373**                                                                                   |
| Configured on this box                        | **79** indexers (`~/.config/Jackett/Indexers/*.json`)                                     |
| Live aggregate search `q=ubuntu`              | **1039 results** in ~40 s, 55/79 indexers OK, 24 errored                                  |
| Port / API key                                | `127.0.0.1:9117`, key in `~/.config/Jackett/ServerConfig.json` (`ddtt…k2zu`, masked here) |

**The single biggest lever:** 17 of the 24 failing indexers fail with _"Challenge detected but FlareSolverr is not configured"_. Standing up FlareSolverr converts roughly a fifth of the configured set from dead to live in one move.

---

## 1. Where the definitions live

```
~/.local/share/jackett/Jackett/Definitions/*.yml     <- 554 files, the real set
~/.config/Jackett/Indexers/*.json                    <- per-indexer USER config (79 configured)
~/.config/Jackett/ServerConfig.json                  <- port, API key, FlareSolverr URL, cache
~/.config/Jackett/log.txt                            <- startup + per-request log
```

Jackett's startup log states its own search order for Cardigann YAML (verbatim):

```
Loading Cardigann indexers from: $HOME/.config/cardigann/definitions/,
                                /etc/xdg/cardigan/definitions/,
                                $HOME/.local/share/jackett/Jackett/Definitions
Loaded 554 Cardigann indexers.
Loaded 619 indexers in total
Adding aggregate indexer ('all' indexer) ...
Adding filter indexer ('type:public' indexer) ...
Adding filter indexer ('type:private' indexer) ...
Adding filter indexer ('type:semi-public' indexer) ...
```

The first two directories do not exist here — **that is the drop-in path for custom definitions**: put a `.yml` in `~/.config/cardigann/definitions/` and it loads without touching the install. Note the aggregate filter is spelled `type:semi-public` even though the YAML field value is `semi-private`.

A second, stale copy exists in a Timeshift snapshot at `/run/timeshift/backup$HOME/.local/share/jackett/Jackett/Definitions` — ignore it.

**No Prowlarr on this machine** (no binary, no `~/.config/Prowlarr`, nothing on :9696). Prowlarr consumes the same Cardigann schema, so the map below transfers.

---

## 2. The Cardigann schema

Annotated from `Definitions/1337x.yml` (a real public definition, trimmed):

```yaml
---
id: 1337x # the URL slug used in the Torznab path
name: 1337x
description: "1337x is a Public torrent site that offers verified torrent downloads"
language: en-US
type: public # public | semi-private | private   <- the topology field
encoding: UTF-8
requestDelay: 3 # seconds between requests, politeness throttle

# get status and news on domains at the official site https://1337x-status.org/
links: # CURRENT working base URLs, tried in order
  - https://1337x.to/
  - https://1337x.st/
  - https://x1337x.ws/
  - https://x1337x.eu/
  - https://x1337x.cc/
legacylinks: # historical/known-dead; kept so old configs still resolve
  - https://1337x.is/
  - https://1337x.mrunblock.bond/
  - https://1337x.unblockit.download/
  - https://1337x.proxyninja.org/ # keyword search not working
  - ... (13 total)

caps:
  categorymappings: # site category id -> Newznab standard category
    - { id: 28, cat: TV/Anime, desc: "Anime/Anime" }
    - { id: 42, cat: Movies/HD, desc: "Movies/HD" }
    - { id: 23, cat: Audio/Lossless, desc: "Music/Lossless" }
  modes: # which Torznab t= verbs this indexer answers
    search: [q]
    tv-search: [q, season, ep]
    movie-search: [q]
    music-search: [q]
    book-search: [q]
  allowrawsearch: true

settings: # rendered as the indexer's config form in the UI
  - { name: uploader, type: text, label: Filter by Uploader }
  - {
      name: sort,
      type: select,
      label: Sort requested from site,
      default: time,
      options: { time: created, seeders: seeders, size: size },
    }
  - { name: info_flaresolverr, type: info_flaresolverr } # special: renders the CF warning

download: # how to get the .torrent/magnet off the details page
  selectors:
    - selector: ul li a[href*="{{ .Config.primarydownloadlink }}"]
      attribute: href
      filters:
        - name: replace
          args: ["http://itorrents.org/", "https://itorrents.net/"]

search:
  paths: # Go-template URL paths appended to the chosen link
    - path: "{{ if .Keywords }}search/{{ .Keywords }}{{ else }}cat/Movies{{ end }}/{{ .Config.sort }}/{{ .Config.type }}/1/"
  rows:
    selector: "table.table-list > tbody > tr"
  fields: # CSS/XPath -> Torznab field, with filter pipelines
    title: { selector: 'a[href^="/torrent/"]' }
    details: { selector: 'a[href^="/torrent/"]', attribute: href }
    seeders: { selector: td.seeds }
    leechers: { selector: td.leeches }
    size: { selector: td.size, filters: [{ name: replace, args: ["B", " B"] }] }
    date: { selector: td.coll-date, filters: [{ name: dateparse, args: "MMM. dd 'yy" }] }
    downloadvolumefactor: { text: 0 } # 0 = freeleech
    uploadvolumefactor: { text: 1 }
```

Fields that matter for a discovery tool:

| Key                     | Meaning                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | Slug in `/api/v2.0/indexers/<id>/results/torznab` — the join key for everything                                                                       |
| `type`                  | `public` = no account. `semi-private` = free registration. `private` = ratio/invite                                                                   |
| `links`                 | Ordered list of **current** base URLs. Jackett uses `[0]` unless the user overrides                                                                   |
| `legacylinks`           | Domains that used to work. **This is the historical mirror record** — the single richest source of dead-domain → live-domain lineage in the ecosystem |
| `caps.modes`            | Which `t=` verbs work and which params each accepts                                                                                                   |
| `caps.categorymappings` | Site category → Newznab numeric category (2000 movies, 5000 TV, 3000 audio, 7000 books…)                                                              |
| `search.paths`          | Go-template URL construction. Multiple paths = multiple pages/categories fetched per query                                                            |
| `settings`              | Per-user config; `type: info_flaresolverr` flags a site known to need Cloudflare solving                                                              |

---

## 3. Public indexer topology map (87 indexers)

`live` = count of `links:`, `legacy` = count of `legacylinks:`. `cfg` = configured on this box. `hits` = results returned in the live `q=ubuntu` aggregate run; `ERR` = errored, blank = not configured.

| #   | id                    | name                  | lang  | live | legacy | primary URL                       | cfg/hits |
| --- | --------------------- | --------------------- | ----- | ---- | ------ | --------------------------------- | -------- |
| 1   | `0magnet`             | 0Magnet               | zh-CN | 1    | 4      | https://16mag.net/                | 29       |
| 2   | `1337x`               | 1337x                 | en-US | 5    | 13     | https://1337x.to/                 | ERR      |
| 3   | `52bt`                | 52BT                  | en-US | 2    | 17     | https://7hhb4q86.529075.xyz/      | 40       |
| 4   | `acgrip`              | ACG.RIP               | zh-CN | 1    | 0      | https://acg.rip/                  |          |
| 5   | `aniRena`             | AniRena               | en-US | 1    | 0      | https://www.anirena.com/          |          |
| 6   | `anibt`               | Anibt                 | zh-CN | 1    | 0      | https://anibt.net/                | 0        |
| 7   | `anisource`           | AniSource             | en-US | 1    | 0      | https://asnet.pw/                 | ERR      |
| 8   | `bangumi-moe`         | Bangumi Moe           | en-US | 1    | 0      | https://bangumi.moe/              |          |
| 9   | `bigfangroup`         | BigFANGroup           | ru-RU | 2    | 0      | https://bigfangroup.org/          | 3        |
| 10  | `blueroms`            | BlueRoms              | en-US | 1    | 0      | https://www.blueroms.ws/          | 0        |
| 11  | `btdirectory`         | BTdirectory           | en-US | 4    | 6      | https://btmulu.live/              | ERR      |
| 12  | `btetree`             | BT.etree              | en-US | 1    | 1      | https://bt.etree.org/             | ERR      |
| 13  | `byrutor`             | Byrutor               | ru-RU | 1    | 5      | https://byrutgame.org/            | 2        |
| 14  | `catorrent`           | Catorrent             | ru-RU | 1    | 1      | https://catorrent.net/            | 0        |
| 15  | `crackingpatching`    | CrackingPatching      | en-US | 1    | 0      | https://crackingpatching.com/     | 3        |
| 16  | `damagnet`            | DaMagNet              | en-US | 1    | 0      | https://damag.net/                | ERR      |
| 17  | `dmhy`                | dmhy                  | zh-TW | 1    | 0      | https://share.dmhy.org/           |          |
| 18  | `ebookbay`            | EBookBay              | en-US | 1    | 1      | https://ebb.la/                   |          |
| 19  | `ehentai`             | E-Hentai              | en-US | 1    | 0      | https://e-hentai.org/             | 0        |
| 20  | `extratorrent-st`     | ExtraTorrent.st       | en-US | 3    | 4      | https://extratorrent.st/          | ERR      |
| 21  | `eztv`                | EZTV                  | en-US | 5    | 13     | https://eztvx.to/                 | ERR      |
| 22  | `filemood`            | FileMood              | en-US | 1    | 0      | https://filemood.com/             | 20       |
| 23  | `freejavtorrent`      | Free JAV Torrent      | en-US | 1    | 0      | https://www.freejavtorrent.com/   | 0        |
| 24  | `gamestorrents`       | GamesTorrents         | es-ES | 1    | 4      | https://www.gamestorrents.app/    |          |
| 25  | `internetarchive`     | Internet Archive      | en-US | 1    | 0      | https://archive.org/              | 100      |
| 26  | `kickasstorrents-to`  | kickasstorrents.to    | en-US | 4    | 8      | https://kickass.torrentbay.st/    | ERR      |
| 27  | `kickasstorrents-ws`  | kickasstorrents.ws    | en-US | 9    | 12     | https://kickass.ws/               | ERR      |
| 28  | `limetorrents`        | LimeTorrents          | en-US | 7    | 5      | https://www.limetorrents.fun/     | 40       |
| 29  | `linuxtracker`        | LinuxTracker          | en-US | 1    | 0      | https://linuxtracker.org/         | 30       |
| 30  | `mactorrentsdownload` | Mac Torrents Download | en-US | 1    | 0      | https://www.torrentmac.net/       |          |
| 31  | `magnetcat`           | Magnet Cat            | en-US | 6    | 16     | https://magnetcatcat.com/         | ERR      |
| 32  | `magnetdownload`      | MagnetDownload        | en-US | 1    | 0      | https://www.magnetdownload.com/   | 10       |
| 33  | `magnetz`             | Magnetz               | en-US | 1    | 0      | https://magnetz.eu/               | ERR      |
| 34  | `megapeer`            | MegaPeer              | ru-RU | 1    | 2      | https://megapeer.vip/             | 1        |
| 35  | `mikan`               | Mikan                 | zh-CN | 1    | 0      | https://mikanani.me/              | 0        |
| 36  | `mixtapetorrent`      | MixtapeTorrent        | en-US | 1    | 0      | http://www.mixtapetorrent.com/    | 0        |
| 37  | `mypornclub`          | MyPornClub            | en-US | 1    | 0      | https://myporn.club/              |          |
| 38  | `nekobt`              | nekoBT                | en-US | 1    | 0      | https://nekobt.to/                | 0        |
| 39  | `newstudio`           | NewStudio             | ru-RU | 1    | 1      | https://newstudio.tv/             | ERR      |
| 40  | `nipponsei`           | Nipponsei             | en-US | 1    | 0      | https://nipponsei.minglong.org/   | 0        |
| 41  | `noname-club`         | NoNaMe Club           | ru-RU | 1    | 3      | https://nnmclub.to/               | 50       |
| 42  | `nyaasi`              | Nyaa.si               | en-US | 5    | 13     | https://nyaa.si/                  | 1        |
| 43  | `onejav`              | OneJAV                | en-US | 1    | 0      | https://onejav.com/               | 0        |
| 44  | `opensharing`         | OpenSharing           | ru-RU | 1    | 0      | https://opensharing.org/          | 0        |
| 45  | `pandacd`             | PandaCD               | en-US | 1    | 0      | https://pandacd.io/               | 0        |
| 46  | `pctorrent`           | PC-torrent            | ru-RU | 1    | 2      | https://pc-torrents.games/        | 0        |
| 47  | `plugintorrent`       | plugintorrent         | en-US | 1    | 0      | https://plugintorrent.com/        | 0        |
| 48  | `pornotorrent`        | PornoTorrent          | pt-BR | 1    | 2      | https://pornotorrent.com.br/      |          |
| 49  | `pornrips`            | PornRips              | en-US | 1    | 0      | https://pornrips.to/              |          |
| 50  | `pornxlab`            | PornXLab              | en-US | 1    | 1      | https://www.pornxlab.com/         |          |
| 51  | `postman`             | Postman               | en-US | 1    | 0      | http://tracker2.postman.i2p/      |          |
| 52  | `rintornet`           | RinTor.NeT            | ru-RU | 1    | 0      | https://www.rintor.net/           | 0        |
| 53  | `rutor`               | RuTor                 | ru-RU | 3    | 13     | https://rutor.info/               | 100      |
| 54  | `rutracker-ru`        | RuTracker.RU          | ru-RU | 1    | 0      | http://rutracker.ru/              | 34       |
| 55  | `sexypics`            | Sexy-Pics             | en-US | 1    | 0      | https://www.sexy-pics.us/         | ERR      |
| 56  | `shanaproject`        | Shana Project         | en-US | 1    | 0      | https://www.shanaproject.com/     |          |
| 57  | `showrss`             | showRSS               | en-US | 1    | 0      | https://showrss.info/             | 0        |
| 58  | `skidrowrepack`       | SkidrowRepack         | en-US | 1    | 0      | https://skidrowrepack.com/        | ERR      |
| 59  | `sosulki`             | sosulki               | ru-RU | 1    | 4      | https://sosulki.bosk.cc/          | 0        |
| 60  | `sukebeinyaasi`       | sukebei.nyaa.si       | en-US | 2    | 1      | https://sukebei.nyaa.si/          |          |
| 61  | `thepiratebay`        | The Pirate Bay        | en-US | 26   | 33     | https://thepiratebay.org/         | 100      |
| 62  | `therarbg`            | TheRARBG              | en-US | 5    | 10     | https://therarbg.to/              | 41       |
| 63  | `tokyotosho`          | Tokyo Toshokan        | en-US | 3    | 10     | https://www.tokyotosho.info/      | ERR      |
| 64  | `torrent-pirat`       | torrent-pirat         | ru-RU | 1    | 0      | http://www.torrent-pirat.com/     | 0        |
| 65  | `torrent9`            | Torrent9              | fr-FR | 1    | 24     | https://www6.torrent9.to/         | 3        |
| 66  | `torrentby`           | torrent.by            | ru-RU | 1    | 1      | https://torrent.by/               | 2        |
| 67  | `torrentbyte`         | TorrentByte           | en-US | 1    | 0      | https://torrentbyte.cc/           | ERR      |
| 68  | `torrentcore`         | Torrent[CORE]         | en-US | 1    | 0      | https://torrentcore.xyz/          | ERR      |
| 69  | `torrentdownload`     | TorrentDownload       | en-US | 1    | 3      | https://www.torrentdownload.info/ | 47       |
| 70  | `torrentdownloads`    | Torrent Downloads     | en-US | 3    | 7      | https://www.torrentdownloads.pro/ | 50       |
| 71  | `torrentgalaxyclone`  | TorrentGalaxyClone    | en-US | 2    | 1      | https://torrentgalaxy.one/        | 41       |
| 72  | `torrentkitty`        | TorrentKitty          | en-US | 10   | 1      | https://www.torrentkitty.cam/     | 20       |
| 73  | `torrentoyunindir`    | Torrent Oyun indir    | tr-TR | 1    | 3      | https://1.torrentoyunindir.com/   | 0        |
| 74  | `torrentproject2`     | TorrentProject2       | en-US | 6    | 3      | https://torrentproject2.net/      | 158      |
| 75  | `torrentsome`         | Torrentsome           | ko-KR | 1    | 15     | https://torrentsome261.com/       | ERR      |
| 76  | `torrenttip`          | Torrenttip            | ko-KR | 1    | 15     | https://torrenttip242.top/        | ERR      |
| 77  | `u2p`                 | U2P                   | fr-FR | 1    | 2      | https://u2prelais.eliottb.dev/    | ERR      |
| 78  | `u3c3`                | U3C3                  | zh-CN | 5    | 4      | https://u3c3.com/                 | 0        |
| 79  | `uindex`              | Uindex                | en-US | 1    | 0      | https://uindex.org/               | ERR      |
| 80  | `vsthouse`            | VSTHouse              | ru-RU | 1    | 2      | https://vsthouse.org/             |          |
| 81  | `vstorrent`           | VSTorrent             | en-US | 1    | 0      | https://vstorrent.org/            |          |
| 82  | `vsttorrents`         | VST Torrentz          | en-US | 1    | 2      | https://vsttorrentz.net/          |          |
| 83  | `world-torrent`       | World-torrent         | fr-FR | 8    | 36     | https://www.darkfox4.cc/          | 0        |
| 84  | `xxxclub`             | XXXClub               | en-US | 3    | 0      | https://xxxclub.to/               |          |
| 85  | `xxxtor`              | xxxtor                | ru-RU | 1    | 2      | https://xxxtor.com/               |          |
| 86  | `yts`                 | YTS                   | en-US | 6    | 9      | https://yts.gg/                   | 0        |
| 87  | `zamundarip`          | Zamunda RIP           | bg-BG | 1    | 0      | https://zamunda.rip/              | ERR      |

### 3.1 Full mirror + legacy expansion

Every public indexer with all of its live mirrors and legacy domains. This is the site+mirror topology map.

#### `0magnet` — 0Magnet (zh-CN)

**live:**

- https://16mag.net/

**legacy:**

- https://0magnet.com/
- https://9mag.net/
- https://0magnet.co/
- https://13mag.net/

#### `1337x` — 1337x (en-US)

**live:**

- https://1337x.to/
- https://1337x.st/
- https://x1337x.ws/
- https://x1337x.eu/
- https://x1337x.cc/

**legacy:**

- https://1337x.is/
- https://1337x.gd/
- https://1337x.mrunblock.bond/
- https://1337x.abcproxy.org/
- https://1337x.so/
- https://1337x.unblockit.download/
- https://1337x.unblockninja.com/
- https://1337x.ninjaproxy1.com/
- https://1337x.proxyninja.org/
- https://1337x.proxyninja.net/
- https://1337x.torrentbay.st/
- https://1337x.torrentsbay.org/
- https://x1337x.se/

#### `52bt` — 52BT (en-US)

**live:**

- https://7hhb4q86.529075.xyz/
- https://lr4qyjyu.529076.xyz/

**legacy:**

- https://www.52btbt.icu/
- https://gk8u60tw.529075.xyz/
- https://s5dmc63w.529076.xyz/
- https://mbivngf9.529075.xyz/
- https://wj05w7bl.529076.xyz/
- https://nd8xavjv.529075.xyz/
- https://zf6c657p.529076.xyz/
- https://l3qi32fp.529075.xyz/
- https://290e01vd.529076.xyz/
- https://ody4n381.529075.xyz/
- https://1xpswim9.529076.xyz/
- https://eufo9g1k.529075.xyz/
- https://ktcbzh8o.529076.xyz/
- https://8fvgrwkm.529075.xyz/
- https://wh8badr7.529076.xyz/
- https://frsb31dm.529075.xyz/
- https://bp3wq4vc.529076.xyz/

#### `acgrip` — ACG.RIP (zh-CN)

**live:**

- https://acg.rip/

#### `aniRena` — AniRena (en-US)

**live:**

- https://www.anirena.com/

#### `anibt` — Anibt (zh-CN)

**live:**

- https://anibt.net/

#### `anisource` — AniSource (en-US)

**live:**

- https://asnet.pw/

#### `bangumi-moe` — Bangumi Moe (en-US)

**live:**

- https://bangumi.moe/

#### `bigfangroup` — BigFANGroup (ru-RU)

**live:**

- https://bigfangroup.org/
- https://www.freebfg.org/

#### `blueroms` — BlueRoms (en-US)

**live:**

- https://www.blueroms.ws/

#### `btdirectory` — BTdirectory (en-US)

**live:**

- https://btmulu.live/
- https://www.btmulu.cyou/
- https://www.btmulu.cfd/
- https://www.btmulu.help/

**legacy:**

- https://www.btmulu.asia/
- https://www.btmulu.digital/
- https://www.btmulu.pw/
- https://www.btmulu.one/
- https://btmulu.work/
- https://www.btmulu.quest/

#### `btetree` — BT.etree (en-US)

**live:**

- https://bt.etree.org/

**legacy:**

- http://bt.etree.org/

#### `byrutor` — Byrutor (ru-RU)

**live:**

- https://byrutgame.org/

**legacy:**

- https://byrutor.org/
- https://byrutdb.org/
- https://byrut.org/
- https://thebyrut.org/
- https://byruthub.org/

#### `catorrent` — Catorrent (ru-RU)

**live:**

- https://catorrent.net/

**legacy:**

- https://catorrent.org/

#### `crackingpatching` — CrackingPatching (en-US)

**live:**

- https://crackingpatching.com/

#### `damagnet` — DaMagNet (en-US)

**live:**

- https://damag.net/

#### `dmhy` — dmhy (zh-TW)

**live:**

- https://share.dmhy.org/

#### `ebookbay` — EBookBay (en-US)

**live:**

- https://ebb.la/

**legacy:**

- http://ebb.la/

#### `ehentai` — E-Hentai (en-US)

**live:**

- https://e-hentai.org/

#### `extratorrent-st` — ExtraTorrent.st (en-US)

**live:**

- https://extratorrent.st/
- https://extratorrent.ninjaproxy1.com/
- https://extratorrent.proxyninja.org/

**legacy:**

- https://extratorrent.mrunblock.bond/
- https://extratorrent.nocensor.cloud/
- https://extratorrent.unblockit.download/
- https://extratorrent.proxyninja.net/

#### `eztv` — EZTV (en-US)

**live:**

- https://eztvx.to/
- https://eztv.wf/
- https://eztv.tf/
- https://eztv.yt/
- https://eztv1.xyz/

**legacy:**

- https://eztv.ag/
- https://eztv.it/
- https://eztv.ch/
- https://eztv.io/
- https://eztv.re/
- https://eztv.li/
- https://eztv.mrunblock.bond/
- https://eztv.nocensor.cloud/
- https://eztv.unblockninja.com/
- https://eztv.ninjaproxy1.com/
- https://eztv.proxyninja.org/
- https://eztv.abcproxy.org/
- https://eztv.unblockit.download/

#### `filemood` — FileMood (en-US)

**live:**

- https://filemood.com/

#### `freejavtorrent` — Free JAV Torrent (en-US)

**live:**

- https://www.freejavtorrent.com/

#### `gamestorrents` — GamesTorrents (es-ES)

**live:**

- https://www.gamestorrents.app/

**legacy:**

- https://www.gamestorrents.com/
- https://www.gamestorrents.tv/
- https://www.gamestorrents.nu/
- https://www.gamestorrents.fm/

#### `internetarchive` — Internet Archive (en-US)

**live:**

- https://archive.org/

#### `kickasstorrents-to` — kickasstorrents.to (en-US)

**live:**

- https://kickass.torrentbay.st/
- https://kickass.torrentsbay.org/
- https://kickasstorrents.ninjaproxy1.com/
- https://kickasstorrents.proxyninja.org/

**legacy:**

- https://kat.root.yt/
- https://kickasstorrents.abcproxy.org/
- https://kickasstorrents.to/
- https://kickasstorrent.cr/
- https://katcr.to/
- https://www.kickasstorrents.do/
- https://kickasstorrents.unblockninja.com/
- https://kickasstorrents.proxyninja.net/

#### `kickasstorrents-ws` — kickasstorrents.ws (en-US)

**live:**

- https://kickass.ws/
- https://kickasstorrents.bz/
- https://kkickass.com/
- https://kkat.net/
- https://kick4ss.com/
- https://kickasst.net/
- https://kickasstorrents.id/
- https://thekat.cc/
- https://kattracker.com/

**legacy:**

- https://kickass.gg/
- https://katcr.io/
- https://thekat.nz/
- https://thekat.se/
- https://kat.how/
- https://kat.li/
- https://katcr.to/
- https://kickasstorrent.cr/
- https://kickasstorrents.unblockninja.com/
- https://kickass-kat.com/
- https://kickass.sh/
- https://kickasshydra.dev/

#### `limetorrents` — LimeTorrents (en-US)

**live:**

- https://www.limetorrents.fun/
- https://limetorrents.unblockninja.com/
- https://limetorrents.ninjaproxy1.com/
- https://limetorrents.proxyninja.org/
- https://limetorrents.proxyninja.net/
- https://limetorrents.torrentbay.st/
- https://limetorrents.torrentsbay.org/

**legacy:**

- https://limetorrents.mrunblock.bond/
- https://limetorrents.nocensor.cloud/
- https://limetorrents.abcproxy.org/
- https://limetorrents.unblockit.download/
- https://www.limetorrents.lol/

#### `linuxtracker` — LinuxTracker (en-US)

**live:**

- https://linuxtracker.org/

#### `mactorrentsdownload` — Mac Torrents Download (en-US)

**live:**

- https://www.torrentmac.net/

#### `magnetcat` — Magnet Cat (en-US)

**live:**

- https://magnetcatcat.com/
- https://clmclm.com/
- https://c1bgdeey.8800591.xyz/
- https://ck4zxpy8.8800592.xyz/
- https://q39qxf3t.8800593.xyz/
- https://sftadrre.8800594.xyz/

**legacy:**

- https://5ai7ltse.8800591.xyz/
- https://doxz6u16.8800592.xyz/
- https://a6oup1h1.8800593.xyz/
- https://ddunus9l.8800594.xyz/
- https://x3sosw88.8800591.xyz/
- https://sdrclvjj.8800592.xyz/
- https://w4n3wjju.8800593.xyz/
- https://59h47o93.8800594.xyz/
- https://v4remfka.8800591.xyz/
- https://wfb4bl8b.8800592.xyz/
- https://rrujxrr9.8800593.xyz/
- https://ybhcxsg4.8800594.xyz/
- https://b8fqdtud.8800591.xyz/
- https://qvcqsr7u.8800592.xyz/
- https://r8n2a4mz.8800593.xyz/
- https://zg40q60t.8800594.xyz/

#### `magnetdownload` — MagnetDownload (en-US)

**live:**

- https://www.magnetdownload.com/

#### `magnetz` — Magnetz (en-US)

**live:**

- https://magnetz.eu/

#### `megapeer` — MegaPeer (ru-RU)

**live:**

- https://megapeer.vip/

**legacy:**

- http://megapeer.ru/
- http://alt.megapeer.ru/

#### `mikan` — Mikan (zh-CN)

**live:**

- https://mikanani.me/

#### `mixtapetorrent` — MixtapeTorrent (en-US)

**live:**

- http://www.mixtapetorrent.com/

#### `mypornclub` — MyPornClub (en-US)

**live:**

- https://myporn.club/

#### `nekobt` — nekoBT (en-US)

**live:**

- https://nekobt.to/

#### `newstudio` — NewStudio (ru-RU)

**live:**

- https://newstudio.tv/

**legacy:**

- http://newstudio.tv/

#### `nipponsei` — Nipponsei (en-US)

**live:**

- https://nipponsei.minglong.org/

#### `noname-club` — NoNaMe Club (ru-RU)

**live:**

- https://nnmclub.to/

**legacy:**

- https://nnm-club.name/
- https://nnm-club.me/
- http://nnmclub.to/

#### `nyaasi` — Nyaa.si (en-US)

**live:**

- https://nyaa.si/
- https://nyaa.iss.ink/
- https://nyaa.land/
- https://nyaa.mom/
- https://nyaa.media/

**legacy:**

- https://nyaa.black-mirror.xyz/
- https://nyaa.unblocked.casa/
- https://nyaa.proxyportal.fun/
- https://nyaa.uk-unblock.xyz/
- https://nyaa.ind-unblock.xyz/
- https://nyaa.unblocked.bar/
- https://nyaa.proxyportal.pw/
- https://nyaa.uk-unblock.pro/
- https://nyaa.root.yt/
- https://nyaa.lol/
- https://nyaa.mrunblock.bond/
- https://nyaa.nocensor.cloud/
- https://nyaa.unblockninja.com/

#### `onejav` — OneJAV (en-US)

**live:**

- https://onejav.com/

#### `opensharing` — OpenSharing (ru-RU)

**live:**

- https://opensharing.org/

#### `pandacd` — PandaCD (en-US)

**live:**

- https://pandacd.io/

#### `pctorrent` — PC-torrent (ru-RU)

**live:**

- https://pc-torrents.games/

**legacy:**

- https://pc-torrent.org/
- https://pc-torrent.pro/

#### `plugintorrent` — plugintorrent (en-US)

**live:**

- https://plugintorrent.com/

#### `pornotorrent` — PornoTorrent (pt-BR)

**live:**

- https://pornotorrent.com.br/

**legacy:**

- https://www.pornotorrent.eu/
- https://pornotorrent.net.br/

#### `pornrips` — PornRips (en-US)

**live:**

- https://pornrips.to/

#### `pornxlab` — PornXLab (en-US)

**live:**

- https://www.pornxlab.com/

**legacy:**

- https://www.ptorrents.com/

#### `postman` — Postman (en-US)

**live:**

- http://tracker2.postman.i2p/

#### `rintornet` — RinTor.NeT (ru-RU)

**live:**

- https://www.rintor.net/

#### `rutor` — RuTor (ru-RU)

**live:**

- https://rutor.info/
- https://rutor.is/
- http://6tor.org/

**legacy:**

- https://rutor.uk-unblock.xyz/
- https://rutor.ind-unblock.xyz/
- https://rutor.unblocked.bar/
- https://rutor.proxyportal.pw/
- https://rutor.uk-unblock.pro/
- https://rutor.root.yt/
- https://rutor.unblocked.rest/
- https://rutor.unblocked.monster/
- https://rutor.mrunblock.bond/
- https://rutor.nocensor.cloud/
- http://new-rutor.org/
- http://rutor.info/
- http://rutor.is/

#### `rutracker-ru` — RuTracker.RU (ru-RU)

**live:**

- http://rutracker.ru/

#### `sexypics` — Sexy-Pics (en-US)

**live:**

- https://www.sexy-pics.us/

#### `shanaproject` — Shana Project (en-US)

**live:**

- https://www.shanaproject.com/

#### `showrss` — showRSS (en-US)

**live:**

- https://showrss.info/

#### `skidrowrepack` — SkidrowRepack (en-US)

**live:**

- https://skidrowrepack.com/

#### `sosulki` — sosulki (ru-RU)

**live:**

- https://sosulki.bosk.cc/

**legacy:**

- http://sosulki.net/
- http://sosulki.com/
- https://sosulki.com/
- https://sosulki.hlom.ru/

#### `sukebeinyaasi` — sukebei.nyaa.si (en-US)

**live:**

- https://sukebei.nyaa.si/
- https://sukebei.nyaa.mom/

**legacy:**

- https://sukebei.nyaa.lol/

#### `thepiratebay` — The Pirate Bay (en-US)

**live:**

- https://thepiratebay.org/
- https://thepiratebay.unblockninja.com/
- https://thepiratebay.ninjaproxy1.com/
- https://tpb.proxyninja.org/
- https://thepiratebay.proxyninja.net/
- https://thepiratebay.torrentbay.st/
- https://tpb.skynetcloud.site/
- https://piratehaven.xyz/
- https://mirrorbay.top/
- https://thepiratebay0.org/
- https://thepiratebay10.xyz/
- https://pirateproxylive.org/
- https://thehiddenbay.com/
- https://thepiratebay.zone/
- https://tpb.party/
- https://piratebayproxy.live/
- https://piratebay.live/
- https://piratebay.party/
- https://thepiratebay.party/
- https://thepiratebaye.org/
- https://thepiratebay.cloud/
- https://tpb-proxy.xyz/
- https://tpb.re/
- https://tpirbay.site/
- https://tpirbay.top/
- https://tpirbay.xyz/

**legacy:**

- https://pirate-proxy.page/
- https://5mins.shop/
- https://tpb.surf/
- https://tpb.monster/
- https://thepiratebay.host/
- https://piratetoday.xyz/
- https://tpb.wtf/
- https://piratebayo3klnzokct3wt5yyxb2vpebbuyjl7m623iaxmqhsd52coid.onion.ly/
- https://piratebayo3klnzokct3wt5yyxb2vpebbuyjl7m623iaxmqhsd52coid.tor2web.to/
- https://piratebayo3klnzokct3wt5yyxb2vpebbuyjl7m623iaxmqhsd52coid.tor2web.link/
- https://tpb25.ukpass.co/
- https://tpb29.ukpass.co/
- https://piratenow.xyz/
- https://pirate-proxy.ink/
- https://proxifiedpiratebay.org/
- https://unlockedpiratebay.com/
- https://tpb.one/
- https://piratebayorg.net/
- https://tpbproxy.click/
- https://pirateproxy.live/
- https://ukpiratebay.org/
- https://piratebay.by/
- https://pirate-proxy.date/
- https://thepirateproxy.net/
- https://thepiratebay.abcproxy.org/
- https://tpb.proxyninja.net/
- https://tpb31.ukpass.co/
- https://thepiratebay10.org/
- https://pirate-proxy.africa/
- https://5mins.eu/
- https://piratebay.army/
- https://tpb-visit.me/
- https://pirate-proxy.ong/

#### `therarbg` — TheRARBG (en-US)

**live:**

- https://therarbg.to/
- https://therarbg.com/
- https://rarbg.ninjaproxy1.com/
- https://rarbg.proxyninja.org/
- https://rarbg.torrentbay.st/

**legacy:**

- https://t-rb.org/
- https://the.rarbg.club/
- https://trb.archivebay.online/
- https://trb.t-pb.org/
- https://trb.themirror.wiki/
- https://torrentlite.org/
- https://rarbg.torrentsbay.org/
- https://rarbg.unblockninja.com/
- https://rarbg.proxyninja.net/
- https://therar.site/

#### `tokyotosho` — Tokyo Toshokan (en-US)

**live:**

- https://www.tokyotosho.info/
- https://www.tokyotosho.se/
- https://tokyo-tosho.net/

**legacy:**

- https://tokyotosho.proxyportal.fun/
- https://tokyotosho.uk-unblock.xyz/
- https://tokyotosho.ind-unblock.xyz/
- https://tokyotosho.unblocked.bar/
- https://tokyotosho.proxyportal.pw/
- https://tokyotosho.uk-unblock.pro/
- https://tokyotosho.unblocked.rest/
- https://tokyotosho.unblocked.monster/
- https://tokyotosho.mrunblock.bond/
- https://tokyotosho.nocensor.cloud/

#### `torrent-pirat` — torrent-pirat (ru-RU)

**live:**

- http://www.torrent-pirat.com/

#### `torrent9` — Torrent9 (fr-FR)

**live:**

- https://www6.torrent9.to/

**legacy:**

- https://www.torrent9.pl/
- https://torrent9.black-mirror.xyz/
- https://torrent9.unblocked.casa/
- https://torrent9.proxyportal.fun/
- https://torrent9.uk-unblock.xyz/
- https://torrent9.ind-unblock.xyz/
- https://www.torrent9.fi/
- https://torrent9.ninjaproxy1.com/
- https://torrent9.proxyninja.org/
- https://torrent9.unblockninja.com/
- https://ww1.torrent9.to/
- https://www.torrent9.is/
- https://torrent9.li/
- https://www.oxtorrent.me/
- https://www.torrent9.gg/
- https://www.torrent9.fm/
- https://torrent9.se/
- https://www.torrent9.se/
- https://ww1.torrent9.fm/
- https://www.torrent9.zone/
- https://torrent9.to/
- https://ww2.torrent9.to/
- https://www5.torrent9.to/
- https://www.torrent9.club/

#### `torrentby` — torrent.by (ru-RU)

**live:**

- https://torrent.by/

**legacy:**

- http://torrent.by/

#### `torrentbyte` — TorrentByte (en-US)

**live:**

- https://torrentbyte.cc/

#### `torrentcore` — Torrent[CORE] (en-US)

**live:**

- https://torrentcore.xyz/

#### `torrentdownload` — TorrentDownload (en-US)

**live:**

- https://www.torrentdownload.info/

**legacy:**

- https://torrentdownload.mrunblock.bond/
- https://torrentdownload.nocensor.cloud/
- https://torrentdownload.unblockit.download/

#### `torrentdownloads` — Torrent Downloads (en-US)

**live:**

- https://www.torrentdownloads.pro/
- https://torrentdownloads.ninjaproxy1.com/
- https://torrentdownloads.proxyninja.org/

**legacy:**

- https://www.torrentdownloads.me/
- https://www.torrentdownloads.info/
- https://torrentdownloads.mrunblock.bond/
- https://torrentdownloads.nocensor.cloud/
- https://torrentdownloads.unblockit.download/
- https://torrentdownloads.unblockninja.com/
- https://torrentdownloads.proxyninja.net/

#### `torrentgalaxyclone` — TorrentGalaxyClone (en-US)

**live:**

- https://torrentgalaxy.one/
- https://torrentgalaxy.info/

**legacy:**

- https://torrentgalaxy.space/

#### `torrentkitty` — TorrentKitty (en-US)

**live:**

- https://www.torrentkitty.cam/
- https://www.torrentkitty.ink/
- https://www.torrentkitty.io/
- https://www.torrentkitty.vip/
- https://www.torrentkitty.app/
- https://www.torrentkitty.red/
- https://www.torrentkitty.lol/
- https://www.torrentkitty.best/
- https://www.torrentkitty.tv/
- https://torkitty.com/

**legacy:**

- https://www.torrentkitty.se/

#### `torrentoyunindir` — Torrent Oyun indir (tr-TR)

**live:**

- https://1.torrentoyunindir.com/

**legacy:**

- https://www.torrentoyunindir.com/
- http://0.torrentoyunindir.com/
- https://0.torrentoyunindir.com/

#### `torrentproject2` — TorrentProject2 (en-US)

**live:**

- https://torrentproject2.net/
- https://torrentproject2.org/
- https://torrentproject.info/
- https://torrentproject.biz/
- https://torrentproject.xyz/
- https://torrentproject.cc/

**legacy:**

- https://torrentproject2.se/
- https://torrentproject2.com/
- https://torrentproject.torrentbay.st/

#### `torrentsome` — Torrentsome (ko-KR)

**live:**

- https://torrentsome261.com/

**legacy:**

- https://torrentsome246.com/
- https://torrentsome247.com/
- https://torrentsome248.com/
- https://torrentsome249.com/
- https://torrentsome250.com/
- https://torrentsome251.com/
- https://torrentsome252.com/
- https://torrentsome253.com/
- https://torrentsome254.com/
- https://torrentsome255.com/
- https://torrentsome256.com/
- https://torrentsome257.com/
- https://torrentsome258.com/
- https://torrentsome259.com/
- https://torrentsome260.com/

#### `torrenttip` — Torrenttip (ko-KR)

**live:**

- https://torrenttip242.top/

**legacy:**

- https://torrenttip227.top/
- https://torrenttip228.top/
- https://torrenttip229.top/
- https://torrenttip230.top/
- https://torrenttip231.top/
- https://torrenttip232.top/
- https://torrenttip233.top/
- https://torrenttip234.top/
- https://torrenttip235.top/
- https://torrenttip236.top/
- https://torrenttip237.top/
- https://torrenttip238.top/
- https://torrenttip239.top/
- https://torrenttip240.top/
- https://torrenttip241.top/

#### `u2p` — U2P (fr-FR)

**live:**

- https://u2prelais.eliottb.dev/

**legacy:**

- https://ygg.gratis/
- https://u2p.anhkagi.net/

#### `u3c3` — U3C3 (zh-CN)

**live:**

- https://u3c3.com/
- https://u001.25img.com/
- https://u002.25img.com/
- https://u003.25img.com/
- https://u3c3u3c3.u3c3u3c3u3c3.com/

**legacy:**

- https://u3c3.in/
- https://a.u3c3.life/
- https://m0m0m0m.mnmnmnmnmn.com/
- https://m0m0m1m.mnmnmnmnmn.com/

#### `uindex` — Uindex (en-US)

**live:**

- https://uindex.org/

#### `vsthouse` — VSTHouse (ru-RU)

**live:**

- https://vsthouse.org/

**legacy:**

- http://vsthouse.ru/
- https://vsthouse.ru/

#### `vstorrent` — VSTorrent (en-US)

**live:**

- https://vstorrent.org/

#### `vsttorrents` — VST Torrentz (en-US)

**live:**

- https://vsttorrentz.net/

**legacy:**

- https://vsttorrents.net/
- https://looptorrent.net/

#### `world-torrent` — World-torrent (fr-FR)

**live:**

- https://www.darkfox4.cc/
- https://www.vidlox6.cc/
- https://www.worldivx.cc/
- https://www.wikibox3.cc/
- https://www.sharkibox.cc/
- https://www.workino.cc/
- https://www.oxtorrent5.ws/
- https://www.torrent911.wiki/

**legacy:**

- https://www.rantop.xyz/
- https://www.site-torrent.cc/
- https://www.torrent-site.cc/
- https://www.torrent-p2p.cc/
- https://www.protege-torrent.com/
- https://www.torrent.ws/
- https://www.protege-liens.com/
- https://www.protege-liens.net/
- https://www.torrent.onl/
- https://www.site-torrent.com/
- https://www.rantop.my/
- https://www.torrent-site.com/
- https://www.rantop.org/
- https://www.darkflix.cc/
- https://darkfox5.cc/
- https://ww1.fit/darkfox/
- https://www.darkfox2.cc/
- https://www.darkfox3.cc/
- https://vidlox.pw/
- https://vidlox5.cc/
- https://ww1.fit/vidlox/
- https://www.vidlox2.cc/
- https://www.vidlox3.cc/
- https://www.vidlox4.cc/
- https://wikibox3.cc/
- https://wikibox5.cc/
- https://ww1.fit/wikibox/
- https://www.wikibox1.cc/
- https://www.wikibox2.cc/
- https://www.sharkibox1.cc/
- https://www.worldivx1.cc/
- https://oxtorrent5.ws/
- https://oxtorrent.win/
- https://ww1.fit/oxtorrent/
- https://www.oxtorrent2.ws/
- https://www.oxtorrent3.ws/

#### `xxxclub` — XXXClub (en-US)

**live:**

- https://xxxclub.to/
- https://xxxclub.cc/
- https://xxxclub.me/

#### `xxxtor` — xxxtor (ru-RU)

**live:**

- https://xxxtor.com/

**legacy:**

- https://xxxtor.org/
- https://xxxtor.info/

#### `yts` — YTS (en-US)

**live:**

- https://yts.gg/
- https://yts.ninjaproxy1.com/
- https://yts.proxyninja.org/
- https://yts.proxyninja.net/
- https://yts.torrentbay.st/
- https://yts.torrentsbay.org/

**legacy:**

- https://yts.bz/
- https://yts.am/
- https://yts.ag/
- https://yts.lt/
- https://yts.mx/
- https://yts.mrunblock.bond/
- https://yts.nocensor.cloud/
- https://yts.unblockit.download/
- https://yts.unblockninja.com/

#### `zamundarip` — Zamunda RIP (bg-BG)

**live:**

- https://zamunda.rip/

---

## 4. Mirror topology: the proxy-farm layer

373 unique registrable domains serve 87 public indexers — but they are not 373 independent operators. A handful of **proxy farms** host mirrors for many different sites under one registrable domain, in the pattern `<indexer>.<farm>.<tld>`. Counted across the public definitions' `links:` + `legacylinks:`:

| farm domain          | indexers it fronts | which                                                                                                                                  |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `unblockninja.com`   | 11                 | `1337x`, `eztv`, `kickasstorrents-to`, `kickasstorrents-ws`, `limetorrents`, `nyaasi`, `thepiratebay`, `therarbg`, `torrent9` …        |
| `proxyninja.org`     | 10                 | `1337x`, `extratorrent-st`, `eztv`, `kickasstorrents-to`, `limetorrents`, `thepiratebay`, `therarbg`, `torrent9`, `torrentdownloads` … |
| `ninjaproxy1.com`    | 10                 | `1337x`, `extratorrent-st`, `eztv`, `kickasstorrents-to`, `limetorrents`, `thepiratebay`, `therarbg`, `torrent9`, `torrentdownloads` … |
| `mrunblock.bond`     | 10                 | `1337x`, `extratorrent-st`, `eztv`, `limetorrents`, `nyaasi`, `rutor`, `tokyotosho`, `torrentdownload`, `torrentdownloads` …           |
| `nocensor.cloud`     | 9                  | `extratorrent-st`, `eztv`, `limetorrents`, `nyaasi`, `rutor`, `tokyotosho`, `torrentdownload`, `torrentdownloads`, `yts`               |
| `proxyninja.net`     | 8                  | `1337x`, `extratorrent-st`, `kickasstorrents-to`, `limetorrents`, `thepiratebay`, `therarbg`, `torrentdownloads`, `yts`                |
| `unblockit.download` | 7                  | `1337x`, `extratorrent-st`, `eztv`, `limetorrents`, `torrentdownload`, `torrentdownloads`, `yts`                                       |
| `torrentbay.st`      | 6                  | `1337x`, `limetorrents`, `thepiratebay`, `therarbg`, `torrentproject2`, `yts`                                                          |
| `torrentsbay.org`    | 5                  | `1337x`, `kickasstorrents-to`, `limetorrents`, `therarbg`, `yts`                                                                       |
| `abcproxy.org`       | 5                  | `1337x`, `eztv`, `kickasstorrents-to`, `limetorrents`, `thepiratebay`                                                                  |
| `uk-unblock.xyz`     | 4                  | `nyaasi`, `rutor`, `tokyotosho`, `torrent9`                                                                                            |
| `ind-unblock.xyz`    | 4                  | `nyaasi`, `rutor`, `tokyotosho`, `torrent9`                                                                                            |
| `unblocked.bar`      | 3                  | `nyaasi`, `rutor`, `tokyotosho`                                                                                                        |
| `uk-unblock.pro`     | 3                  | `nyaasi`, `rutor`, `tokyotosho`                                                                                                        |
| `root.yt`            | 3                  | `kickasstorrents-to`, `nyaasi`, `rutor`                                                                                                |
| `proxyportal.pw`     | 3                  | `nyaasi`, `rutor`, `tokyotosho`                                                                                                        |
| `proxyportal.fun`    | 3                  | `nyaasi`, `tokyotosho`, `torrent9`                                                                                                     |

Why this matters for a discovery tool:

- **A farm is a single point of failure.** `unblockninja.com` fronting 11 indexers means one takedown removes 11 fallbacks at once. Treat farm-hosted mirrors as _correlated_, not independent, when ranking fallbacks.
- **A farm is also a single point of trust.** Every one of those mirrors is an MITM position on the site it proxies: the operator can rewrite magnet links and injected trackers. For a tool that follows magnets, prefer the site's own apex domain from `links:` over any `*.<farm>` mirror, and treat farm-sourced infohashes as lower confidence.
- Numeric throwaway domains (`529075.xyz`, `8800591.xyz` …) appear in blocks of consecutive numbers — a burner-domain rotation strategy, cheap to enumerate and cheap for the operator to abandon.

---

## 5. The Torznab API surface (verified against the running instance)

Base: `http://127.0.0.1:9117`. API key from `~/.config/Jackett/ServerConfig.json` → `APIKey` (masked in this report as `$KEY`).

### 5.1 Per-indexer Torznab

```
GET /api/v2.0/indexers/<id>/results/torznab/api?apikey=$KEY&t=caps
GET /api/v2.0/indexers/<id>/results/torznab/api?apikey=$KEY&t=search&q=<query>
GET /api/v2.0/indexers/<id>/results/torznab/api?apikey=$KEY&t=tvsearch&q=<q>&season=1&ep=2
GET /api/v2.0/indexers/<id>/results/torznab/api?apikey=$KEY&t=movie&q=<q>&imdbid=tt0111161
GET /api/v2.0/indexers/<id>/results/torznab/api?apikey=$KEY&t=music&q=<q>
GET /api/v2.0/indexers/<id>/results/torznab/api?apikey=$KEY&t=book&q=<q>
```

The trailing `/api` is optional in practice — `/results/torznab?apikey=…` works identically. Extra params: `&cat=2000,5000` (Newznab categories, comma-separated), `&limit=`, `&offset=`, `&extended=1`.

**Verified `t=caps` on `1337x`** → HTTP 200:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Jackett" />
  <limits default="100" max="100" />
  <searching>
    <search available="yes" supportedParams="q" searchEngine="raw" />
    <tv-search available="yes" supportedParams="q,season,ep" searchEngine="raw" />
    <movie-search available="yes" supportedParams="q" searchEngine="raw" />
    <music-search available="yes" supportedParams="q" searchEngine="raw" />
    <audio-search available="yes" supportedParams="q" searchEngine="raw" />
    <book-search available="yes" supportedParams="q" searchEngine="raw" />
  </searching>
  <categories>
    <category id="1000" name="Console"><subcat id="1010" name="Console/NDS" /> ...
  </categories>
</caps>
```

Note `limits max="100"` — **100 results per indexer per query is a hard ceiling**, so paginate with `&offset=` or fan out across indexers rather than expecting deep result sets.

### 5.2 Response shape (verified, `thepiratebay`, `q=ubuntu`, 100 items)

```xml
<rss version="2.0" xmlns:atom="..." xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>The Pirate Bay</title>
    <link>https://thepiratebay.org/</link>
    <language>en-US</language>
    <item>
      <title>Ubuntu 22.04 LTS</title>
      <guid>magnet:?xt=urn:btih:2C6B6858...&amp;dn=Ubuntu+22.04+LTS&amp;tr=udp%3A%2F%2F...</guid>
      <jackettindexer id="thepiratebay">The Pirate Bay</jackettindexer>
      <type>public</type>
      <comments>https://thepiratebay.org/description.php?id=59191690</comments>
      <pubDate>Wed, 18 May 2022 14:33:51 +0200</pubDate>
      <size>3654957056</size>
      <files>1</files>
      <description>Uploader: rjaa&lt;br&gt;Ubuntu 22.04 LTS</description>
      <link>magnet:?xt=urn:btih:2C6B6858...</link>
      <torznab:attr name="category" value="4000" />
      <torznab:attr name="category" value="100303" />   <!-- 100000+id = site-native cat -->
      <torznab:attr name="seeders" value="37" />
      <torznab:attr name="peers" value="41" />          <!-- peers = seeders+leechers -->
      <torznab:attr name="infohash" value="2C6B6858D61DA9543D4231A71DB4B1C9264B0685" />
      <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:..." />
      <torznab:attr name="downloadvolumefactor" value="0" />  <!-- 0 = freeleech -->
      <torznab:attr name="uploadvolumefactor" value="1" />
    </item>
  </channel>
</rss>
```

**`torznab:attr name="infohash"` is the field that matters most** for a discovery tool — it is the bare 40-hex infohash, no parsing of the magnet required, and it is the join key to the DHT and to tracker scrape.

### 5.3 The aggregate endpoints

Jackett synthesises four virtual indexers at startup (verbatim from the log): `all`, `type:public`, `type:private`, `type:semi-public`. They are used exactly like a real indexer id:

```
GET /api/v2.0/indexers/all/results/torznab/api?apikey=$KEY&t=search&q=ubuntu
GET /api/v2.0/indexers/type%3Apublic/results/torznab/api?apikey=$KEY&t=search&q=ubuntu
GET /api/v2.0/indexers/type%3Aprivate/results/torznab/api?apikey=$KEY&t=search&q=ubuntu
GET /api/v2.0/indexers/type%3Asemi-public/results/torznab/api?apikey=$KEY&t=search&q=ubuntu
```

The colon **must be percent-encoded as `%3A`**. Measured, this session:

| endpoint              | HTTP | bytes     | items    | wall time |
| --------------------- | ---- | --------- | -------- | --------- |
| `all` torznab         | 200  | 2,940,667 | **1039** | ~40 s     |
| `type:public` torznab | 200  | 2,940,685 | **1039** | —         |
| `all` JSON            | 200  | 2,022,479 | **1039** | —         |

`all` and `type:public` returned the same 1039 because all 79 configured indexers here happen to be public. The aggregate fans out **in parallel** and returns when the slowest indexer finishes or times out — budget ~40-60 s per aggregate query and never put one on a user-facing synchronous path.

### 5.4 Jackett's own JSON API (not Torznab, better for tooling)

```
GET /api/v2.0/indexers/<id|all>/results?apikey=$KEY&Query=ubuntu
      &Category[]=2000&Tracker[]=thepiratebay
```

Returns `{"Results": [...], "Indexers": [...]}` — same data as Torznab without XML parsing, **plus a per-indexer health block Torznab does not give you**:

```json
{
  "ID": "anilibria",
  "Name": "Anilibria",
  "Status": 2,
  "Results": 0,
  "Error": null,
  "ElapsedTime": 125
}
```

Result objects carry `Tracker`, `TrackerId`, `TrackerType`, `Title`, `Guid`, `Link`, `MagnetUri`, `InfoHash`, `Size`, `Seeders`, `Peers`, `PublishDate`, `CategoryDesc`, `DownloadVolumeFactor`. **Prefer this endpoint over Torznab for anything programmatic** — the `Indexers[]` block tells you which sites were dead for this query, which Torznab silently omits.

### 5.5 Admin endpoints need a cookie, not the API key

`GET /api/v2.0/indexers?configured=false&apikey=$KEY` returned **HTTP 302 → `/UI/Login`**, and following the redirect gave `400 Cookies required`. The API key authorises **`/results` only**; enumerating or configuring indexers requires a UI session cookie. To enumerate the catalogue programmatically, read `Definitions/*.yml` off disk (as this report does) rather than trying to call the admin API.

---

## 6. Live health of the configured set (verified, `q=ubuntu`, this session)

79 indexers configured, **55 OK / 24 errored**, 28 returned at least one result.

| failure mode                          | count  | indexers                                                                                                                                                                                                                                       |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare challenge, no FlareSolverr | **17** | `1337x`, `btdirectory`, `btetree`, `damagnet`, `extratorrent-st`, `eztv`, `kickasstorrents-to`, `kickasstorrents-ws`, `magnetcat`, `magnetz`, `sexypics`, `skidrowrepack`, `torrentbyte`, `torrentcore`, `torrentsome`, `torrenttip`, `uindex` |
| network / HTTP / timeout              | **7**  | `anisource`, `hdrtorrent`, `newstudio`, `redetorrent`, `tokyotosho`, `u2p`, `zamundarip`                                                                                                                                                       |

Top producers for that query: `torrentproject2` 158, `internetarchive` 100, `rutor` 100, `thepiratebay` 100, `knaben` 87, `torrentdownloads` 50, `noname-club` 50, `torrentdownload` 47, `torrentgalaxyclone` 41, `therarbg` 41, `52bt` 40, `limetorrents` 40.

## **Actionable:** `FlareSolverrUrl` is `null` in `ServerConfig.json`. Setting it (FlareSolverr is a headless-Chrome sidecar, normally `http://localhost:8191`) recovers 17 indexers including `1337x`, `eztv`, both `kickasstorrents` and `extratorrent-st`. That single config change is worth more than adding new indexers.

## 7. The native-indexer gap (important caveat on the YAML map)

The 554 YAML definitions are **not** the whole catalogue. Jackett also ships **65 native C#-coded indexers** compiled into `Jackett.Common.dll`, with no YAML on disk. Of the 79 indexers configured on this box, **11 have no YAML definition**:

`anilibria`, `apachetorrent`, `divxtotal`, `dontorrent`, `epublibre`, `hdrtorrent`, `knaben`, `redetorrent`, `subsplease`, `torrentscsv`, `wolfmax4k`

Two of these matter a lot for a discovery tool and are invisible to any YAML-only survey:

- **`knaben`** — a meta-indexer that itself aggregates many sites and exposes a JSON API. Returned 87 results in the live run.
- **`torrentscsv`** — a public, no-auth JSON API over a curated torrent database. Returned 25 results.

**Consequence:** the 87-indexer public map in §3 is the _YAML_ public set, not the complete public set. To enumerate natives, either read `/api/v2.0/indexers` with a UI cookie, or scrape `src/Jackett.Common/Indexers/Definitions/*.cs` from the GitHub repo. I did not do the latter — **[UNVERIFIED]** how many of the 65 natives are public.

---

## 8. Mirror-aggregator sites (every one below was curled this session)

| site                                 | HTTP        | what it publishes                                                                                                                                                                                                      | verdict                                                                                  |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `https://1337x-status.org/`          | 200, 9.3 KB | Official 1337x status page. Publishes exactly **one** live clearnet domain (`1337x.to`) plus a `.onion` (`l337xdarkkaqfwzntnfk5bmoaroivtl6xsbatabvlb52umg6v3ch44yd.onion`)                                             | **Authoritative, narrow.** Cited by the 1337x YAML itself                                |
| `https://yifystatus.com/`            | 200, 4.8 KB | Official YTS status. Lists `yts.bz`, `web.yts.gg`, `yts.lt`, `yts.am`, `yts.ag` + `.onion`                                                                                                                             | **Authoritative** for YTS                                                                |
| `https://ytsproxies.com/`            | 200, 8.8 KB | Official YTS proxy list, same domain set + `gosites.org`                                                                                                                                                               | **Authoritative** for YTS                                                                |
| `https://torrends.to/proxy/`         | 200, 37 KB  | Broad cross-site proxy list — 48 distinct hosts in one page: `pirateproxy.buzz`, `proxybay.xyz`, `knaben.ru`, `1337x.is`, `x1337x.se`, `x1337x.eu`, `rarbgmirror.com`, `torrentz2.is`, `yts.unblocked.win` …           | **Widest single source.** Third-party, ad-supported — treat as leads to probe, not truth |
| `https://unblockit.li/`              | 200, 160 KB | The Unblockit proxy farm's own index across many sites                                                                                                                                                                 | Live. It is a _farm_, so see §4 — it is both a source and an MITM position               |
| `https://tzip.top/`                  | 200, 20 KB  | Korean domain-finder (`토렌트주소`); cited by 2 YAML defs as the way to get their current domain                                                                                                                       | Live, non-English                                                                        |
| `https://www.rantop.org/`            | 200, 11 KB  | French "best download sites" ranking; cited by 1 YAML def                                                                                                                                                              | Live                                                                                     |
| `https://status.aither.cc/`          | 200, 23 KB  | Per-tracker status page (private tracker Aither)                                                                                                                                                                       | Live, single-site                                                                        |
| `https://about.empornium.ph/`        | 200, 480 B  | JS-only shell (`<title>Loading...`) — no domains in static HTML                                                                                                                                                        | Live but needs JS                                                                        |
| `https://thepiratebay-proxylist.se/` | 200, 1.1 KB | Near-empty stub, no proxy list in the body                                                                                                                                                                             | **Effectively dead**                                                                     |
| `https://sitenable.co/`              | 200, 23 KB  | Generic web-proxy service, not a torrent domain list                                                                                                                                                                   | Off-target                                                                               |
| `https://ant.trackerstatus.info/`    | **000**     | connection failed                                                                                                                                                                                                      | **Dead from here**                                                                       |
| `https://proxy-bay.app/`             | **000**     | connection failed                                                                                                                                                                                                      | **Dead from here**                                                                       |
| `https://piratebay-proxylist.net/`   | **404**     | Serves the website of **BREIN**, the Dutch anti-piracy foundation (Dutch-language 404: _"404, pagina niet gevonden"_, nav: _Inbreuk melden / Auteursrecht / WAMCA_). DNS → `104.21.45.4`, `172.67.207.10` (Cloudflare) | **SEIZED / repurposed by enforcement**                                                   |

### 8.1 The finding that should change behaviour

`piratebay-proxylist.net` — a well-known proxy aggregator — **now resolves to an anti-piracy organisation's web server**. Any tool that hard-codes aggregator domains and fetches them on a schedule is, in that case, sending its request pattern directly to an enforcement body.

Two rules follow:

1. **Never hard-code an aggregator domain as trusted.** Verify the response is the expected content type before parsing it, and fail closed on a mismatch.
2. **The YAML `links:`/`legacylinks:` lists are the better primary source anyway.** They are maintained by a large contributor base, versioned in git, fetched over one connection to GitHub, and carry no third-party ad/tracking surface. Aggregators should be a _fallback_ for filling gaps, not the front door.

### 8.2 Cross-check: definitions vs official status pages

The definitions are _broader_ than the official status pages, and the two disagree — which is a real signal about freshness.

|           | official status page says live                       | YAML `links:` says live                                                                                                       |
| --------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **1337x** | `1337x.to` only                                      | `1337x.to`, `1337x.st`, `x1337x.ws`, `x1337x.eu`, `x1337x.cc`                                                                 |
| **YTS**   | `yts.bz`, `web.yts.gg`, `yts.lt`, `yts.am`, `yts.ag` | `yts.gg` + 5 `*.proxyninja/torrentbay` farm mirrors — and it lists `yts.bz`/`yts.am`/`yts.ag`/`yts.lt`/`yts.mx` as **legacy** |

The YTS row is a direct contradiction: the official status page lists as _current_ four domains the YAML has already retired to `legacylinks`. **Neither source is reliable alone — probe before you trust either.**

---

## 9. How to actually drive this (recipes)

```bash
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.config/Jackett/ServerConfig.json'))['APIKey'])")
B=http://127.0.0.1:9117/api/v2.0/indexers

# start Jackett (see the warning below about persistence)
cd ~/.local/share/jackett/Jackett && ./jackett

# one indexer, XML
curl -s "$B/thepiratebay/results/torznab/api?apikey=$KEY&t=search&q=ubuntu"

# everything configured, JSON, with per-indexer health
curl -s "$B/all/results?apikey=$KEY&Query=ubuntu" | jq '.Indexers[] | select(.Error!=null) | .ID'

# just the infohashes — the join key to the DHT and to tracker scrape
curl -s "$B/all/results?apikey=$KEY&Query=ubuntu" \
  | jq -r '.Results[] | [.InfoHash, .Seeders, .Size, .Tracker, .Title] | @tsv'

# public-only aggregate (note the %3A)
curl -s "$B/type%3Apublic/results/torznab/api?apikey=$KEY&t=search&q=ubuntu"

# enumerate the catalogue WITHOUT the admin API — read the YAML off disk
grep -l '^type: public' ~/.local/share/jackett/Jackett/Definitions/*.yml | wc -l   # -> 87
```

**Operational warning, from this machine's own history:** Jackett here is a bare process, not a service — there is no systemd unit for it, and it was not running when this report started. A process launched from an agent turn does not survive that turn. If Jackett needs to be up for a tool to work, install it as a unit (`~/.local/share/jackett/Jackett/install_service_systemd.sh` ships with the install) rather than starting it ad hoc.

**Rate/politeness:** definitions carry `requestDelay` (3 s for 1337x). The aggregate fan-out ignores nothing but does run all indexers concurrently — a single `all` query is ~79 outbound site requests. Cache aggressively; `CacheEnabled: true`, `CacheTtl: 2100` (35 min) is already set in `ServerConfig.json`.

---

## 10. What is verified vs not

**Verified this session** (command output backing every claim): 554 YAML on disk; 87/61/406 type split; 197 public links + 335 public legacylinks; 707/618 across all defs; 373 unique registrable domains; local filename set byte-identical to `Jackett/Jackett@master` (554, via GitHub API, HTTP 200); latest release `v0.24.2541` 2026-09-06; 65 native + 554 Cardigann = 619 loaded; the four aggregate indexers and the Cardigann search paths (startup log); `t=caps` and `t=search` responses; the 1039-item aggregate at 40 s; the admin-API 302→cookie requirement; 55 OK / 24 errored with 17 Cloudflare; 11 configured indexers with no YAML; the HTTP status and content of all 13 aggregator domains; `piratebay-proxylist.net` → BREIN.

**[UNVERIFIED]** — flagged honestly:

- How many of the **65 native indexers** are public. I only proved 11 configured ones have no YAML; I did not enumerate the native catalogue.
- Whether each of the 197 public `links:` actually resolves right now. Only the 79 configured indexers were exercised, and only against a single query.
- Whether `1337x-status.org`, `yifystatus.com` and `ytsproxies.com` are genuinely operator-run or impersonations. They are _cited by the Jackett definitions_, which is meaningful but not proof.
- Prowlarr's definition set. **No Prowlarr on this machine.** Prowlarr uses the same Cardigann schema with a separate, larger definitions repo (`Prowlarr/Indexers`, versioned in `definitions/v9/`, `v10/` … subfolders) — I did not fetch it, so no count is claimed.

**One methodological note:** my first aggregator probe reused a single temp file, so failed fetches (HTTP 000) silently reported the _previous_ site's title. Three rows were wrong. The probe was rewritten with a per-URL file and re-run; §8 is the corrected pass. A probe whose failure case returns stale data is worse than no probe.

---

## 11. Two configuration facts worth acting on

Both read from `~/.config/Jackett/ServerConfig.json` on this machine:

1. **`"AllowExternal": true` with `"AdminPassword": null`.** Confirmed at runtime — the listening socket was `*:9117`, i.e. **every interface, not just loopback**, with no admin password set. Anyone who can reach the host on 9117 gets the Jackett UI. `LocalBindAddress` is `127.0.0.1` but `AllowExternal` overrides the effective bind. Either set `AllowExternal: false` or set an admin password before this box is on any untrusted network.
2. **`"FlareSolverrUrl": null`.** This is the 17-indexer fix from §6.

**State note:** Jackett was **not running** when this report began; I started it to verify the API surface and stopped it afterwards, leaving the machine as found. Nothing here requires it to stay up — §3's map comes from disk, not from the daemon.
