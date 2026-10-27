---
name: memory-pioneer
description: "Benchmarks an agent's local memory SQLite database: runs a 30-query test set through it, scores retrieval with an LLM or embedding judge (nDCG, MAP, MRR, bootstrap CIs, optional ablation), emits an anonymized JSON report, and can open a public PR with it. Use when asked to measure or compare memory retrieval quality."
---

# memory-pioneer

Evaluation tooling for a local agent-memory database. It answers "how good is
this memory system's recall, in numbers?" — it does not store, edit or serve
memories itself.

Three stages, each a separate script and each usable on its own:

1. **rate** — run a fixed test set of queries against the live memory system,
   have a judge rate each returned result 1–5, compute IR metrics, write the
   per-query rows into a `retrieval_log` table.
2. **collect** — read the database and emit a single anonymized JSON report
   (counts, distributions, histograms, aggregated metrics). No memory text.
3. **submit** — open a pull request adding that JSON report to a public repo.

The scripts look for the database at `~/.openclaw/workspace/db/memory.db`, then
`cognitive_memory.db`, then `jarvis.db`; `--db PATH` overrides. If no database
is found they exit with an error.

## When to use / when not to

Use it when the operator wants to measure retrieval quality, compare two
retrieval configurations (the `--ablation` flag runs with and without spreading
activation and prints the delta), produce a stats report about a memory
database, or contribute such a report upstream.

Do not use it to read, search, write or recall actual memories — it has no such
entry point. Do not use it as a general SQLite tool. Do not run `submit.sh`
unless the operator has asked to publish; it pushes to a public repository.

## Commands

All scripts are in `scripts/`.

```bash
# Score retrieval. Judge defaults to OpenAI; see the data-flow note below.
python3 scripts/rate.py --judge local
python3 scripts/rate.py --judge openai --ablation --queries 30
python3 scripts/rate.py --db ~/path/to/memory.db --testset scripts/testset.json

# Build the anonymized report.
python3 scripts/collect.py --days 14 --output report.json
python3 scripts/collect.py            # prints JSON to stdout

# Open a public PR with a report (network + GitHub account; see below).
bash scripts/submit.sh report.json <github-username>

# Unit tests for the metric functions.
python3 scripts/test_metrics.py
```

`scripts/testset.json` is the fixed benchmark: 30 queries tagged by category
(semantic, episodic, procedural, strategic) and difficulty (easy, medium,
hard). `rate.py` takes the first `--queries N` of it.

Requires `python3` (standard library only). `rate.py` prefers the retrieval
functions in `~/.openclaw/workspace/skills/agent-memory-ultimate/scripts/lib/memory_core.py`;
if that import fails it falls back to a plain `LIKE` substring query, which
scores much worse and is not the same measurement.

## Permissions & Data Flow

**Reads.** The memory SQLite database (tables `memories`, `associations`,
`hierarchy`, `consolidation_log`, `retrieval_log`, `memories_vec`,
`shared_memories`; missing tables are skipped). `collect.py` also reads
`~/.openclaw/workspace/memory/claude-usage.json` and `gemini-usage.json` for
token/cost totals if present, and any prior reports under
`~/.openclaw/workspace/benchmarks/memory-bench/reports/`. `rate.py` runs
`git log` in `~/.openclaw/workspace` to stamp a version string.

**Writes.** `rate.py` writes to the memory database: it creates the
`retrieval_log` table if absent, `ALTER TABLE`s it to add missing columns, and
inserts one row per query containing the query text, the ratings and the
metrics. `collect.py` writes a random instance UUID to
`.memory-bench-instance-id` next to the database, and the report file given by
`--output`. `submit.sh` works in a temporary clone and does not touch the
operator's own repository.

**Network.** Three paths, none of them unavoidable:

- `rate.py --judge openai` (the default) sends each query plus the **first 300
  characters of each retrieved memory** to `https://api.openai.com/v1/chat/completions`
  (model `gpt-4o-mini`). That is real memory content leaving the machine. It
  reads the key from `--api-key` or `OPENAI_API_KEY`; with no key it prints a
  warning and falls back to the local judge. This copy of the script does not
  ask for confirmation before sending — pass `--judge local` to keep everything
  on the machine.
- `rate.py --judge local` POSTs the query and the same 300-character excerpt to
  `http://127.0.0.1:8900/embed` and scores by cosine similarity. Local only.
  The scripts do not include or start that service; if it is unreachable every
  rating falls back to a neutral 3, which silently invalidates the run.
- `submit.sh` uses the `gh` CLI with the operator's existing GitHub
  authentication to fork `globalcaos/tinkerclaw`, clone it, commit the report
  under `benchmarks/memory-bench/`, push a branch, and open a pull request.
  This is public and not easily undone. The PR carries the contributor name
  passed on the command line (or `$GITHUB_USER`, else `anonymous`) and the
  report's random instance ID.

**Credentials.** `OPENAI_API_KEY` (only for the OpenAI judge) and whatever
credentials `gh` already holds (only for `submit.sh`). Neither is stored or
copied by these scripts.

**What the report contains.** Aggregate numbers only: counts, type and age
distributions, strength/importance histograms, embedding coverage,
consolidation run summaries, per-configuration metric means and latency
percentiles, OS/arch/Python/Node versions, and token/cost totals if the usage
files exist. Memory text is not included. Note that the query text and ratings
_are_ stored locally in `retrieval_log`; they are not part of the JSON report.
