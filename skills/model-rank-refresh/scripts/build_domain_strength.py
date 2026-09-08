#!/usr/bin/env python3
"""
Measured per-DOMAIN strength of each model family, from Epoch AI's public benchmark
tables — the data behind THALAMUS's task-aware routing (src/shared/thalamus-frontier.ts)
and the dossier's "best at" marks.

the operator 2026-09-02: "make sure Thalamus routes intelligently depending on the task at
hand, following the Fugu family of harnesses approach." FUGU routes each query to the
worker with the best MEASURED competence in that query's domain (J6 §3.6 specified the
same thing in Feb 2026 as domain-specific CDI). This script produces that competence
table from public measurements instead of opinions.

Method: each Epoch benchmark table is assigned to one dossier domain (BENCH_DOMAIN).
For each table, take every family's BEST run (max over efforts / dated versions),
restrict to models released in the last RECENT_MONTHS so the percentile is among
current competition, and rank → percentile in [0,1]. A family's domain strength is
the mean percentile over the domain's tables it ran on, with n = how many.

Output: src/shared/domain-strength.generated.ts + memory/domain-strength.json.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import subprocess
import sys
import zipfile
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estimate_effort_index import fam, fetch  # noqa: E402

WS = os.path.expanduser("~/.openclaw/workspace")
TC = os.path.expanduser("~/src/tinkerclaw")
RECENT_MONTHS = 12

# Dossier domain per Epoch benchmark (names as in benchmark_metadata.csv "benchmark").
BENCH_DOMAIN: dict[str, str] = {
    # code
    "SWE-Bench verified": "code", "DeepSWE": "code", "Aider polyglot": "code",
    "Terminal Bench": "code", "FrontierCode": "code", "GSO-Bench": "code",
    "MirrorCode": "code", "CursorBench": "code", "ALE-bench": "code", "AlgoTune": "code",
    # reason (math / science / puzzles)
    "GPQA diamond": "reason", "HLE": "reason", "CritPt": "reason",
    "FrontierMath-2025-02-28-Private": "reason", "FrontierMath-Tier-4-2025-07-01-Private": "reason",
    "FrontierMath-Tiers-1-3-v2-Private": "reason", "FrontierMath-Tier-4-v2-Private": "reason",
    "MATH level 5": "reason", "OTIS Mock AIME 2024-2025": "reason", "ARC-AGI": "reason",
    "ARC-AGI-2": "reason", "ProofBench": "reason", "SimpleBench": "reason", "WeirdML": "reason",
    "Chess Puzzles": "reason", "Mystery Game Puzzles": "reason", "Enigma Eval": "reason",
    # agentic (act in an environment / do a job)
    "APEX-Agents": "agentic", "GDPval": "agentic", "GDP-PDF": "agentic", "OSWorld": "agentic",
    "OSWorld 2.0": "agentic", "The Agent Company": "agentic", "Remote Labor Index": "agentic",
    "Vending-Bench 2": "agentic", "Balrog": "agentic", "DeepResearch Bench": "agentic",
    "Cybench": "agentic", "METR Time Horizons": "agentic", "METR": "agentic", "PostTrainBench": "agentic",
    "BTF3": "agentic",
    # writing
    "Lech Mazur Writing": "write",
    # world knowledge
    "SimpleQA Verified": "world", "MMLU": "world", "TriviaQA": "world", "GeoBench": "world",
    "Forecast Bench": "world", "ForecastBench": "world",
    # long context
    "Fiction.LiveBench": "context", "CL-bench": "context", "CL-bench Life": "context",
    # vision / spatial
    "VPCT": "vision", "SpatialViz Bench": "vision", "Video-MME": "vision", "VideoMME": "vision", "MindCube": "vision",
    "Blueprint Bench 2": "vision", "CadEval": "vision", "Surface Evolver Bench": "vision",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epoch-zip")
    ap.add_argument("--json", default=f"{WS}/memory/domain-strength.json")
    ap.add_argument("--ts", default=f"{TC}/src/shared/domain-strength.generated.ts")
    args = ap.parse_args()

    zb = open(args.epoch_zip, "rb").read() if args.epoch_zip else fetch("https://epoch.ai/data/benchmark_data.zip")
    if len(zb) < 100_000:
        print("epoch zip suspiciously small — refusing", file=sys.stderr)
        return 2
    z = zipfile.ZipFile(io.BytesIO(zb))
    meta = list(csv.DictReader(io.TextIOWrapper(z.open("benchmark_metadata.csv"), encoding="utf-8")))
    cutoff = (dt.date.today() - dt.timedelta(days=30 * RECENT_MONTHS)).isoformat()
    skipcols = {"Model version", "Release date", "Organization", "Country", "Training compute (FLOP)",
                "Training compute notes", "Name", "id", "Notes", "Source", "Source link"}
    unmapped: list[str] = []
    # domain -> bench -> fam -> best score
    best: dict[str, dict[str, dict[str, float]]] = defaultdict(lambda: defaultdict(dict))
    for m in meta:
        b = m["benchmark"]
        dom = BENCH_DOMAIN.get(b)
        if dom is None:
            unmapped.append(b)
            continue
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
        for r in rows:
            try:
                s = float(r.get(col, ""))
            except ValueError:
                continue
            if (r.get("Release date") or "0000") < cutoff:
                continue
            # Epoch's "Model version" is <model>_<variant>: the variant may be an effort
            # (max), a thinking budget (32K), or a tag (unknown, none, promax). All of
            # them are the same FAMILY for a best-run percentile, so strip at the first _.
            f = fam(r["Model version"].split("_", 1)[0])
            if s > best[dom][b].get(f, -1e9):
                best[dom][b][f] = s

    # percentile per (domain, bench)
    strength: dict[str, dict[str, dict]] = defaultdict(dict)  # fam -> dom -> {p,n,basis}
    acc: dict[tuple[str, str], list[tuple[float, str]]] = defaultdict(list)
    for dom, benches in best.items():
        for b, scores in benches.items():
            if len(scores) < 4:
                continue  # a percentile among three models is noise
            ranked = sorted(scores.items(), key=lambda kv: kv[1])
            n = len(ranked)
            for i, (f, _s) in enumerate(ranked):
                # mid-rank percentile, ties share (cheap and good enough)
                p = (i + 0.5) / n
                acc[(f, dom)].append((p, b))
    for (f, dom), lst in acc.items():
        strength[f][dom] = {
            "p": round(sum(p for p, _b in lst) / len(lst), 3),
            "n": len(lst),
            "basis": sorted(b for _p, b in lst),
        }

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out = {
        "retrievedAt": now,
        "source": "https://epoch.ai/data/benchmark_data.zip",
        "recentMonths": RECENT_MONTHS,
        "note": "Mean percentile of each family's BEST run per benchmark, among models released in the last "
                f"{RECENT_MONTHS} months, over the benchmarks mapped to each dossier domain. Regenerate: "
                "model-rank-refresh/scripts/build_domain_strength.py",
        "unmappedBenchmarks": sorted(set(unmapped)),
        "families": {f: v for f, v in sorted(strength.items())},
    }
    os.makedirs(os.path.dirname(args.json), exist_ok=True)
    with open(args.json, "w") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")

    lines = [
        "// src/shared/domain-strength.generated.ts",
        "// GENERATED by model-rank-refresh/scripts/build_domain_strength.py — do not hand-edit.",
        f"// Retrieved: {now}",
        "//",
        "// MEASURED per-domain strength of each model family: the mean PERCENTILE of the",
        f"// family's best run on every Epoch AI benchmark mapped to the domain, among models",
        f"// released in the last {RECENT_MONTHS} months. This is the competence table THALAMUS",
        "// routes on (Fugu / J6 §3.6: expertise-matched routing) and the dossier marks",
        "// 'best at' from. p is 0..1, n is how many benchmarks in the domain ran the family.",
        "// A family absent here has NO public per-domain run — it is not assumed weak.",
        "",
        'import type { DomainStrength, TaskDomain } from "./thalamus-frontier.js";',
        "",
        "export const DOMAIN_STRENGTH: Record<string, Partial<Record<TaskDomain, DomainStrength>>> = {",
    ]
    for f, doms in out["families"].items():
        lines.append(f'  "{f}": {{')
        for dom in ["code", "agentic", "reason", "write", "psych", "context", "vision", "world"]:
            c = doms.get(dom)
            if not c:
                continue
            basis = ", ".join(json.dumps(b) for b in c["basis"])
            lines.append(f'    {dom}: {{ p: {c["p"]}, n: {c["n"]}, basis: [{basis}] }},')
        lines.append("  },")
    lines += ["};", ""]
    with open(args.ts, "w") as fh:
        fh.write("\n".join(lines))
    oxfmt = os.path.join(TC, "node_modules", ".bin", "oxfmt")
    if os.path.exists(oxfmt):
        subprocess.run([oxfmt, "--write", args.ts], check=False, capture_output=True)
    print(f"families={len(out['families'])} unmapped benchmarks={len(out['unmappedBenchmarks'])}: {', '.join(out['unmappedBenchmarks'])}")
    print(f"wrote {args.json}\nwrote {args.ts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
