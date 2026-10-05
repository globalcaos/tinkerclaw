#!/usr/bin/env python3
"""movie-radar: trending new torrent releases -> poster grid for Tinker chat (```html-render).

Pipeline: YTS recent uploads -> IMDb GraphQL (live rating, votes, trend rank, plot, poster,
runtime, genres) -> filter -> top-N by trend -> sort by rating -> JustWatch streaming offers
(Netflix / Disney+ links) -> HTML block. Stdlib only. Personal, non-commercial use (IMDb terms).
"""
import argparse, concurrent.futures as cf, datetime as dt, html, json, os, re, sys, urllib.request

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
YTS = "https://yts.gg/api/v2/list_movies.json"  # yts.mx dead 2026-09; API says moving to movies-api.accel.li
IMDB_H = {"content-type": "application/json", "User-Agent": UA, "Origin": "https://www.imdb.com",
          "x-imdb-client-name": "imdb-web-next"}  # 403 without these
PROVIDERS = {"netflix": ("Netflix", "N", "#e50914", "#fff"), "disney": ("Disney+", "D+", "#0e3fbd", "#fff")}


def get(url, data=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers=headers or {"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def yts_pool(pages, min_year):
    out = {}
    def page(p):
        try:
            return get(f"{YTS}?sort_by=date_added&limit=50&page={p}")["data"].get("movies") or []
        except Exception as e:
            print(f"yts page {p}: {e}", file=sys.stderr); return []
    with cf.ThreadPoolExecutor(6) as ex:
        for ms in ex.map(page, range(1, pages + 1)):
            for m in ms:
                if m.get("imdb_code") and m.get("year", 0) >= min_year:
                    out[m["imdb_code"]] = m
    return list(out.values())


def imdb(ids):
    out = {}
    q = ("{ titles(ids:%s) { id titleText{text} releaseYear{year} ratingsSummary{aggregateRating voteCount} plot{plotText{plainText}} "
         "primaryImage{url} runtime{seconds} titleGenres{genres{genre{text}}} "
         "meterRanking{currentRank rankChange{changeDirection difference}} } }")
    for i in range(0, len(ids), 50):
        body = json.dumps({"query": q % json.dumps(ids[i:i + 50])}).encode()
        for t in get("https://api.graphql.imdb.com/", body, IMDB_H)["data"]["titles"]:
            if t: out[t["id"]] = t
    return out


def justwatch(title, imdb_id, country, lang):
    q = ("query($c:Country!,$l:Language!,$s:String!){popularTitles(country:$c,first:6,filter:{searchQuery:$s})"
         "{edges{node{... on Movie{content(country:$c,language:$l){externalIds{imdbId}} "
         "offers(country:$c,platform:WEB){monetizationType standardWebURL package{technicalName}}}}}}}")
    body = json.dumps({"query": q, "variables": {"c": country, "l": lang, "s": title}}).encode()
    try:
        edges = get("https://apis.justwatch.com/graphql", body, {"content-type": "application/json", "User-Agent": UA})["data"]["popularTitles"]["edges"]
    except Exception:
        return {}
    for e in edges:
        n = e.get("node") or {}
        if ((n.get("content") or {}).get("externalIds") or {}).get("imdbId") != imdb_id:
            continue  # match on IMDb id, never on title text
        found = {}
        for o in n.get("offers") or []:
            if o["monetizationType"] not in ("FLATRATE", "ADS", "FREE"): continue
            tn = o["package"]["technicalName"]
            key = "netflix" if tn.startswith("netflix") else "disney" if "disney" in tn else None
            if key and key not in found: found[key] = o["standardWebURL"]
        return found
    return {}


YEAR = re.compile(r"\b(19|20)\d{2}\b")


def title_key(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def release_key(name):
    """A downloaded release name -> the same key shape as an IMDb title.

    Release names are `Title.Words.YEAR.2160p.WEB-DL...`; everything from the year on is
    encoding metadata, so the year is where the title ends.
    """
    n = re.sub(r"\.(mkv|mp4|avi|aria2|torrent|part)$", "", name, flags=re.I).replace(".", " ").replace("_", " ")
    m = YEAR.search(n)
    if m: n = n[: m.start()]
    return title_key(n)


def already_have(dirs):
    """Films sitting in the download folder(s) — finished or still downloading."""
    keys = set()
    for d in dirs:
        d = os.path.expanduser(d.strip())
        if not d or not os.path.isdir(d): continue
        for name in os.listdir(d):
            k = release_key(name)
            if k: keys.add(k)
    return keys


def have_it(row, keys):
    k = title_key(row["title"])
    # exact match, or a long-enough key one side contains (release names carry extra words)
    return bool(k) and (k in keys or (len(k) >= 10 and any(k in h or h in k for h in keys)))


TPB = "https://apibay.org/precompiled/data_top100_{}207.json"  # 207 = HD movies; ranked by live seeders
CAM = re.compile(r"\b(CAM|HDCAM|TS|HDTS|TELESYNC|TC|TELECINE|SCR|SCREENER|R5|WORKPRINT|HQ ?Pre|PRE-?RELEASE)\b", re.I)


def torrent_top():
    """Aggregate TPB's current + 48h HD top-100 per IMDb id. Seeders are summed across releases."""
    agg = {}
    for window in ("", "48h_"):
        try:
            items = get(TPB.format(window))
        except Exception as e:
            print(f"tpb {window or 'top'}: {e}", file=sys.stderr); continue
        for it in items:
            iid = it.get("imdb")
            if not iid: continue
            r = agg.setdefault(iid, {"seed": 0, "hot48": 0, "clean": 0, "cam": 0, "names": []})
            if window: r["hot48"] += it["seeders"]; continue
            r["seed"] += it["seeders"]; r["names"].append(it["name"])
            r["cam" if CAM.search(it["name"].replace(".", " ")) else "clean"] += 1
    return agg


def cross(a):
    """Torrent popularity (what people actually share) x IMDb (what people rate/browse)."""
    tor = torrent_top()
    meta = imdb(list(tor))
    excl = {g.strip().lower() for g in a.exclude.split(",") if g.strip()}
    this_year = dt.date.today().year
    rows, dropped = [], {"cam": [], "genre": []}
    for iid, t in tor.items():
        m = meta.get(iid) or {}
        title = (m.get("titleText") or {}).get("text") or iid
        genres = [g["genre"]["text"] for g in ((m.get("titleGenres") or {}).get("genres") or [])]
        seed = t["seed"] or t["hot48"]
        if t["clean"] == 0 and t["cam"]: dropped["cam"].append((title, seed)); continue
        if excl & {g.lower() for g in genres}: dropped["genre"].append((title, seed)); continue
        rs, mr = m.get("ratingsSummary") or {}, m.get("meterRanking") or {}
        year = (m.get("releaseYear") or {}).get("year") or 0
        rows.append(dict(imdb=iid, title=title, year=year, rating=rs.get("aggregateRating") or 0, votes=rs.get("voteCount") or 0,
            genres=genres, mins=((m.get("runtime") or {}).get("seconds") or 0) // 60, k4=False,
            plot=((m.get("plot") or {}).get("plotText") or {}).get("plainText") or "", img=(m.get("primaryImage") or {}).get("url") or "",
            rank=mr.get("currentRank"), trend=(mr.get("rankChange") or {}).get("changeDirection"),
            seeders=seed, hot48=t["hot48"], old=bool(year and year < this_year - 1)))
    rows.sort(key=lambda r: -(r["seeders"] + r["hot48"]))
    for i, r in enumerate(rows, 1): r["trank"] = i
    # A film already on disk is not a recommendation. Drop BEFORE the cut so the grid backfills.
    have = already_have(a.have.split(":"))
    dropped["have"] = [r["title"] for r in rows if have_it(r, have)]
    rows = [r for r in rows if not have_it(r, have)]
    top = rows[: a.top]
    with cf.ThreadPoolExecutor(8) as ex:
        for r, s in zip(top, ex.map(lambda r: justwatch(r["title"], r["imdb"], a.country, a.lang), top)):
            r["stream"] = s
    imdb_top, _, _ = build(a)  # the IMDb-trend list, same filters
    tids = {r["imdb"] for r in top}
    both = [r for r in imdb_top if r["imdb"] in tids]
    imdb_only = [r for r in imdb_top if r["imdb"] not in tids]
    for r in top: r["in_imdb"] = r["imdb"] in {x["imdb"] for x in imdb_top}
    # A trending title he cannot watch is noise: an IMDb-only row survives only on Netflix / Disney+.
    streamable = [r for r in imdb_only if r.get("stream")]
    unwatchable = len(imdb_only) - len(streamable)
    # "good enough to join the grid" is RELATIVE to what is already on it, never an absolute number
    # someone else can rescale under us: at least the median rating AND a comparable audience.
    # The vote gate is load-bearing — a 3.5k-vote regional release rates 7.1 on fan votes alone and
    # would otherwise displace a film 10x more people watched (measured 2026-09-20).
    rated = sorted(r["rating"] for r in top if r["rating"])
    voted = sorted(r["votes"] for r in top if r["votes"])
    bar = rated[len(rated) // 2] if rated else 0
    reach = (voted[len(voted) // 2] if voted else 0) * a.blend_reach
    blend = sorted([r for r in streamable if r["rating"] >= bar and r["votes"] >= reach], key=lambda r: -r["rating"])[: a.blend]
    for r in blend: r.update(blend=True, seeders=0, hot48=0, trank=None, old=False, in_imdb=True)
    bids = {r["imdb"] for r in blend}
    grid = top[: max(0, a.top - len(blend))] + blend  # the grid stays a.top cards wide
    diff = dict(both=[r["title"] for r in both], imdb_only=[(r["title"], r["rank"]) for r in imdb_only],
                torrent_only=[(r["title"], r["year"], r["trank"]) for r in top if not r["in_imdb"]],
                old=[(r["title"], r["year"]) for r in top if r["old"]],
                old48=sorted([(r["title"], r["year"], r["hot48"], r["imdb"], r["rating"]) for r in rows if r["old"] and r["hot48"]], key=lambda x: -x[2])[:5],
                cam=sorted(dropped["cam"], key=lambda x: -x[1])[:6], genre=sorted(dropped["genre"], key=lambda x: -x[1])[:6],
                blended=[(r["title"], r["rating"], sorted(r["stream"])) for r in blend], bar=bar, unwatchable=unwatchable,
                have=dropped["have"],
                imdb_only_rows=[r for r in streamable if r["imdb"] not in bids])
    print(f"already downloaded, skipped {len(dropped['have'])}: {', '.join(dropped['have']) or 'none'}", file=sys.stderr)
    print(f"torrent titles {len(tor)} · watchable {len(rows)} · cam-only {len(dropped['cam'])} · "
          f"excluded genre {len(dropped['genre'])} · overlap with IMDb list {len(both)}/{len(imdb_top)} · "
          f"IMDb-only {len(imdb_only)} → streaming {len(streamable)} (dropped {unwatchable}) · "
          f"blended {len(blend)} at rating ≥ {bar} and ≥ {int(reach)} votes", file=sys.stderr)
    return grid, diff


def build(a):
    pool = yts_pool(a.pages, dt.date.today().year - a.years_back)
    meta = imdb([m["imdb_code"] for m in pool])
    excl = {g.strip().lower() for g in a.exclude.split(",") if g.strip()}
    rows = []
    for m in pool:
        t = meta.get(m["imdb_code"]) or {}
        rs = t.get("ratingsSummary") or {}
        if not rs.get("aggregateRating"): continue
        genres = [g["genre"]["text"] for g in ((t.get("titleGenres") or {}).get("genres") or [])] or (m.get("genres") or [])
        if excl & {g.lower() for g in set(genres) | set(m.get("genres") or [])}: continue  # FULL genre list, not YTS's first two
        if rs["voteCount"] < a.min_votes or rs["aggregateRating"] < a.min_rating: continue
        mr = t.get("meterRanking") or {}
        rows.append(dict(
            imdb=m["imdb_code"], title=m["title"], year=m["year"], rating=rs["aggregateRating"], votes=rs["voteCount"],
            genres=genres, mins=((t.get("runtime") or {}).get("seconds") or 0) // 60 or m.get("runtime") or 0,
            k4="2160p" in {x["quality"] for x in m.get("torrents", [])},
            plot=m.get("summary") or ((t.get("plot") or {}).get("plotText") or {}).get("plainText") or "",
            img=(t.get("primaryImage") or {}).get("url") or m.get("medium_cover_image") or "",
            rank=mr.get("currentRank"), trend=((mr.get("rankChange") or {}).get("changeDirection"))))
    have = already_have(a.have.split(":"))
    rows = [r for r in rows if not have_it(r, have)]  # nothing he already downloaded
    # select by TREND (IMDb MOVIEmeter), display by RATING
    rows.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, -r["votes"]))
    top = rows[: a.top]
    with cf.ThreadPoolExecutor(8) as ex:
        for r, s in zip(top, ex.map(lambda r: justwatch(r["title"], r["imdb"], a.country, a.lang), top)):
            r["stream"] = s
    top.sort(key=lambda r: (-r["rating"], -r["votes"]))
    print(f"pool {len(pool)} · passed filters {len(rows)} · shown {len(top)} · "
          f"streaming {sum(1 for r in top if r['stream'])}", file=sys.stderr)
    return top, len(pool), len(rows)


def fmt_votes(n): return (f"{n/1000:.1f}".rstrip("0").rstrip(".") + "k") if n >= 1000 else str(n)
def colour(r): return "#6ee7a0" if r >= 7 else "#f5c451" if r >= 6.5 else "#f39a5b"


def services(r):
    """Netflix / Disney+ chips — one clickable link per service that actually carries the film."""
    return "".join(
        f'<a href="{html.escape(url)}" target="_blank" title="Watch on {PROVIDERS[k][0]}">'
        f'<b style="background:{PROVIDERS[k][2]};color:{PROVIDERS[k][3]}">{PROVIDERS[k][1]}</b>{PROVIDERS[k][0]}</a>'
        for k, url in (r.get("stream") or {}).items())


CSS = """:root{--bg:#15100c;--line:#33271d;--ink:#f3e9da;--mute:#9d8b74;--gold:#f0c877}
body{background:var(--bg);color:var(--ink);padding:14px 14px 18px;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;word-break:normal;overflow-wrap:normal}
.hd{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:6px 16px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--line)}
.hd h1{margin:0;font-size:18px;font-weight:800;letter-spacing:-.2px}.hd h1 span{color:var(--gold)}
.hd .f{display:flex;gap:5px;flex-wrap:wrap}.hd .f i{font-style:normal;font-size:10.5px;color:var(--mute);border:1px solid var(--line);border-radius:99px;padding:2px 8px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:16px 12px}
.c{min-width:0}
.p{display:block;position:relative;aspect-ratio:2/3;border-radius:8px;overflow:hidden;background:#0d0906;box-shadow:0 4px 14px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.05);transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s}
.p img{width:100%;height:100%;object-fit:cover;display:block}
.k{position:absolute;top:5px;right:5px;font-size:8.5px;font-weight:900;letter-spacing:.5px;color:#1a1208;background:var(--gold);border-radius:3px;padding:1px 4px}
.tr{position:absolute;top:5px;left:5px;font-size:9px;font-weight:800;color:#ffd9a8;background:rgba(15,10,6,.82);border:1px solid rgba(240,200,119,.35);border-radius:4px;padding:1px 4px}
.s{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;padding:9px;background:linear-gradient(to top,rgba(12,8,5,.98) 55%,rgba(12,8,5,.75));opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}
.s p{margin:0;font-size:10.5px;line-height:1.4;color:#eadcc6;display:-webkit-box;-webkit-line-clamp:9;-webkit-box-orient:vertical;overflow:hidden}
.s span{margin-top:6px;font-size:9.5px;font-weight:700;color:var(--gold)}
.c:hover .p,.p:focus-visible{transform:translateY(-4px) scale(1.03);box-shadow:0 12px 26px rgba(0,0,0,.6),0 0 0 1px var(--gold)}
.c:hover .s,.p:focus-visible .s{opacity:1;transform:none}
.rr{display:flex;align-items:center;gap:6px;margin-top:-15px;position:relative;z-index:2;padding-left:5px;height:30px;transition:transform .25s cubic-bezier(.2,.8,.2,1)}
.c:hover .rr{transform:translateY(-4px)}
.ring{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:conic-gradient(var(--c) calc(var(--p)*1%),#3a2d22 0);position:relative;box-shadow:0 2px 6px rgba(0,0,0,.6)}
.ring::before{content:"";position:absolute;inset:3px;border-radius:50%;background:#120d09}
.ring b{position:relative;font-size:10.5px;font-weight:800;color:var(--c)}
.rr .vt{margin-top:14px;font-size:9.5px;color:var(--mute);white-space:nowrap}.rr .vt i{font-style:normal}
.t{margin-top:5px;font-size:12px;font-weight:700;line-height:1.22;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mt{margin-top:3px;font-size:10px;color:#c7b499}
.gn{margin-top:1px;font-size:10px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sv{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
.sv a{display:inline-flex;align-items:center;gap:4px;text-decoration:none;font-size:9.5px;font-weight:700;border-radius:5px;padding:2px 6px 2px 3px;background:#261c14;border:1px solid var(--line);color:var(--ink);transition:border-color .2s,background .2s}
.sv a:hover{border-color:var(--gold);background:#2f2319}
.sv b{display:grid;place-items:center;min-width:15px;height:15px;border-radius:3px;font-size:8.5px;font-weight:900;padding:0 2px}
@media(max-width:520px){.rr .vt i{display:none}body{padding:10px}.g{grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:12px 8px}.t{font-size:11px}.hd h1{font-size:15px}}"""


def render(top, a, n_pool, n_pass):
    cards = []
    for r in top:
        img = r["img"].replace("._V1_.jpg", "._V1_UX200_.jpg")
        trend = ""
        if r["rank"]:
            arrow = {"UP": "▲", "DOWN": "▼"}.get(r["trend"], "")
            trend = f'<span class="tr" title="IMDb MOVIEmeter rank">🔥 #{r["rank"]}{(" " + arrow) if arrow else ""}</span>'
        sv = services(r)
        mins = f'{r["mins"]//60}h{r["mins"]%60:02d}' if r["mins"] else ""
        cards.append(
            f'<div class="c"><a class="p" href="https://www.imdb.com/title/{r["imdb"]}/" target="_blank">'
            f'<img src="{html.escape(img)}" alt="" loading="lazy">{trend}{"<span class=k>4K</span>" if r["k4"] else ""}'
            f'<div class="s"><p>{html.escape(r["plot"])}</p><span>IMDb ↗</span></div></a>'
            f'<div class="rr"><div class="ring" style="--p:{r["rating"]*10:.0f};--c:{colour(r["rating"])}"><b>{r["rating"]:.1f}</b></div>'
            f'<span class="vt">{fmt_votes(r["votes"])}<i> votes</i></span></div>'
            f'<div class="t">{html.escape(r["title"])}</div><div class="mt">{r["year"]}{" · " + mins if mins else ""}</div>'
            f'<div class="gn">{" · ".join(html.escape(g) for g in r["genres"][:2])}</div>'
            f'{f"<div class=sv>{sv}</div>" if sv else ""}</div>')
    chips = [f"{len(top)} most trending", f"IMDb ≥ {a.min_rating:g} · {fmt_votes(a.min_votes)}+ votes"]
    if a.exclude: chips.append("no " + a.exclude.lower().replace(",", ", "))
    chips += [f"streaming: {a.country}", "hover for synopsis"]
    month = dt.date.today().strftime("%b %Y")
    return (f"<style>{CSS}</style>\n<div class=\"hd\"><h1>🎬 New on torrents <span>· {month}</span></h1>"
            f"<div class=\"f\">{''.join(f'<i>{html.escape(c)}</i>' for c in chips)}</div></div>\n"
            f"<div class=\"g\">{''.join(cards)}</div>\n"
            "<script>/* forces the sandboxed-iframe render path: a script-free block is DOMPurified inline and loses <style> */</script>")


CROSS_CSS = """.tr.tt{background:rgba(10,20,30,.85);border-color:rgba(120,190,255,.45);color:#bfe3ff}
.tr.st{background:rgba(35,10,14,.88);border-color:rgba(229,9,20,.55);color:#ffc9cd}
.mini .sv{margin-top:3px}.mini .sv a{font-size:9px;padding:1px 5px 1px 2px}
.mini{align-items:flex-start}.mini img{margin-top:2px}
.old{position:absolute;bottom:5px;right:5px;font-size:9px;font-weight:800;color:#1a1208;background:#9fd3a8;border-radius:3px;padding:1px 4px}
.both{display:inline-block;margin-top:4px;font-size:9px;font-weight:700;color:#ffd9a8}
.both.no{color:#6f5f4c;font-weight:600}
.dif{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px 18px}
.dif h2{margin:0 0 7px;font-size:12px;font-weight:800;color:var(--gold)}.dif h2 small{color:var(--mute);font-weight:600}
.mini{display:flex;gap:8px;align-items:center;text-decoration:none;color:inherit;padding:3px 0}
.mini img{width:30px;height:45px;object-fit:cover;border-radius:3px;flex:none;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.mini b{font-size:11px;display:block}.mini span{font-size:9.5px;color:var(--mute)}
.pill{display:inline-block;font-size:10px;color:#d8c6a8;background:#261c14;border:1px solid var(--line);border-radius:99px;padding:2px 8px;margin:0 4px 4px 0}"""


def render_cross(top, diff, a):
    cards = []
    for r in top:
        img = r["img"].replace("._V1_.jpg", "._V1_UX200_.jpg")
        seeds = fmt_votes(r["seeders"] + r["hot48"])
        badge = (f'<span class="tr st" title="Trending on IMDb and streaming on {" / ".join(PROVIDERS[k][0] for k in r["stream"])} — no torrent needed">▶ stream</span>'
                 if r.get("blend") else
                 f'<span class="tr tt" title="Torrent rank by live seeders (TPB HD top-100, current + 48h)">🧲 #{r["trank"]} · {seeds}</span>')
        old = f'<span class="old" title="Old film being shared again">♻ {r["year"]}</span>' if r["old"] else ""
        if r.get("blend"):
            cross = f'<span class="both">🔥 IMDb #{r["rank"]} · watch it now</span>'
        elif r["in_imdb"] and r["rank"]:
            cross = f'<span class="both">✓ both lists · 🔥 IMDb #{r["rank"]}</span>'
        elif r["rank"]:
            cross = f'<span class="both no">IMDb trend #{r["rank"]}</span>'
        else:
            cross = '<span class="both no">torrent-only</span>'
        sv = services(r)
        mins = f'{r["mins"]//60}h{r["mins"]%60:02d}' if r["mins"] else ""
        rating = f'{r["rating"]:.1f}' if r["rating"] else "–"
        cards.append(
            f'<div class="c"><a class="p" href="https://www.imdb.com/title/{r["imdb"]}/" target="_blank">'
            f'<img src="{html.escape(img)}" alt="" loading="lazy">{badge}{old}'
            f'<div class="s"><p>{html.escape(r["plot"])}</p><span>IMDb ↗</span></div></a>'
            f'<div class="rr"><div class="ring" style="--p:{r["rating"]*10:.0f};--c:{colour(r["rating"])}"><b>{rating}</b></div>'
            f'<span class="vt">{fmt_votes(r["votes"])}<i> votes</i></span></div>'
            f'<div class="t">{html.escape(r["title"])}</div><div class="mt">{r["year"] or ""}{" · " + mins if mins else ""}</div>'
            f'<div class="gn">{" · ".join(html.escape(g) for g in r["genres"][:2])}</div>{cross}'
            f'{f"<div class=sv>{sv}</div>" if sv else ""}</div>')
    minis = "".join(
        f'<div class="mini"><a href="https://www.imdb.com/title/{r["imdb"]}/" target="_blank"><img src="{html.escape(r["img"].replace("._V1_.jpg", "._V1_UX80_.jpg"))}" alt=""></a>'
        f'<div><b>{html.escape(r["title"])}</b><span>🔥 IMDb #{r["rank"]} · ★ {r["rating"]:.1f}</span>'
        f'<div class="sv">{services(r)}</div></div></div>'
        for r in diff["imdb_only_rows"][:8])
    cams = "".join(f'<span class="pill">{html.escape(t)} · {fmt_votes(n)}</span>' for t, n in diff["cam"])
    olds = "".join(f'<a class="pill" style="text-decoration:none" href="https://www.imdb.com/title/{i}/" target="_blank">{html.escape(t)} ({y}) · ★ {r_:.1f} · {fmt_votes(n)} seeders/48h</a>' for t, y, n, i, r_ in diff.get("old48", []))
    gens = "".join(f'<span class="pill">{html.escape(t)} · {fmt_votes(n)}</span>' for t, n in diff["genre"])
    chips = ["ranked by live torrent seeders", "IMDb rating + trend", "no " + a.exclude.lower() if a.exclude else "", "no cinema recordings",
             f"+ {len(diff['blended'])} streaming pick" + ("s" if len(diff['blended']) != 1 else "") if diff.get("blended") else "",
             f"{len(diff['have'])} already downloaded" if diff.get("have") else "", "hover for synopsis"]
    hidden = f" · {diff['unwatchable']} hidden, nowhere to watch" if diff.get("unwatchable") else ""
    head = f"🔥 Trending on IMDb · watch tonight <small>· {len(diff['imdb_only_rows'])} on Netflix / Disney+{hidden}</small>"
    month = dt.date.today().strftime("%b %Y")
    return (f"<style>{CSS}\n{CROSS_CSS}</style>\n<div class=\"hd\"><h1>🧲 Most shared on torrents <span>· {month}</span></h1>"
            f"<div class=\"f\">{''.join(f'<i>{html.escape(c)}</i>' for c in chips if c)}</div></div>\n"
            f"<div class=\"g\">{''.join(cards)}</div>\n"
            f"<div class=\"dif\"><div><h2>{head}</h2>{minis or '<span class=pill>none streaming right now</span>'}</div>"
            f"<div><h2>🎥 Heavily shared, but only as cinema recordings <small>· not watchable yet</small></h2>{cams or '<span class=pill>none</span>'}"
            f"<h2 style=\"margin-top:12px\">♻ Old films surging in the last 48 h</h2>{olds or '<span class=pill>none</span>'}"
            f"<h2 style=\"margin-top:12px\">🚫 Filtered by your genre rule</h2>{gens or '<span class=pill>none</span>'}</div></div>\n"
            "<script>/* forces the sandboxed-iframe render path: a script-free block is DOMPurified inline and loses <style> */</script>")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=["imdb", "cross"], default="cross", help="cross = torrent seeders x IMDb (default); imdb = IMDb trend only")
    ap.add_argument("--top", type=int, default=14)
    ap.add_argument("--pages", type=int, default=12, help="YTS pages of 50 recent uploads")
    ap.add_argument("--years-back", type=int, default=1)
    ap.add_argument("--min-votes", type=int, default=1000)
    ap.add_argument("--min-rating", type=float, default=6.0)
    ap.add_argument("--exclude", default="Horror", help="comma list of genres to drop")
    ap.add_argument("--have", default="~/Downloads/torrent-scout", help="colon-separated dirs of films already downloaded; they are skipped. Empty = show everything")
    ap.add_argument("--blend", type=int, default=4, help="max IMDb-trending titles (streaming only) promoted into the grid")
    ap.add_argument("--blend-reach", type=float, default=0.33, help="a blended title needs this share of the grid's median vote count")
    ap.add_argument("--country", default="ES"); ap.add_argument("--lang", default="es")
    ap.add_argument("--out", default=os.path.expanduser("~/.openclaw/workspace/renders/movie-radar"))
    a = ap.parse_args()
    if a.mode == "cross":
        top, diff = cross(a)
        block = render_cross(top, diff, a)
        json.dump({k: v for k, v in diff.items() if k != "imdb_only_rows"}, open(os.path.join(a.out, "diff.json") if os.path.isdir(a.out) else "/dev/null", "w"), indent=1, ensure_ascii=False)
    else:
        top, n_pool, n_pass = build(a)
        block = render(top, a, n_pool, n_pass)
    os.makedirs(a.out, exist_ok=True)
    open(f"{a.out}/block.html", "w").write(block)
    json.dump(top, open(f"{a.out}/data.json", "w"), indent=1, ensure_ascii=False)
    # preview wrapped in the SAME base reset the chat iframe injects (htmlRenderFrame in tinker-ui app.ts)
    base = ("<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;max-width:100%;overflow-x:hidden}"
            "body{padding:8px;font-family:system-ui;color:#1a1a1a;overflow-wrap:anywhere;word-break:break-word}"
            "body>*{width:100%}img,svg,video,canvas,iframe{max-width:100%;height:auto}</style>")
    open(f"{a.out}/preview.html", "w").write(f"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>{base}</head><body>{block}</body></html>")
    print(f"{a.out}/block.html")
