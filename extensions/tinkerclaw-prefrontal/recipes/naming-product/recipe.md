---
schema: "kit/1.0"
slug: "naming-product"
title: "BROCA — name a product (clearance-gated neighbourhood)"
summary: "Pick a product or token name from an origin and a brief: generate a neighbourhood with explicit operators (misspell, synonym, same-space, swap, joke, house-brand), screen every candidate through domain + trademark + same-space prior use, keep taken names on the list, and never treat a one-letter dodge of a live mark as clearance."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
subdivision: "branding"
tags:
  [
    "name",
    "naming",
    "brand",
    "trademark",
    "domain",
    "token name",
    "product name",
    "clearance",
    "misspell",
    "portmanteau",
    "house brand",
    "what should we call it",
    "available names",
    "neurocoin",
    "nurocoin",
  ]
antiTriggers: ["variable name", "function name", "rename this symbol", "identifier", "css class"]
testedHarnesses: ["OpenClaw"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
    - [6]
    - [7]
---

# BROCA — name a product (clearance-gated neighbourhood)

> Finite means, infinite names: a small set of operators on two halves, then
> three gates. Taste is not a gate. Prior use in the same space is.

Distilled from the SprintPaper / NeuroCoin naming run (2026-08-23 → 2026-08-28).
BROCA here means: do not promote a one-off spelling trick into the method; the
operators earned reuse across eight rounds.

## Goal

End the turn with a ranked table the owner can decide from: distance (or the
metric he named), taken vs free, trademark, in-the-wild, and an honest
likelihood-of-confusion flag. A name is not “available” because `.com` is free.

## When to Use

- “What should we call it”, “name this product/token”, “is this trademarked”
- Domain + trademark clearance on a candidate or a family
- “Closer to X”, “misspell the crowded word”, “house-brand like clawhub”
- Second or later naming round on the same product (load the project folder first)

## When NOT to Use

- Code identifiers, CSS classes, git branches
- A single domain check with no brand intent
- Filing or buying — this recipe screens and recommends; spending is a later ask

## Steps

### 1. Origin and brief

**Done when:** origin (if any), banned stems, the job of the name, and this
round’s rank metric are written down.

Load the project folder before generating. If a previous round already killed a
stem, it stays dead unless the owner reopens it. Ask one question only if two
readings of the brief are both plausible.

### 2. Operators, not vibes

**Done when:** the distance / generation metric is numeric.

Default (owner-tunable):

| operator                    | cost                                        |
| --------------------------- | ------------------------------------------- |
| identical half              | 0                                           |
| misspell of the same lemma  | 0.25 per small edit                         |
| inflection / clip           | 0.50                                        |
| synonym                     | 1.00                                        |
| same-space, farther meaning | 1.25–2.00                                   |
| swap order                  | +1.00                                       |
| joke / house-brand          | score on the _rank_ metric, not as “closer” |

A round that only changes the suffix of a banned stem is not a new round.
Change morphology or change origin.

### 3. Generate the neighbourhood

**Done when:** every pairing exists as a list on disk, both orders if the name
is a compound.

Script it. Do not hand-pick a dozen you like and call it a search.

### 4. Domain gate (two sources)

**Done when:** every “free” `.com` is confirmed at the registry, not just DNS.

1. Cheap filter: `dig NS`. Nameservers ⇒ taken.
2. Authoritative: Verisign RDAP (or the TLD’s RDAP). 404 = unregistered; 200 =
   registered even with empty NS.
3. **Uniform output across different inputs is the probe failing** — missing
   `whois`, RDAP 404 on a registry it does not cover, identical Afternic prices.
   Do not report that as availability.

`.ai` / `.io` may only have DNS. Label them DNS-only when RDAP is absent.

### 5. Trademark gate

**Done when:** the batch contains a **passing positive control**, the exact-mark
search is done, and any previously named application number has been fetched by
**detail**, not only search.

**POSITIVE CONTROL IS MANDATORY AND GATES THE WHOLE BATCH.** Include `neurocoin`
in every screening run. It MUST come back with EM `018498899` (Registered,
cls 9+36, Innoplexus AG). If the control returns empty, **the probe is broken —
discard every verdict in that batch and record nothing as "clean."**

Why this is a batch-level gate and not a per-name caveat: on 2026-08-28 the
search endpoint returned **HTTP 302 / 0 bytes**, and with a warmed-up cookie jar
an F5/Shape anti-bot page — **an identical 15,966-byte body for every query**,
with the detail endpoint timing out too. A degraded endpoint yields near-uniform
"empty," which reads exactly like "clean" (rounds 7 and 8 recorded 18/20 and
26/26 empty that way and had to be marked unverified). Identical output across
different inputs means the probe is reporting its own failure — the same
signature as a missing `whois` binary or a scraped price-filter widget.

Empty exact on an invented compound is expected **once the control has passed**.
It is still not clearance against a similar live mark in the same classes.

### 6. In-the-wild gate

**Done when:** web search has been run on the readable shortlist, not just the
register.

Same-space prior use is a **kill** even with a clean register (US first-to-use;
EU first-to-file still leaves confusion, SEO, tickers, and a US problem).
NuroChain, NeuralCoin, NeuroToken NTK, MindCoin, Nous Research were all
register-clean compounds next to live tokens.

### 7. Rank on the owner’s metric

**Done when:** the table is sorted by what he asked for this round (distance to
origin, AI×crypto marriage, audible seam) — not by taste.

Keep **taken** rows on the list. A neighbourhood that hides the occupied cells
is a lie.

Flag likelihood of confusion explicitly: **d ≤ 0.50 from a live mark in the
same classes is not a workaround.** Free `.com` does not buy that off.

### 7b. House-brand check — is the head term ownable?

**Done when:** for any "name it like our other things" / family / prefix brief, the
**shared head term** has been cleared in its own right, and the answer is stated.

A house brand compounds only if its shared element is **distinctive and owned**.
Screening only the new compound misses the question that decides the family.
Three checks on the head term itself:

1. Is it a **common word**? Common words are weak heads — anyone may use them
   descriptively, and you will never stop a competitor.
2. Is it **already registered by someone bigger in your class**? On 2026-08-28,
   `tinker-*` looked free compound-by-compound while Autodesk held **TINKERCAD**
   (US 5498100, class 9, software), alongside TINKERKIT and TINKER3D.
3. Do we **actually own an instance of it**? The head we own beats the head we
   like. the architect owned `thetinkerzone.com` but not `tinker`, `tinkerzone.com` or
   `tinkercoin.com` (held since 2013) — so the defensible family was
   **TheTinker\***, not bare **Tinker\***.

If the head fails, say so plainly: the family cannot be built there, and adding
more compounds to a crowded head is motion, not progress. Offer the nearest head
the owner already owns.

### 7c. Prior use by a live person — date it, don't assume it

**Done when:** "someone already uses it" carries **two dates**: theirs and ours.

Get theirs from registry `created` and the live site; get ours from
`git log --reverse -S'<name>'` (the rename commit), the first public post, or the
store listing. On 2026-08-28: their `tinkerclaw.com` 2026-02-12 vs our rename
commit `aa002cfea22` 2026-03-08 — **25 days**, so the owner's hunch was right, but
it was checkable rather than assumable and could as easily have gone the other way.

Then separate the two consequences, which are NOT the same:

- **Usability** — an unregistered prior user cannot stop continued use.
- **Ownability** — they can block or invalidate _our registration_, especially in
  first-to-use jurisdictions.

And check the cheap escape before proposing a rename: a taken `.com` with a free
`.dev` / `.ai` / `.org` is an address problem, not a name problem. Buying the
domain buys the address, never the priority.

### 8. Present and stop

**Done when:** the owner can pick, reject the family, or name the next operator
without reading the dump.

Lead with the decision: closest _free and actually different_, vs closest _free
but legally the same_. Ugly double-misspells belong in the dump, not the table.

Do not buy or file in this recipe. Propose the exact domains / classes and wait.

If the owner then asks **what a filing costs** (this is a later ask, not this recipe's default):

- Quote **office fees**, not counsel. Spain OEPM electronic 2026: €127.88 first class, €82.84 each extra (official PDF). EUTM online: €850 / €50 / €150. USPTO Trademark Center: $350 per class. An EUTM covers Spain — do not file both.
- A mark is **not per-TLD**. Two `.com`s do not need two marks. File the **product or house brand you will actually use**, not the crowded English head (`THE TINKER` when you do not even own `thetinker.com`).
- Check the SME Fund voucher window before quoting EU cash-out (2026: 75% reimbursement, pay first).

## Constraints

- Never report domain availability from DNS alone.
- Never report a trademark gone from an empty search if a number is on file.
- Never drop taken names from a distance-ranked list the owner asked to see.
- A new round must change morphology or origin. Suffix-on-the-same-stem is the
  stall this recipe exists to kill.
- Spending (domains, counsel, filings) is irreversible — propose, don’t click.
- A domain is an **address**, not a trademark. Never tell the owner that buying `.com` “preempts” a later mark or that “nobody can forbid use” because they hold the hostname. EU first-to-file can still stop commercial use; US rights come from _use in commerce_, not from a parked domain. (2026-08-28, TheTinkerClaw inventory.)
- The converse is also false: a **later** mark (or a later domain in the same family) does **not** make a senior honest registrant desist. UDRP needs bad faith _at their registration_; they cannot have targeted a mark that did not exist. In the EU, earlier unregistered use can oppose a later EUTM (Art. 8(4)); the later filing cannot evict them. Do not draft a C&D or UDRP on that theory. (2026-08-28, Sanket / tinkerclaw.com.)

## Safety Notes

- Not legal advice. A professional clearance search is still owed before filing.
- Do not impersonate a lawyer. Do not tell the owner a one-letter variant is
  “clear” in the EU when the earlier mark covers identical goods.

## Failures Overcome

- **NeuroCoin “Name — DECIDED”** with no register search (2026-08-23): a
  decision without a gate is a hypothesis. Record kills in the project brief.
- **whois missing / RDAP 404 / identical Afternic prices:** uniform probe
  output = the probe, not the world.
- **NuroCoin / NuroCrypt:** dropping a letter from a live EUTM in classes 9+36
  is LoC, not clearance. Detail endpoint beats search.
- **NuroChain, Nuralchain, Myndchain, NeuralCoin, NTK, MindCoin, Nous:**
  in-the-wild killed more names than TMview.
- **Morphological stall (2026-08-27/28):** eight rounds of “new” names on three
  stems (`nuro` / `mynd` / `mynt`). The owner called it stuck. Fix: banned-stem
  list + “change morphology” as a hard step, not a vibe.
- **Distance round looking like more Neuro typos:** that is the metric working.
  Say so in the first paragraph, then show DendronCoin-class names as the first
  _different_ free cells.
- **Persisted-but-not-painted (2026-08-26 class):** if the owner says he does
  not see the answer, say “reload the tab” first. Disk + session jsonl can hold
  a reply the `#messages` region never painted.
