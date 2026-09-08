---
name: memory-bench-pioneer
version: 2.1.2
description: "Be one of the first to benchmark your agent's memory — and help shape how AI remembers. Peer-review-grade evaluation (LLM-as-judge, nDCG/MAP/MRR with 95% CIs, ablations) against your live memory system. Runs entirely LOCALLY by default — no memory content leaves your machine. The optional OpenAI judge is opt-in, prints exactly what it would send, redacts secrets first, requires typed consent, and refuses to run unattended. Submitting results is a separate confirmed step that previews every public field, and identifies you only if you pass --contributor. Built for the TinkerClaw fork — github.com/globalcaos/tinkerclaw. See Permissions, Data Flow & Consent."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "requires": { "bins": ["python3"] },
        "notes":
          {
            "security": "Benchmarks a LIVE memory database, so disclosure matters more than usual. DEFAULT PATH IS LOCAL: the default judge (--judge local) sends retrieved excerpts only to a local embedding server on 127.0.0.1; nothing leaves the machine. Two actions can send data out and BOTH are opt-in and confirmed: --judge openai transmits the benchmark query plus up to 300 redacted characters of each RETRIEVED MEMORY to api.openai.com (typed confirmation, or --yes-send-to-openai), and scripts/submit.sh opens a PUBLIC GitHub pull request containing the statistics report (--dry-run to preview, typed confirmation to publish, refuses non-interactively). Attribution is anonymous unless you pass --contributor; token/cost totals are excluded unless you pass --include-token-stats. rate.py WRITES a retrieval_log table into the database you point it at — use --db on a copy to sandbox it. No daemon, no cron, nothing runs on its own. See the Permissions, Data Flow & Consent section."
          },
      },
  }
---

# Memory Bench

> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.

Everyone has an opinion about whether their agent's memory is any good. Almost nobody has a number.

This produces the number — nDCG, MAP, MRR, Precision@5, each with a 95% bootstrap confidence interval, plus an ablation that isolates what spreading activation actually contributes. Then, if you want, it contributes your (anonymous) results to the ENGRAM and CORTEX research papers, where a few dozen real deployments beat any amount of arguing.

**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.

👉 **https://github.com/globalcaos/tinkerclaw**

_Clone it. Fork it. Break it. Make it yours._

## Three-Step Pipeline

Step 1 measures, step 2 summarises, step 3 publishes. Steps 1 and 2 are local. **Step 3 is the only one that uploads anything, and it asks first.**

### 1. Assess Retrieval Quality

Run the standard test set (30 queries across 4 types × 3 difficulty levels):

```bash
# Local judge — the default. Nothing leaves your machine.
python3 scripts/rate.py --queries 30 --judge local --ablation

# Stronger judge, but it TRANSMITS retrieved memory excerpts to OpenAI.
# You will be asked to type 'send' before the first request.
python3 scripts/rate.py --queries 30 --judge openai --ablation

# Benchmark a copy instead of your live database
python3 scripts/rate.py --db /tmp/memory-copy.db --judge local

# Custom test set
python3 scripts/rate.py --testset path/to/queries.json --judge local
```

**What it measures:**

- **RAR** (Recall Accuracy Ratio), **MRR** (Mean Reciprocal Rank)
- **nDCG@5**, **MAP@5**, **Precision@5**, **Hit Rate**
- All metrics include **95% bootstrap confidence intervals**
- **Ablation**: runs with AND without spreading activation to isolate its contribution

**Judge methods — this is the privacy decision in this skill:**

| Judge | What it sees | Where it goes | Cost |
| --- | --- | --- | --- |
| `local` **(default)** | query + 300 chars of each result | `http://127.0.0.1:8900/embed` on your own machine | free |
| `openai` | query + 300 **redacted** chars of each result | `api.openai.com`, gpt-4o-mini | ~$0.01/run |

The `openai` judge is more discriminating and independent of the retrieval system, which is why the research protocol prefers it. It is also the option that puts pieces of your memories in someone else's logs. Both are legitimate; pick deliberately, and see the consent section below for exactly what is sent.

**It writes to your database.** `rate.py` creates (or extends) a `retrieval_log` table in the database you point it at and inserts one row per benchmark query: the benchmark query text, the ratings, the metrics. Your memory content is never written there. `collect.py` reads that table later. If you would rather not touch your live DB, run both scripts with `--db` against a copy.

**Standard test set** (`scripts/testset.json`): 30 queries stratified across semantic/episodic/procedural/strategic types and easy/medium/hard difficulty. As of 2.1.0 the queries are phrased to probe the operational and technical side of your memory — configuration, procedures, incidents, architecture decisions — rather than family, health, contacts or calendar. All deployments run the same queries, so results are comparable across sites; reports produced with the pre-2.1.0 set are not directly comparable with these.

Note the honest limit: the queries steer *what is asked*, not *what your memory system returns*. Retrieval searches whatever database you point it at. If your memory holds things you would not want an external judge to rate, use `--judge local` (the default), or benchmark a filtered copy with `--db`.

### 2. Collect Statistics

```bash
# Anonymous — the default
python3 scripts/collect.py --days 14 --output /tmp/memory-bench-report.json

# Attributed to you (your username goes in the report, and it becomes public if you submit)
python3 scripts/collect.py --days 14 --contributor YOUR_GITHUB_USER --output /tmp/memory-bench-report.json
```

**What goes in the report:** memory counts, type/age distributions, strength and importance histograms, association graph size, hierarchy levels, consolidation run counts, embedding coverage, retrieval metrics from `retrieval_log` (RAR/MRR/nDCG/MAP, judge method, ablation config), the algorithm version as a short git SHA, and coarse system info (OS, CPU architecture, Python version, Node version). Instance ID is a random UUID.

**What never goes in it:** memory content, benchmark queries, file paths, hostnames, environment variables.

**Opt-in extras, off unless you ask:**

- `--contributor NAME` — your username. Without it the report says `anonymous`.
- `--include-token-stats` — total tokens and USD spend from your OpenClaw usage files.

`collect.py` uploads nothing. It writes a JSON file and tells you what is in it. Read that file before step 3.

### 3. Submit as PR — the step that publishes

```bash
# ALWAYS do this first: shows every field that would become public, uploads nothing
scripts/submit.sh /tmp/memory-bench-report.json --dry-run

# Real submission — prints the same preview, then asks you to type 'publish'
scripts/submit.sh /tmp/memory-bench-report.json YOUR_GITHUB_USERNAME
```

This forks `globalcaos/clawdbot-moltbot-openclaw`, pushes a branch to **your** fork, and opens a **public pull request** containing the report file. A merged PR is public and permanent. Requires the `gh` CLI, authenticated.

It refuses to run unattended: with no terminal to confirm on, it exits rather than publishing. `--yes` is available for scripted use and means you accept the upload.

## Permissions, Data Flow & Consent

Short version: steps 1 and 2 are local; step 3 publishes, and so does the optional OpenAI judge. Both ask first. Longer version, because you should not have to take that on trust:

**What it needs, and why.**

| Capability | Why | Scope |
| --- | --- | --- |
| Read your memory DB | Counts, histograms, and running the benchmark queries | `~/.openclaw/workspace/db/{memory,cognitive_memory,jarvis}.db`, or `--db` |
| **Write** your memory DB | `rate.py` logs one `retrieval_log` row per benchmark query | Same DB (or the copy you pass to `--db`); no other table is touched |
| File write | `<db_dir>/.memory-bench-instance-id` (random UUID, so repeat reports group together) and the `--output` report path | Two files, both of which you can delete |
| Read usage files | Token/cost totals — **only** with `--include-token-stats` | `~/.openclaw/workspace/memory/*-usage.json` |
| Local shell exec | `git log` for the algorithm SHA, `node --version` for system info, `git`/`gh` in `submit.sh` | Fixed commands |
| Network to localhost | Local judge embeddings | `http://127.0.0.1:8900/embed` — stays on the machine |
| Network to OpenAI | **Opt-in.** Query + up to 300 redacted chars per retrieved memory | `api.openai.com`, only with `--judge openai` after confirmation |
| Network to GitHub | **Opt-in.** Uploads the report and opens a public PR | `github.com`, only in `submit.sh` after confirmation |
| Credentials | `OPENAI_API_KEY` (env or `--api-key`) only when you choose the OpenAI judge; `gh`'s existing login in `submit.sh` | Read at call time, never stored, never written to the report |
| Scheduling | **None.** No daemon, no cron, no install hook. Nothing runs unless you run it | — |

**About that redaction.** Before an excerpt goes to OpenAI, `rate.py` replaces email addresses, phone-shaped numbers, API-key-shaped strings, long hex blobs, home directory paths and URL credentials with placeholders. That is pattern matching, not comprehension — it will not catch a secret written in prose. Treat it as a seatbelt, not a force field. If the content is genuinely sensitive, the answer is `--judge local`, not better regexes.

**Consent, concretely.** Two actions can leave your machine, and neither happens by accident:

```bash
# 1. External judging — prints exactly what will be sent, then waits
python3 scripts/rate.py --judge openai        # asks you to type 'send'
python3 scripts/rate.py --judge openai --yes-send-to-openai   # scripted consent

# 2. Publishing — prints every field that becomes public, then waits
scripts/submit.sh report.json --dry-run       # preview only, uploads nothing
scripts/submit.sh report.json                 # asks you to type 'publish'
```

Both refuse outright when there is no terminal to confirm on, so an agent running this unattended cannot publish on your behalf.

**Turning it off, and undoing it:**

```bash
# never transmit: just use the default judge and skip step 3
python3 scripts/rate.py --judge local

# benchmark a throwaway copy instead of your live memory
cp ~/.openclaw/workspace/db/memory.db /tmp/bench.db
python3 scripts/rate.py --db /tmp/bench.db --judge local

# forget this installation ever ran
rm ~/.openclaw/workspace/db/.memory-bench-instance-id
sqlite3 ~/.openclaw/workspace/db/memory.db 'DROP TABLE retrieval_log;'
```

Deleting the instance ID file makes your next report a new anonymous instance; it also breaks the longitudinal link, which is the trade.

**Read it before you run it.** Three scripts, all plain text, none of them long. `rate.py` is the only one that can talk to a third party and `submit.sh` is the only one that can publish — both are worth the two minutes.

## Validation Protocol

For peer-review-ready data, contributors should:

1. Run `rate.py --ablation` over the full N=30 test set
2. Use `--judge openai` if you are comfortable with the data flow above — it agrees better with human raters, and the script reports Cohen's κ between the two judges so you can see the gap on your own data. Local-judge submissions are still welcome and are marked as such in the report
3. Collect at least 2 reports from the same instance, ≥7 days apart (longitudinal)
4. Report the algorithm version (auto-captured as a short git SHA)

## Test Set Format

Custom test sets are JSON arrays:

```json
[
  {
    "id": "T01",
    "query": "...",
    "category": "semantic|episodic|procedural|strategic",
    "difficulty": "easy|medium|hard"
  }
]
```

An optional `notes` field is ignored by the runner.

## Included Files

| File | Purpose |
| --- | --- |
| `scripts/rate.py` | Runs the benchmark, judges results, computes metrics. Writes `retrieval_log`. The only script that can call an external API — opt-in and confirmed |
| `scripts/collect.py` | Builds the anonymous statistics report. Uploads nothing |
| `scripts/submit.sh` | Opens the public PR. Preview with `--dry-run`; requires typed confirmation |
| `scripts/testset.json` | The 30-query standard test set |
| `scripts/test_metrics.py` | Unit tests for the IR metrics (`python3 scripts/test_metrics.py`) |

Everything the documentation above describes is in this package. If you find a claim here that the code does not do, that is a bug — open an issue on [the repo](https://github.com/globalcaos/tinkerclaw/issues).

## Agent Workflow

When asked to benchmark memory: run `rate.py --ablation` (local judge) and then `collect.py`, and show the summary. **Do not run `submit.sh` on your own initiative** — it publishes to a public repository. Show the user the report, and use `submit.sh --dry-run` so they can see exactly what would become public. Submit only when they say to, and only with `--judge openai` if they have agreed to that separately. Then share the PR link.
