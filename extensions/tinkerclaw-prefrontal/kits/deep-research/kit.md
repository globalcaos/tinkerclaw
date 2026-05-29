---
schema: "kit/1.0"
slug: "deep-research"
title: "Deep Research"
summary: "Fan-out multi-angle web searches, deep-read sources, adversarially verify claims, synthesize a cited report."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
tags:
  [
    "deep research",
    "research",
    "investigate",
    "fact-check",
    "verify",
    "citations",
    "report",
    "multi-source",
    "analysis",
    "web search",
    "conflicting evidence",
    "contested claims",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-baked-cc-recipe"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
  notes: |
    Fully serial across steps — each step's output is the next step's required input. Step 0 produces the confirmed/unknown assumption list that scopes step 1 queries. Step 1 produces the URL list that step 2 fetches. Step 2 produces the claim set that step 3 verifies. Step 3 produces the verified/contested/unverified claim set that step 4 synthesizes. Within each step, individual tool calls (queries, fetches, skeptic searches) can run in parallel — call that out in the body, not in the groups array.
---

# Deep Research

> Fan-out multi-angle web searches, deep-read sources, adversarially verify claims, synthesize a cited report.

## Goal

Produce a cited, adversarially-verified research report on a question, resolving any analysis-invalidating uncertainty before drawing conclusions.

## When to Use

- Multi-source fact-finding where a single search would miss conflicting evidence
- Any claim that could flip the conclusion if wrong
- Reports requiring inline citations and adversarial verification
- Questions with contested, evolving, or politically charged answers
- Before committing to a course of action that depends on a factual premise

## Steps

### 1. Resolve blocking uncertainty

**Tools:** WebSearch, WebFetch, Bash
**Done when:** Every load-bearing assumption is either confirmed with a source URL + date, or explicitly listed as UNKNOWN with a one-line reason; none remain implicit. The final report will lead with any residual UNKNOWN items.

Identify the one or two facts that, if wrong, invalidate the entire analysis — e.g., a base rate, a definition boundary, or a recency constraint. Resolve them now via search or calculation. Do not proceed to step 2 until each is CONFIRMED or UNKNOWN; do not bury them as trailing caveats.

### 2. Fan-out searches across independent angles

**Tools:** WebSearch
**Done when:** At least 6 distinct queries issued, covering: primary/official sources, quantitative data, expert dissent, counterarguments, recent developments (<=12 months), and one 'X debunked' or 'X criticism' query. URL + snippet recorded for every result before any fetch.

Generate 6-8 queries spanning supporting evidence, opposing evidence, quantitative data, domain-expert opinion, and recency. Individual queries run in parallel. Record every result URL and snippet before fetching — the URL list is the input to step 3. Do not resolve contradictions at this stage; just collect.

### 3. Deep-read and extract claims from sources

**Tools:** WebFetch, Write
**Done when:** Full text fetched for every URL flagged as non-derivative; each source yields at least one discrete claim record: {claim, source_url, author, date}. Sources that are clearly derivative of an already-fetched origin are discarded with a one-line note.

Fetch full content of the top sources from step 2's URL list. Extract discrete, verbatim-or-close-paraphrase claims — not vague summaries. Tag each claim with source URL, author, and publication date. Mark sources older than 2 years on time-sensitive topics. Individual WebFetch calls run in parallel; claim extraction is sequential.

### 4. Adversarial verification pass

**Tools:** WebSearch, WebFetch
**Done when:** Every material claim is one of: CONFIRMED (>=2 independent-origin sources agree), CONTESTED (sources disagree — contradiction surfaced explicitly), or UNVERIFIED (only single-origin confirmation or no corroboration found). No claim is silently promoted to fact.

For each load-bearing claim from step 3, run a targeted skeptic query ('X wrong', 'X debunked', 'X limitations', 'X replication failure'). A claim confirmed only by sources sharing the same origin — same publisher, same author, or one citing the other — counts as one source and is UNVERIFIED. Surface every contradiction explicitly; do not silently pick the majority view.

### 5. Synthesize cited report

**Tools:** Write
**Done when:** Report delivered with: answer-first structure, inline citation per factual statement ({[N] url date}), a 'Residual Uncertainty' section at top listing all UNKNOWN/UNVERIFIED items, and a labeled confidence level (HIGH/MEDIUM/LOW/SPECULATIVE) per major conclusion. If a new load-bearing gap surfaces here, return to step 2 before finishing.

Write in diagonal-readable format: lead with the direct answer, then evidence, then caveats. Every factual statement carries an inline citation. Conclusions that depend on UNVERIFIED claims are explicitly qualified with the label. Conclusions that depend on UNKNOWN blocking items are flagged SPECULATIVE. If synthesis reveals a new material gap, loop back to step 2 — do not paper over it.

## Constraints

- Resolve analysis-invalidating uncertainty in step 1 BEFORE drawing any conclusions — never trail it as a caveat
- A claim confirmed only by sources sharing the same origin (same publisher, same author, one citing the other) counts as one source, not multiple confirmations
- Every factual statement in the output requires an inline citation with URL and date
- If synthesis reveals a new load-bearing gap, loop back to step 2 before completing — do not paper over it
- Sources older than 2 years on time-sensitive topics must be flagged explicitly
- Confidence levels (HIGH/MEDIUM/LOW/SPECULATIVE) are mandatory per major conclusion — hedged prose ('likely', 'probably') is not a substitute

## Safety Notes

- Do not silently resolve source contradictions — surface them explicitly in the report with both positions named
- Do not paraphrase sources into unattributable prose; extract discrete claims with source URL, author, and date
- Do not treat step 2 query count as a quality signal — 6 queries all returning the same primary source is worse than 3 queries returning independent origins
- Recency matters: flag sources older than 2 years for any time-sensitive topic before using them as confirmation
- Do not infer consensus from volume — a high number of sources all citing the same study is single-origin confirmation, not independent corroboration

## Failures Overcome

- Caveat-trailing: agent ships 'solid wins' conclusions then buries a concentration caveat that flips the answer. Fixed: step 1 requires blocking uncertainty resolved or explicitly UNKNOWN before any other work begins; residual UNKNOWN items lead the final report.
- Single-origin echo chamber: agent finds 5 articles all citing the same primary source and treats them as 5 independent confirmations. Fixed: step 4 requires independent origin (different publisher, author, and no cross-citation) for each confirming source; single-origin clusters are marked UNVERIFIED.
- Speculation passed as fact: agent uses hedged prose ('likely', 'probably') in conclusions and presents them as findings without signaling uncertainty. Fixed: mandatory per-conclusion confidence labels (HIGH/MEDIUM/LOW/SPECULATIVE) in step 5; hedged prose alone is not acceptable.
- Trigger mismatch: recipe never fired because tags like 'analysis' and 'report' matched too broadly or not at all on real prompts like 'is X true' or 'look into X'. Fixed: triggers expanded to cover natural-language phrasings users actually type; tags now include 'contested claims' and 'multi-source' to narrow false positives.
- Premature fetch: agent fetches full source content in the same step as searching, losing the URL list and duplicating work. Fixed: step 2 records all URLs and snippets before any fetch; step 3 fetches from that list, making the dependency explicit and enabling parallel fetches.
- Fake parallelism in steps: draft listed all steps as independent parallelism groups despite full data-dependency chain. Fixed: parallelismGroups are correctly serial [[0],[1],[2],[3],[4]]; intra-step parallelism (queries, fetches, skeptic searches) is called out in body text, not in the groups array.
