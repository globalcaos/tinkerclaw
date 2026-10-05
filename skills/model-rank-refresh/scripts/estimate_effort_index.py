#!/usr/bin/env python3
"""
Estimate the Artificial Analysis Intelligence Index for (model family, thinking
effort) cells AA never published, from OTHER public measurements.

the operator, 2026-09-02 evening: "You must certainly be able to find other benchmarks,
other intelligence index measurements, even if you have to approximate the ones
we don't know for sure, right?"  This script is that approximation, with the
method stated on every number so the chart can draw it as an ESTIMATE and never
as a measurement.

Sources (all public, all fetched live):
  · Epoch AI Benchmarking Hub  https://epoch.ai/data/benchmark_data.zip  (CC-BY)
    ~80 benchmark tables; "Model version" carries the effort as a suffix
    (claude-opus-4-8_medium, gemini-3.6-flash_low ...). NOTE Epoch's own
    Capabilities Index (ECI) is ONE number per model copied onto every effort
    row, so it cannot split efforts; the per-benchmark tables can.
  · LMArena text leaderboard  https://lmarena.ai/leaderboard/text
    Elo per model key; some keys name an effort (gpt-5.5-high, claude-opus-5-max).

Method, per missing cell:
  1. BENCHMARK FIT — for each benchmark, least-squares AA = a + b·score over the
     cells where AA published a per-effort number and the benchmark ran at that
     same effort. Keep fits with n ≥ MIN_N and R² ≥ MIN_R2. Predict the missing
     cell from every kept benchmark that ran it; combine by R²-weighted mean.
     Reported spread = weighted std-dev of the per-benchmark predictions.
  2. LADDER SHAPE — take the mean AA RATIO between (this effort) and (the model's
     nearest measured effort) over the families AA measured at BOTH efforts, and
     apply it to the measured rung. Uses only AA's own numbers, so it mixes no
     scales, but assumes an average ladder shape — reported as such.
  3. BLEND — when both exist, inverse-variance weighted mean.
  4. LADDER ORDER — clamp between the model's measured neighbours, then
     pool-adjacent-violators so estimates never decrease with effort.
  A cell AA measured is never estimated. A family with no AA rung and no fitted
  benchmark run gets nothing, and is reported as unanchored.

Outputs:
  · JSON sidecar (--json)   default memory/aa-effort-estimate.json
  · TypeScript table (--ts) default src/shared/aa-effort-estimate.ts
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import statistics
import sys
import urllib.request
import zipfile
from collections import defaultdict

EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"]
EFFSET = set(EFFORTS)
MIN_N = 6
MIN_R2 = 0.55
WS = os.path.expanduser("~/.openclaw/workspace")
TC = os.path.expanduser("~/src/tinkerclaw")
UA = {"User-Agent": "Mozilla/5.0 (tinkerclaw model-rank-refresh)"}


def fetch(url: str, timeout: int = 90) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# Same aliases as tinker-ui/src/panels/aa-effort-index.ts AA_FAMILY_ALIASES: ids that
# share an AA family slug. Keep the two in step.
FAMILY_ALIASES = {
    "claude-sonnet-4-6": "claude-sonnet-4-6-adaptive",
    "claude-opus-4-6": "claude-opus-4-6-adaptive",
    "deepseek-v4-flash-0731": "deepseek-v4-flash",
    "deepseek-v4-pro-0813": "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp": "deepseek-v4-flash-vision",
    "claude-opus-5-fast": "claude-opus-5",
    "qwen3-8-max-0902": "qwen3-8-max",
}


def fam(name: str) -> str:
    """Family key on the AA convention: lowercase, dots→hyphens, no date/preview tail."""
    b = name.lower().replace(".", "-")
    b = re.sub(r"-(20\d{6}|20\d\d-\d\d-\d\d)$", "", b)
    b = re.sub(r"-preview$", "", b)
    b = re.sub(r"-pre-release$", "", b)
    return FAMILY_ALIASES.get(b, b)


def split_effort(v: str) -> tuple[str, str | None]:
    if "_" in v:
        b, e = v.rsplit("_", 1)
        if e in EFFSET:
            return b, e
    return v, None


# ───────────────────────── sources ─────────────────────────
def load_epoch(zip_bytes: bytes) -> dict[tuple[str, str], dict[str, float]]:
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    meta = list(csv.DictReader(io.TextIOWrapper(z.open("benchmark_metadata.csv"), encoding="utf-8")))
    cells: dict[tuple[str, str], dict[str, float]] = defaultdict(dict)
    skipcols = {"Model version", "Release date", "Organization", "Country", "Training compute (FLOP)",
                "Training compute notes", "Name", "id", "Notes", "Source", "Source link"}
    for m in meta:
        src = m["source_file"]
        if not src or src.endswith("/"):
            continue
        try:
            rows = list(csv.DictReader(io.TextIOWrapper(z.open(src), encoding="utf-8")))
        except KeyError:
            continue
        if not rows:
            continue
        col = m["score_column"]
        if col not in rows[0]:
            cands = [k for k in rows[0] if k not in skipcols]
            if not cands:
                continue
            col = cands[0]
        scale = float(m["scale"] or 1) or 1.0
        for r in rows:
            try:
                s = float(r.get(col, ""))
            except ValueError:
                continue
            b, e = split_effort(r["Model version"])
            if e is None:
                continue
            cells[(fam(b), e)][m["benchmark"]] = s / scale
    return cells


LM_KEY = re.compile(r"^(?P<base>.+?)-(?P<eff>minimal|low|medium|high|xhigh|max)(?:-text)?$")


def load_lmarena(html: str) -> dict[tuple[str, str], float]:
    pat = re.compile(
        r'\\"modelKey\\":\\"([^\\]+)\\",\\"modelDisplayName\\":\\"[^\\]+\\",\\"rating\\":([0-9.]+),'
        r'\\"ratingUpper\\":[0-9.]+,\\"ratingLower\\":[0-9.]+,\\"votes\\":(\d+)')
    best: dict[str, tuple[float, int]] = {}
    for key, rating, votes in pat.findall(html):
        v = int(votes)
        if key not in best or v > best[key][1]:
            best[key] = (float(rating), v)
    out: dict[tuple[str, str], float] = {}
    for key, (rating, _v) in best.items():
        mm = LM_KEY.match(key)
        if not mm:
            continue
        out[(fam(mm["base"]), mm["eff"])] = rating
    return out


# ───────────────────────── fitting ─────────────────────────
def linfit(xs: list[float], ys: list[float]) -> tuple[float, float, float, float]:
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return 0.0, my, 0.0, float("inf")
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a = my - b * mx
    ss_res = sum((y - (a + b * x)) ** 2 for x, y in zip(xs, ys))
    ss_tot = sum((y - my) ** 2 for y in ys) or 1e-9
    r2 = 1 - ss_res / ss_tot
    rmse = math.sqrt(ss_res / n)
    return a, b, r2, rmse


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--aa", default=f"{WS}/memory/aa-effort-index.json")
    ap.add_argument("--json", default=f"{WS}/memory/aa-effort-estimate.json")
    ap.add_argument("--ts", default=f"{TC}/src/shared/aa-effort-estimate.ts")
    ap.add_argument("--epoch-zip", help="use a local copy instead of fetching")
    ap.add_argument("--lmarena-html", help="use a local copy instead of fetching")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    aa = json.load(open(args.aa))["families"]

    epoch_bytes = open(args.epoch_zip, "rb").read() if args.epoch_zip else fetch("https://epoch.ai/data/benchmark_data.zip")
    if len(epoch_bytes) < 100_000:
        print(f"epoch zip suspiciously small ({len(epoch_bytes)} B) — refusing", file=sys.stderr)
        return 2
    cells = load_epoch(epoch_bytes)
    try:
        lm_html = (open(args.lmarena_html, encoding="utf-8", errors="ignore").read() if args.lmarena_html
                   else fetch("https://lmarena.ai/leaderboard/text").decode("utf-8", "ignore"))
        lm = load_lmarena(lm_html)
    except Exception as ex:  # LMArena is optional
        print(f"lmarena unavailable: {ex}", file=sys.stderr)
        lm = {}
    for k, v in lm.items():
        cells[k]["LMArena text Elo"] = v

    # 1. per-benchmark fits on cells AA measured
    bench_pts: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for (f, e), scores in cells.items():
        y = aa.get(f, {}).get(e)
        if y is None:
            continue
        for b, x in scores.items():
            bench_pts[b].append((x, y))
    fits: dict[str, dict] = {}
    for b, pts in bench_pts.items():
        if len(pts) < MIN_N:
            continue
        a, s, r2, rmse = linfit([p[0] for p in pts], [p[1] for p in pts])
        if r2 >= MIN_R2 and s > 0:
            fits[b] = {"a": a, "b": s, "r2": r2, "rmse": rmse, "n": len(pts)}

    # 2. shape deltas from AA's own multi-rung families
    idx = {e: i for i, e in enumerate(EFFORTS)}
    # (from_eff, to_eff) -> [AA ratio to_eff/from_eff]. A RATIO, not a delta: a 10-point
    # drop means something different at index 25 than at 63, and ratios cluster tighter
    # across AA's ladders (low/max ≈ 0.80–0.90 on every frontier ladder).
    ratios: dict[tuple[str, str], list[float]] = defaultdict(list)
    for f, row in aa.items():
        effs = [e for e in EFFORTS if e in row and row[e] > 0]
        for e1 in effs:
            for e2 in effs:
                if e1 != e2:
                    ratios[(e1, e2)].append(row[e2] / row[e1])

    estimates: dict[str, dict[str, dict]] = defaultdict(dict)
    unanchored: set[str] = set()
    families = set(aa) | {f for (f, _e) in cells}
    for f in sorted(families):
        row = aa.get(f, {})
        measured = [e for e in EFFORTS if e in row]
        for e in EFFORTS:
            if e in row:
                continue  # AA measured it — never estimate over a measurement
            # (a) benchmark fit — predicts AA directly, needs no AA anchor
            fit_v = fit_sd = None
            basis: list[str] = []
            preds = []
            for b, x in cells.get((f, e), {}).items():
                fit = fits.get(b)
                if fit:
                    preds.append((fit["a"] + fit["b"] * x, fit["r2"], fit["rmse"], b))
            if preds:
                w = sum(p[1] for p in preds)
                fit_v = sum(p[0] * p[1] for p in preds) / w
                spread2 = sum(p[1] * (p[0] - fit_v) ** 2 for p in preds) / w
                noise2 = sum(p[1] * p[2] ** 2 for p in preds) / w
                fit_sd = math.sqrt(spread2 + noise2)
                basis = sorted(p[3] for p in preds)
            # (b) ladder shape — nearest measured rung × mean AA ratio for that pair
            shape_v = shape_sd = None
            if measured:
                for m in sorted(measured, key=lambda m: abs(idx[m] - idx[e])):
                    rs = ratios.get((m, e))
                    if rs and len(rs) >= 3:
                        shape_v = row[m] * statistics.mean(rs)
                        shape_sd = max(row[m] * statistics.pstdev(rs), 0.8)
                        basis.append(f"{m}→{e} ratio over {len(rs)} AA ladders")
                        break
            if fit_v is None and shape_v is None:
                continue
            if fit_v is not None and shape_v is not None:
                wf, ws = 1 / fit_sd**2, 1 / shape_sd**2
                v = (fit_v * wf + shape_v * ws) / (wf + ws)
                sd = math.sqrt(1 / (wf + ws))
                method = "blend"
            elif fit_v is not None:
                v, sd, method = fit_v, fit_sd, "benchmark-fit"
            else:
                v, sd, method = shape_v, shape_sd, "ladder-shape"
            estimates[f][e] = {"v": v, "sd": sd, "method": method, "basis": basis}
        if not measured and f not in estimates and any(ff == f for (ff, _e) in cells):
            unanchored.add(f)
        # (c) ladder order — an estimate may not sit above a measured HIGHER effort or
        # below a measured LOWER one, and estimates keep non-decreasing order among
        # themselves (pool-adjacent-violators). Measured cells never move.
        est_row = estimates.get(f)
        if est_row:
            for e in list(EFFORTS):
                c = est_row.get(e)
                if not c:
                    continue
                lo = max([row[m] for m in measured if idx[m] < idx[e]], default=-math.inf)
                hi = min([row[m] for m in measured if idx[m] > idx[e]], default=math.inf)
                if lo > hi:
                    # Measured ladder inverts across this effort (gpt-oss-20b on
                    # 2026-09-08: low 9.95 > high 9.04). There is no interval an
                    # estimate can honestly sit in; drop the cell rather than emit
                    # one that fails the clamp contract.
                    del est_row[e]
                    continue
                clamped = min(max(c["v"], lo), hi)
                if clamped != c["v"]:
                    c["basis"] = c["basis"] + ["clamped to measured neighbours"]
                    c["v"] = clamped
            # PAV over consecutive estimated efforts between the same measured bounds
            order = [e for e in EFFORTS if e in est_row]
            vals = [est_row[e]["v"] for e in order]
            blocks = [[i] for i in range(len(vals))]
            merged = True
            while merged and len(blocks) > 1:
                merged = False
                for i in range(len(blocks) - 1):
                    a_mean = statistics.mean(vals[j] for j in blocks[i])
                    b_mean = statistics.mean(vals[j] for j in blocks[i + 1])
                    # only pool if no measured rung separates the two blocks
                    sep = any(idx[order[blocks[i][-1]]] < idx[m] < idx[order[blocks[i + 1][0]]] for m in measured)
                    if a_mean > b_mean and not sep:
                        blocks[i:i + 2] = [blocks[i] + blocks[i + 1]]
                        merged = True
                        break
            for blk in blocks:
                mval = statistics.mean(vals[j] for j in blk)
                for j in blk:
                    if abs(est_row[order[j]]["v"] - mval) > 1e-9:
                        est_row[order[j]]["basis"] = est_row[order[j]]["basis"] + ["pooled for ladder order"]
                    est_row[order[j]]["v"] = mval
            for c in est_row.values():
                c["v"] = round(c["v"], 2)
                c["sd"] = round(c["sd"], 2)

    n_cells = sum(len(v) for v in estimates.values())
    n_fit = sum(1 for v in estimates.values() for c in v.values() if c["method"] != "ladder-shape")
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    summary = {
        "retrievedAt": now,
        "sources": ["https://epoch.ai/data/benchmark_data.zip", "https://lmarena.ai/leaderboard/text"],
        "note": ("ESTIMATES of the AA Intelligence Index for effort cells AA did not publish. "
                 "Never overrides a measured AA cell. method=benchmark-fit: R²-weighted mean of per-benchmark "
                 "linear fits AA~score over cells both scored; method=ladder-shape: measured rung × mean AA "
                 "ratio between those two efforts across AA's own multi-rung families; method=blend: both, "
                 "inverse-variance weighted. Estimates are clamped between the model's measured neighbours and "
                 "kept non-decreasing (pool-adjacent-violators). sd = 1σ of the estimate. Regenerate: model-rank-refresh/scripts/estimate_effort_index.py"),
        "fits": {b: {k: (round(v, 4) if isinstance(v, float) else v) for k, v in f.items()} for b, f in sorted(fits.items(), key=lambda kv: -kv[1]["r2"])},
        "unanchored": sorted(unanchored),
        "families": {f: v for f, v in sorted(estimates.items())},
    }
    print(f"benchmarks fitted={len(fits)} (of {len(bench_pts)} with any overlap) · "
          f"estimated cells={n_cells} (benchmark-informed={n_fit}, ladder-shape only={n_cells - n_fit}) · "
          f"families={len(estimates)} · unanchored families={len(unanchored)}")
    for b, f in summary["fits"].items():
        print(f"  {b:38} n={f['n']:3} R²={f['r2']:.2f} rmse={f['rmse']:.1f}")
    if args.dry_run:
        return 0

    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w") as fh:
        json.dump(summary, fh, indent=1)
        fh.write("\n")

    lines = [
        "// tinker-ui/src/panels/aa-effort-estimate.ts",
        "// GENERATED by model-rank-refresh/scripts/estimate_effort_index.py — do not hand-edit.",
        f"// Retrieved: {now}",
        "//",
        "// ESTIMATED Artificial Analysis Intelligence Index for (family, effort) cells AA did",
        "// not publish. the operator 2026-09-02: approximate from other measurements, as long as the",
        "// chart never confuses an estimate with a measurement. Two methods, both named on",
        "// every cell:",
        "//   benchmark-fit — R²-weighted mean of per-benchmark linear fits AA ~ a + b·score,",
        "//                   fitted on cells AA DID score at that effort; basis lists the",
        "//                   benchmarks that ran this model at this effort (Epoch AI hub,",
        "//                   LMArena text Elo).",
        "//   ladder-shape  — the model's nearest AA-measured rung × the mean AA ratio",
        "//                   between those two efforts over AA's own multi-rung families.",
        "//                   Assumes an average ladder shape; sd is the spread of those ratios.",
        "//   blend         — both, inverse-variance weighted.",
        "// Every estimate is clamped between the model's measured neighbours and kept",
        "// non-decreasing across efforts (pool-adjacent-violators), because a ladder",
        "// whose 'high' outscores its measured 'max' is noise, not a finding.",
        "// A cell AA measured is NEVER here — aa-effort-index.ts wins.",
        "//",
        "// Fits kept (n ≥ %d, R² ≥ %.2f):" % (MIN_N, MIN_R2),
    ]
    for b, f in summary["fits"].items():
        lines.append(f"//   {b}: n={f['n']} R²={f['r2']:.2f} rmse={f['rmse']:.1f}")
    lines += [
        "",
        'import type { AaEffort } from "./aa-effort-index.js";',
        "",
        "export interface AaEstimate {",
        "  /** Estimated AA Intelligence Index. */",
        "  v: number;",
        "  /** Spread of the estimate, AA points. */",
        "  sd: number;",
        '  method: "benchmark-fit" | "ladder-shape" | "blend";',
        "  /** Benchmarks (or the AA-ladder delta) the number rests on. */",
        "  basis: string[];",
        "}",
        "",
        "export const AA_EFFORT_ESTIMATE: Record<string, Partial<Record<AaEffort, AaEstimate>>> = {",
    ]
    for f, row in summary["families"].items():
        lines.append(f'  "{f}": {{')
        for e in EFFORTS:
            c = row.get(e)
            if not c:
                continue
            basis = ", ".join(json.dumps(b) for b in c["basis"])
            lines.append(f'    {e}: {{ v: {c["v"]}, sd: {c["sd"]}, method: "{c["method"]}", basis: [{basis}] }},')
        lines.append("  },")
    lines += ["};", ""]
    os.makedirs(os.path.dirname(args.ts), exist_ok=True)
    with open(args.ts, "w") as fh:
        fh.write("\n".join(lines))
    # tinkerclaw's pre-commit hook runs oxfmt and re-stages; format here so a
    # regeneration is diff-free against the committed file instead of a 2,000-line
    # reflow on every run.
    oxfmt = os.path.join(TC, "node_modules", ".bin", "oxfmt")
    if os.path.exists(oxfmt):
        import subprocess
        subprocess.run([oxfmt, "--write", args.ts], check=False, capture_output=True)
    print(f"wrote {args.json}\nwrote {args.ts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
