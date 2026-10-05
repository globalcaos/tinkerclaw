#!/usr/bin/env python3
"""
Measured per-DOMAIN strength of each model family, from Epoch AI's public benchmark
tables — the data behind THALAMUS's task-aware routing (src/shared/thalamus-frontier.ts)
and the dossier's "best at" marks.

the architect 2026-09-02: "make sure Thalamus routes intelligently depending on the task at
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
#
# WIDENED 2026-09-23 (the architect: the dossier's "best at" table must be more granular and must
# finally influence Thalamus). Eight domains became fifteen, and each one here is a
# TaskDomain in src/shared/thalamus-frontier.ts. Three rules were applied:
#
#  1. A TABLE GOES WHERE ITS QUESTION LIVES, not where it is convenient. SimpleQA Verified,
#     MMLU and TriviaQA moved out of "world" into "factual": they measure what the model
#     already knows, while WORLD's column claims live retrieval beyond the cut-off. Grading
#     one on the other is the two-bases error the dossier header forbids. WORLD keeps only
#     ForecastBench, which genuinely asks about events past the cut-off.
#  2. A NAME IS COPIED, NEVER REMEMBERED. Epoch's metadata spells several tables differently
#     from the way this map did ("ALE-Bench" not "ALE-bench", "EnigmaEval" not "Enigma Eval",
#     "Blueprint-Bench 2", "SpatialViz-Bench", "BTF-3", "GDP.pdf", "ForecastBench"). Every one
#     of those was silently unmapped. Both spellings are listed now; an alias costs nothing
#     and a missed table costs a whole domain.
#  3. A MAPPED TABLE WITH NO DATA FILE IS STILL WORTH MAPPING. Epoch lists WebDev Arena,
#     SciCode, SWE-bench Pro, Berkeley Function Calling, GraphWalks and HealthBench
#     Professional in its metadata with an EMPTY source_file, so they contribute nothing
#     today and are skipped by the loader below. Mapping them anyway means the domain lights
#     up by itself the day Epoch publishes the file, instead of waiting for someone to
#     remember. Until then those domains are JUDGED in the dossier and Thalamus falls back to
#     the plain bias pick, exactly as it does for any family with no run.
#
# Domains with NO Epoch table at all today: data, languages, instruct, psych, frontend (the
# WebDev Arena row is metadata-only). Their dossier columns say so in the header tooltip.
#
# WIDENED AGAIN 2026-10-02 (the architect: "find more verticals so we can better choose in Thalamus
# the best model per task"). Seven verticals, each a TaskDomain, and each fed by tables that
# were already here but averaged into a broader domain: Terminal Bench left CODE for SHELL;
# WeirdML and PostTrainBench left REASON/AGENTIC for ML; CadEval, Surface Evolver and
# Blueprint-Bench left VISION for CAD, joined by Furniture Assembly (29 rows, previously
# unmapped); DeepResearch Bench left AGENTIC for RESEARCH; GDPval/GDP.pdf and APEX-Agents
# left AGENTIC for OFFICE; Cybench and ExploitBench left AGENTIC for SECURITY; HealthBench
# Professional left FACTUAL for HEALTH (metadata-only today, so HEALTH is judged).
BENCH_DOMAIN: dict[str, str] = {
    # ── code: back-end implementation, debugging, real repositories
    "SWE-Bench verified": "code", "DeepSWE": "code", "Aider polyglot": "code",
    "FrontierCode": "code", "GSO-Bench": "code",
    "MirrorCode": "code", "CursorBench": "code", "ALE-bench": "code", "ALE-Bench": "code",
    "AlgoTune": "code", "SWE-bench Pro": "code", "FrontierSWE": "code",
    # ── shell: operating a machine from a terminal (2026-10-02, out of code)
    "Terminal Bench": "shell", "Terminal-Bench": "shell",
    # ── ml: training and debugging models (2026-10-02, out of reason / agentic)
    "WeirdML": "ml", "WeirdML v3": "ml", "PostTrainBench": "ml",
    # ── cad: 3D parts, assemblies, drawings (2026-10-02, out of vision)
    "CadEval": "cad", "Surface Evolver Bench": "cad", "Furniture Assembly": "cad",
    "Blueprint Bench 2": "cad", "Blueprint-Bench 2": "cad",
    # ── frontend: building a web UI. Epoch lists WebDev Arena but ships no rows for it, so
    #    this domain is unmeasured here; the dossier anchors it on the LMArena board instead.
    "WebDev Arena": "frontend",
    # ── agentic: act in an environment over many steps, finish a job
    "OSWorld": "agentic", "OSWorld 2.0": "agentic", "The Agent Company": "agentic",
    "Remote Labor Index": "agentic", "Vending-Bench 2": "agentic", "Balrog": "agentic",
    "EBR-bench": "agentic", "TextQuests": "agentic",
    "METR Time Horizons": "agentic", "METR": "agentic",
    "BTF3": "agentic", "BTF-3": "agentic",
    # ── research: web research ending in a sourced report (2026-10-02, out of agentic)
    "DeepResearch Bench": "research",
    # ── office: client deliverables — reports, decks, models (2026-10-02, out of agentic)
    "GDPval": "office", "GDP-PDF": "office", "GDP.pdf": "office", "APEX-Agents": "office",
    # ── security: finding and exploiting vulnerabilities (2026-10-02, out of agentic)
    "Cybench": "security", "ExploitBench": "security",
    # ── maths: proofs, competition problems, symbolic work
    "FrontierMath-2025-02-28-Private": "maths",
    "FrontierMath-Tier-4-2025-07-01-Private": "maths",
    "FrontierMath-Tiers-1-3-v2-Private": "maths", "FrontierMath-Tier-4-v2-Private": "maths",
    "FrontierMath-Erdos": "maths", "MATH level 5": "maths",
    "OTIS Mock AIME 2024-2025": "maths", "ProofBench": "maths", "GSM8K": "maths",
    # ── science: physics, chemistry, biology, research-grade domain questions
    "GPQA diamond": "science", "CritPt": "science", "HLE": "science", "ScienceQA": "science",
    "SciCode": "science",
    # ── reason: puzzles, logic, lateral thinking — what is left once maths and science go
    "ARC-AGI": "reason", "ARC-AGI-2": "reason", "SimpleBench": "reason",
    "Chess Puzzles": "reason", "Mystery Game Puzzles": "reason",
    "Enigma Eval": "reason", "EnigmaEval": "reason", "BBH": "reason",
    "DTBench": "reason", "LMCA": "reason",
    # ── write: prose for humans
    "Lech Mazur Writing": "write",
    # ── instruct: obeying an exact output format. Metadata-only today.
    "Berkeley Function Calling Leaderboard": "instruct",
    # ── context: useful recall across a very large input
    "Fiction.LiveBench": "context", "CL-bench": "context", "CL-bench Life": "context",
    "GraphWalks": "context",
    # ── vision / spatial
    "VPCT": "vision", "SpatialViz Bench": "vision", "SpatialViz-Bench": "vision",
    "Video-MME": "vision", "VideoMME": "vision", "MindCube": "vision",
    "GeoBench": "vision",
    # ── factual: knows things, and does not invent the rest
    "SimpleQA Verified": "factual", "MMLU": "factual", "TriviaQA": "factual",
    "OpenBookQA": "factual", "ARC AI2": "factual",
    # ── health: symptoms, medicines, care (2026-10-02, out of factual; metadata-only today)
    "HealthBench Professional": "health",
    # ── world: beyond the training cut-off. ForecastBench is the only honest candidate,
    #    and Epoch ships no rows for it, so WORLD is unmeasured on purpose.
    "Forecast Bench": "world", "ForecastBench": "world",
}

# DELIBERATELY NOT MAPPED, and this list is the difference between "we forgot" and "we
# decided" (verified against Epoch's metadata 2026-09-23, leaving exactly these ten
# unmapped): ANLI, BoolQ, CSQA2, HellaSwag, LAMBADA, PIQA, SuperGLUE and Winogrande are
# pre-2024 NLP tables that every current model saturates — a percentile over them ranks
# noise. GBAEval and LiveBench are listed by Epoch with no source file and no obvious
# domain, so they wait for data before they get one. If this script ever prints an
# unmapped benchmark that is NOT in this list, a table has been added upstream and this
# map owes it a domain.

# The domain order written into the generated TS. Must match TASK_DOMAINS in
# src/shared/thalamus-frontier.ts — a domain missing here is silently dropped from the
# table even when the benchmarks for it ran.
DOMAINS = [
    "code", "frontend", "shell", "data", "ml", "cad",
    "agentic", "research", "office", "security",
    "maths", "science", "reason",
    "write", "languages", "psych", "instruct",
    "context", "vision", "factual", "health", "world",
]


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
        for dom in DOMAINS:
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
