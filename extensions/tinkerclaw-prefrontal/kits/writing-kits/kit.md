---
schema: "kit/1.0"
slug: "writing-kits"
title: "Author a New Kit/Skill"
summary: "Author a valid kit/1.0 recipe: extract trigger surface, match exemplar schema, decompose steps, declare honest parallelism, validate before shipping."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "operations",
    "kit",
    "recipe",
    "skill",
    "author",
    "create kit",
    "write a kit",
    "new kit",
    "write recipe",
    "encode process",
    "add to registry",
    "playbook",
    "make a playbook",
    "workflow",
    "procedure",
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
    Step 0 fans two parallel reads (external spec/context AND the exemplar file) internally — both are read-only with no shared output, so they run simultaneously within the step. Step 1 (decompose) is the first serial barrier: it consumes both the trigger surface from step 0 AND the exemplar field list from step 0, so it cannot begin until step 0 is complete. Step 2 (parallelism) consumes the step list produced in step 1 — serial barrier. Step 3 (constraints/failures) consumes the step structure and parallelism declaration from steps 1 and 2 to write accurate failuresOvercome entries — serial barrier. Step 4 (validate) must run last, after all content exists. No adjacent steps can safely swap order. Step index: 0=Extract+Exemplar, 1=Decompose, 2=Parallelism, 3=Metadata, 4=Validate.
---

# Author a New Kit/Skill

> Author a valid kit/1.0 recipe: extract trigger surface, match exemplar schema, decompose steps, declare honest parallelism, validate before shipping.

## Goal

Produce a syntactically valid, registry-ready kit/1.0 recipe with an accurate trigger surface, honest step decomposition, verified parallelism, and concrete failure guards drawn from real anti-patterns.

## When to Use

- A recurring task class has no kit in the registry and is being solved manually more than twice
- A user asks to encode an informal procedure as a kit, recipe, or playbook
- A gap in the kit registry is identified during a session and needs filling before the session ends
- An existing skill or prompt chain should be promoted to a first-class kit/1.0 artifact with schema, steps, and parallelism declared

## Steps

### 1. Extract trigger surface, goal, and input spec in parallel with reading the exemplar

**Tools:** read, grep
**Done when:** Two artifacts exist in working memory: (1) slug, category, one-sentence goal, and ≥6 real user-typed trigger phrases; (2) all kit/1.0 frontmatter fields from the exemplar listed verbatim.

Read any referenced spec, conversation excerpt, or existing kit for context — simultaneously read the canonical exemplar at ~/src/tinkerclaw/extensions/tinkerclaw-prefrontal/kits/debug/kit.md verbatim. These are independent reads; run them in parallel. Trigger phrases must be words a real user would type, not internal field names. Grep the kits registry for the candidate slug to confirm it is globally unique before proceeding.

### 2. Decompose into numbered steps

**Tools:** write
**Done when:** 3–6 steps written, each naming at least one tool from the exemplar's allowed set, a done-when that names an observable artifact or verifiable state (not agent intent), and a 1–3 sentence imperative body.

Each step is a concrete agent action: a file read, a command run, a file written, a fact established. done-when must be falsifiable by a third party — 'file X exists', 'command Y exits 0', 'N items listed' are valid; 'agent understands X' or 'reviewed' are not. Body is terse and imperative — no tutorial prose, no passive voice.

### 3. Declare parallelism honestly

**Tools:** write
**Done when:** parallelismGroups assigns every step index to exactly one group; any step that consumes another step's output is in a later group; parallelismNotes names the dependency for each serial boundary.

A step that reads output produced by a prior step must be in a later group — one index per group for that chain. Only steps with no shared state or data dependency may share a group. List the dependency graph explicitly in parallelismNotes: for each serial boundary, name what artifact flows from the upstream step into the downstream step.

### 4. Add constraints, safetyNotes, failuresOvercome

**Tools:** edit
**Done when:** constraints list ≥3 hard rules; safetyNotes list ≥2 silent-failure modes; failuresOvercome has ≥3 entries each naming an anti-pattern by name and the structural guard in this kit that prevents it.

Constraints are hard rules the agent must not violate — they gate the kit's correctness. safetyNotes are failure modes that produce no error but silently wrong output. failuresOvercome entries must be drawn from real observed failure patterns (not invented risks): each names the anti-pattern and explains which step or rule in this kit structurally prevents it.

### 5. Validate schema completeness and YAML syntax

**Tools:** read, Bash
**Done when:** YAML parses without error; all required fields (schema, slug, title, summary, version, owner, license, tags, tools, testedHarnesses, parallelism, model, resolverHints, steps, constraints, safetyNotes, failuresOvercome) are present; file is saved at the canonical registry path.

Run `python3 -c "import yaml,sys; yaml.safe_load(sys.stdin)" < kit.md` to catch YAML syntax errors. Cross-check every field name and casing against the debug exemplar — missing top-level fields (version, owner, license, tools, model, resolverHints) are the most common silent omission. Save to the correct registry path and verify with a directory listing.

## Constraints

- schema field must be exactly "kit/1.0"
- slug must be kebab-case and confirmed unique in the kits registry via grep before use
- done-when must be falsifiable by a third party — no 'agent understands X' or 'reviewed'
- tags must include lowercase words a real user would type, not internal field names or jargon
- parallelismGroups must reflect actual data dependencies — a step consuming another step's output must be in a later group
- failuresOvercome entries must name a real observed failure mode, not a generic caution
- every step must list at least one tool — a step with no tools listed is unexecutable

## Safety Notes

- YAML multiline strings in notes fields require consistent indentation — a stray tab silently parses as a scalar, not a block
- Overwriting an existing slug in the registry replaces the prior playbook without warning — grep the registry for the slug before writing
- Top-level frontmatter fields (version, owner, license, tools, model, resolverHints) are required by the kit/1.0 schema but are easy to omit when focusing on steps — a kit missing these fields will fail schema validation silently at load time
- A done-when phrased as agent intent ('agent knows the root cause') is unverifiable and will cause the step to never exit cleanly or to exit prematurely — rewrite as an observable artifact

## Failures Overcome

- Trigger surface mismatch: kit is authored but never fires because tags use internal field names ('kit/1.0', 'slug') instead of how users actually phrase requests ('write a kit for', 'encode this as a playbook'). Prevented by step 1 requiring real user-typed phrases extracted from the task spec before any other work.
- Dishonest parallelism: author groups all steps together to appear efficient, but step 3 reads output of step 2 — agent runs them concurrently, gets stale data, produces wrong result. Prevented by the serial-chain rule in step 3: any data-flow dependency forces a new group.
- Missing top-level schema fields: agent focuses on writing step bodies and omits version, owner, license, tools, model, and resolverHints — kit fails schema validation silently and is invisible to the registry. Prevented by the explicit field checklist in step 5 cross-referenced against the debug exemplar.
- Vague done-when causing infinite loops: agent writes done-when as 'agent has reviewed the steps' — unverifiable, so the step never exits or exits immediately without real work. Prevented by step 2 requiring every done-when to name an observable artifact or command exit code.
- YAML syntax error ships silently: kit is written but never validated; parser chokes at registry load time and the kit is invisible. Prevented by the explicit yaml.safe_load validation command in step 5.
