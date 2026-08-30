---
schema: "kit/1.0"
slug: "hiring-source-candidates"
title: "Discover and Enrich Technical Candidates"
summary: "Build a ranked technical-candidate pipeline from public, permissioned sources: run many discovery vectors concurrently (including low-yield-per-effort ones a human recruiter skips), widen geography as an expanding fan measured in DRIVE TIME from the workplace, enrich each lead with job-relevant public evidence, preserve unknowns, and deliver one fit-ordered comparison table plus a decision-ready summary email for the hiring owner."
version: "2.2.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags:
  [
    "find candidates",
    "source candidates",
    "technical recruiting",
    "candidate research",
    "candidate enrichment",
    "robotics talent",
    "programmer search",
    "competition participants",
    "speaker sourcing",
    "find engineers",
    "buscar candidatos",
    "buscar programadores",
    "trobar candidats",
    "recruiting leads",
  ]
tools: ["read", "grep", "glob", "exec", "web_search", "web_fetch", "write", "edit"]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2, 3]
    - [4]
    - [5]
  notes: |
    Step 0 establishes the search grammar, exclusions, privacy boundary and output
    paths. Step 1 consumes that grammar to verify and expand the source registry.
    Steps 2 and 3 then fan out independently: Step 2 mines competitions/events,
    while Step 3 mines public technical work/research. Step 4 consumes both raw-lead
    files to resolve identities, enrich, deduplicate and score. Step 5 consumes the
    ranked dossiers to write the shortlist and outreach drafts. Step index:
    0=configure, 1=source-graph, 2=events, 3=artifacts, 4=enrich-rank, 5=deliver.
model:
  provider: "openai"
  name: "gpt-5.6-sol"
  hosting: "cloud API"
resolverHints:
  [
    {
      "match": "find candidates | source candidates | candidate research | technical recruiting | robotics talent | buscar candidatos | trobar candidats",
      "load": ["recipe.md"],
      "purpose": "Discover, enrich and rank technical recruiting leads from public sources.",
    },
  ]
params:
  offer_file:
    { type: "string", description: "Path to the written job offer or role specification." }
  values_file:
    {
      type: "string",
      description: "Private vacancy configuration: company, workplace, search grammar, experience target, exclusions and scoring weights.",
    }
  source_registry_file:
    {
      type: "string",
      default: "~/.openclaw/workspace/memory/hiring/candidate-source-registry.md",
      description: "Durable registry of candidate-producing public sources and their access rules.",
    }
  output_dir:
    {
      type: "string",
      default: "~/.openclaw/workspace/memory/hiring/candidate-runs",
      description: "Private directory for source snapshots, leads, dossiers, shortlist and drafts.",
    }
  max_leads:
    {
      type: "integer",
      default: 100,
      min: 10,
      max: 500,
      description: "Maximum distinct names to enrich in one run.",
    }
  recency_years:
    {
      type: "integer",
      default: 5,
      min: 1,
      max: 15,
      description: "Default lookback window for current professional evidence.",
    }
---

# Discover and Enrich Technical Candidates

## Goal

Turn {{offer_file}} into a private, evidence-backed candidate pipeline without
depending on inbound applications or manual referrals. Discover sources that reveal
names, extract plausible adult leads, enrich their public professional footprint,
rank reasons to speak with them, and prepare personalized drafts. Never contact,
publish, purchase, authenticate to, or bypass a platform autonomously.

The values in {{values_file}} control the vacancy. The recipe must remain generic.

## Required values

Abort with a clear list of missing fields unless {{values_file}} defines:

- `vacancy_slug`, `company`, `role`, `workplace`, `work_mode`;
- `must_have`, `adjacent_artifacts`, `learning_signals`, `negative_signals`;
- `geography_terms`, `target_experience`, `languages`;
- `excluded_employers`, `excluded_relationships`;
- `source_priorities`, `scoring_weights`, `retention_until`;
- `commute_model`, `hr_owner`.

`excluded_relationships` can remove politically sensitive pools such as customers,
suppliers or partners. Never infer these exclusions from company names alone: use the
explicit values file.

**`excluded_relationships` gates CONTACT, not DISCOVERY.** Mining a specific employer's
public workforce is a legitimate, high-value vector (see Step 2). Discover freely, then
resolve the exclusion before anyone is written to. A candidate blocked by an unresolved
relationship check is `pending_validation`, not rejected — and every shortlist entry that
carries one must name the substitute who moves up if it resolves against us. Never let
an unanswered exclusion question silently drop a strong candidate.

`commute_model` defines the geography engine and must contain:

- `origin` — the workplace the commute is measured from;
- `max_minutes_each_way` — the hard ceiling for a normal working day;
- `bands` — ordered rings of places, nearest drive-time first;
- `requires_own_transport` — whether no car/licence is a rejection;
- `counterexamples` — named places that break naive distance intuition, in both
  directions (close-but-slow, far-but-fast).

## Output contract

Create one dated run directory:
`{{output_dir}}/<vacancy_slug>/<YYYY-MM-DD>/`

It must contain:

1. `source-registry-snapshot.md`
2. `raw-leads.jsonl`
3. `candidate-dossiers/<candidate-slug>.md`
4. `shortlist.md`
5. `outreach-drafts.md`

Each factual candidate claim must carry a source URL, retrieval date and confidence.

## Steps

### 1. Configure the search and privacy boundary

**Tools:** read, grep
**Done when:** `run-config.json` exists in the dated run directory and contains every
required value, output path, exclusion and query family.

Read {{offer_file}}, {{values_file}} and {{source_registry_file}}. Build:

- rare hard signals and broader adjacent artifacts;
- learning/trajectory signals used for ranking, not discovery;
- geography spellings, with statuses `confirmed`, `probable`, `unknown`,
  `incompatible`;
- explicit excluded employers and relationships;
- multilingual query families for code, projects, competitions, talks, papers,
  theses, awards and municipal/university news.

Do not reject missing geography or missing public proof. Record both as unknowns.
Write the normalized configuration before searching.

#### Geography is the search ENGINE, not a filter

Do not search a whole region and filter by location afterwards. **Expand outwards in
bands from `commute_model.origin`, nearest first**, and only widen when a band is
exhausted. Proximity is a first-order ranking term, not a tie-breaker.

Two rules that make this work, and that naive distance handling gets wrong:

1. **Measure DRIVE TIME, never map distance.** A place is near if you can drive it in
   `max_minutes_each_way`, whatever the kilometres say. Motorway corridors pull distant
   towns inside the ring; dense city traffic pushes physically-close addresses outside
   it. Encode this with `commute_model.counterexamples` and honour it — do not
   recompute intuition from a map. When a candidate's town is not in any band, place it
   by the nearest listed town on the same road, and mark the estimate as such.
2. **A junior nearby often beats a senior far away.** An hour a day of unpaid commuting
   is a standing cost the candidate re-pays every morning, and it is the most common
   reason a good hire leaves within a year. When the values file says so, treat
   proximity as buying _retention_, and accept a training cost in exchange. State this
   trade-off explicitly in the summary rather than hiding it inside a score.

Also resolve from `commute_model`: if `requires_own_transport` is true, **no driving
licence or no car is a rejection** regardless of technical fit, and it becomes a
first-contact question for anyone whose situation is unknown.

Record for every lead a `commute_band` and how it was established (stated town,
inferred from employer location, or unknown). Unknown stays unknown and becomes a
first-contact question — it never becomes a rejection.

### 2. Verify and expand the source graph

**Tools:** web_search, web_fetch, read, write
**Done when:** `source-registry-snapshot.md` records every checked source with URL,
type, access status, name yield, next links and last-checked date; every new source
has a provenance URL.

Verify existing registry entries before using them. Fan out searches across:

- competition calendars, team lists, results, awards and team-description papers;
- municipal, university, association and sponsor announcements;
- conference agendas, speaker platforms, meetup pages and technical communities;
- public code/project platforms and open-source contributor surfaces;
- institutional repositories, theses, capstones, papers and lab pages.

Follow newly discovered teams, events, sponsors, speakers, organizers, repositories
and linked domains. Add only sources that plausibly reveal adult technical people.
Record blocked, authenticated, paid, stale and robots-disallowed sources rather than
silently omitting them. Do not evade any restriction.

#### Run every vector at once, including the ones a human would skip

A human recruiter rations attention, so they work the two or three channels with the
best yield-per-hour and drop the rest. **That economics does not apply here.** A vector
that returns two names for an afternoon of a person's work is worth running when it
costs an agent one query — and those are precisely the channels nobody else is mining,
so the few names they return are rarely contested. Run the vectors concurrently, and
in the run notes **name the low-yield vectors that were run**, so the hiring owner can
see the coverage they are not paying for by hand.

Vectors to run in parallel, beyond the generic source graph:

- **Targeted employer pools.** Pick named local companies, research centres and
  institutes whose staff plausibly do this work, and enumerate their public technical
  people (site team pages, publications, talks, repositories, project credits). This is
  a _discovery_ vector — the customer/supplier exclusion is resolved later, at contact
  time.
- **Small local job boards and municipal/comarcal employment services**, which
  aggregate people who never appear on the big platforms and are usually already
  inside the nearest commute bands.
- **Vocational and technical training centres** in the nearest bands: graduate lists,
  final projects, dual-training partner companies. This is the natural pool when the
  values file accepts juniors in exchange for proximity.
- **Local associations, makerspaces, robotics/automation clubs, alumni groups.**
- **Municipality-scoped queries on general professional platforms**, one town per
  query, walking outwards band by band.

Two search failure modes worth designing against, both observed:

- **Skill keywords select for the wrong population.** Querying a research-flavoured
  technology name returns academics, lab heads and vendor founders — accurate, and
  almost none of them hireable for an industrial post. Querying by _town_ returns the
  people who actually take these jobs. Use skill terms to rank, town terms to discover.
- **Place names collide with surnames.** Many towns are also common family names, so a
  town query silently fills with people from elsewhere who merely share the name. When
  a place name is also a surname, prefer neighbouring towns as the query term and treat
  the ambiguous one as a known-polluted channel.

### 3. Mine competitions, events and public recognition

**Tools:** web_search, web_fetch, read, write
**Done when:** `event-leads.jsonl` contains normalized leads from every reachable
high-priority event source, or a recorded reason each source yielded none.

Fan out across source entries of type competition, award, talk, meetup or community.
Extract:

```json
{
  "name": "Person Name",
  "source_type": "competition|award|speaker|organizer|mentor",
  "event": "Event or programme",
  "team_or_project": "Team/project",
  "role": "Published role or null",
  "year": 2026,
  "affiliation": "Published affiliation or null",
  "location_evidence": "Published evidence or null",
  "artifact_urls": ["https://..."],
  "source_url": "https://...",
  "retrieved_at": "ISO-8601",
  "confidence": "high|medium|low"
}
```

Prioritize university, adult and professional competitions. Never create candidate
dossiers for minors. For school competitions, extract only adult coaches, mentors,
judges, organizers or authors whose adult status is explicit.

Treat speakers and organizers as candidate leads and graph nodes. When an event
explicitly accepts sponsors, record `sponsorship_possible`, audience fit and contact
route for later human approval; do not buy sponsorship or send messages.

### 4. Mine public technical work and adjacent talent

**Tools:** web_search, web_fetch, exec, read, write
**Done when:** `artifact-leads.jsonl` contains normalized authors/contributors from
every reachable high-priority artifact source, with the artifact that justified
their inclusion.

Fan out across public code, project, research and postgraduate sources. Search core
requirements and `adjacent_artifacts`, for example:

- robot orchestration → distributed systems, scheduling, warehouse software;
- ROS/navigation → drones, autonomous vehicles, simulation, embedded Linux;
- machine vision → OpenCV, calibration, inspection, detection, tracking;
- industrial integration → OPC-UA, MQTT, Modbus, SCADA, IoT gateways, edge systems;
- agent systems → workflow engines, tool-using LLMs, evaluation, observability.

Extract authors, maintainers, issue participants, project leads, paper authors,
thesis authors and public technical speakers. Require one strong technical anchor,
not the target job title or complete target stack. A private or absent portfolio is
unknown evidence, never negative evidence.

Use authorized APIs where available. For GitHub, respect API rate limits and cache
user/repository responses. Do not automate LinkedIn, scrape behind login, bypass
CAPTCHAs, rotate identities, spoof clients or work around anti-bot controls.

### 5. Resolve identities, enrich, deduplicate and rank

**Tools:** web_search, web_fetch, exec, read, write
**Done when:** One dossier exists per enriched adult lead, same-name ambiguity is
explicit, exclusions are applied, and `ranked-leads.jsonl` contains at most
{{max_leads}} records with a reproducible score breakdown.

Merge `event-leads.jsonl` and `artifact-leads.jsonl`. Keep same-name people separate
until at least two independent identifiers corroborate identity, such as affiliation,
project, username, city or personal site. Never merge on name or photograph alone.

For each remaining name, search only public professional sources and write a dossier:

- identity-match evidence and confidence;
- geography evidence and status;
- employment/project chronology;
- code, papers, talks, competitions, recommendations and public technical writing;
- increasing responsibility, continued learning and problem-solving signals;
- contradictions, stale evidence, unknowns and questions for first contact;
- every claim's source URL and retrieval date.

Apply explicit employer/relationship exclusions before scoring. Score with the weights
from {{values_file}}. Rank on reasons to speak, not reasons to reject. Missing location,
portfolio or a desired technology contributes zero—not a penalty. Confirmed political
exclusion, confirmed incompatible geography or clear misrepresentation may exclude.

**Re-rank the whole pool whenever the criteria change — before searching for anyone new.**
When the hiring owner adds, drops or re-weights a requirement, the cheapest move is
almost never another search: it is re-scoring the people already collected. A candidate
buried mid-table under the old weights can become the best available option under the
new ones, and they cost nothing to reach because they are already in hand. Run the
re-rank first, report every position change of three places or more with the reason,
and only then decide whether new discovery is still needed.

**Corroboration across independent channels is itself a ranking signal.** When the same
person arrives through two channels that do not talk to each other — an inbound
application and a cold discovery vector, say — that agreement is evidence the market
also rates them, and it is not captured by any per-skill weight. Score it, and say so
in the summary; it is one of the few signals a human recruiter cannot easily reproduce.

Do not collect private contact details, family information, health, religion, politics,
sexuality, ethnicity, union activity, unrelated personal posts or inferred protected
traits. Do not infer age, nationality or personality from names or photos. Keep a
human responsible for every hiring decision.

### 6. Produce the shortlist and outreach drafts, then stop

**Tools:** read, write
**Done when:** `shortlist.md` and `outreach-drafts.md` exist, every shortlisted lead
links to a dossier and concrete evidence, and no external action has occurred.

Two deliverables, both aimed at `hr_owner`, who must be able to act without reading any
of the research: **one comparison table** and **one summary email**. Their shape is
fixed — it was arrived at by correction and should not be redesigned per run.

#### The comparison table

- **One single table containing every candidate. Never group into sections.** Do not
  split by origin (inbound vs sourced), by tier, or by any other provenance. Whoever
  reads this has to _choose_, and grouping by where a name came from serves the author,
  not the chooser. Provenance belongs in a column.
- **Ordered strictly by fit, best first**, using the values-file weights with proximity
  as a first-order term. Number the rows; the number is the recommendation.
- **One row per candidate, fixed columns:**

  | column                | contents                                                             |
  | --------------------- | -------------------------------------------------------------------- |
  | # + name              | rank number, name, and a one-line description of what they are       |
  | source                | provenance badge (inbound / sourced / which vector)                  |
  | how we found them     | the concrete channel, so a claim can be traced                       |
  | where they live       | town + commute band, not just a region                               |
  | how to contact        | every public route we actually have                                  |
  | requirement columns   | one per `must_have`, values `Yes` / `No` / `?`                       |
  | note                  | employer, standout facts, and the reason for the placement           |
  | **what to ask first** | the single question that resolves _this_ candidate's biggest unknown |

- **`?` is a first-class value and must stay.** A candidate assessed from a headline
  alone gets `?` across the skill columns, and the note says so. Never upgrade `?` to
  `Yes` by inference — an honest row of question marks tells the reader "this one needs
  opening", which is itself useful.
- **The "what to ask first" column is per-candidate and never generic.** Questions that
  go to everyone (pay expectations, availability, notice period) are stated **once** in
  the process section of the email. Repeating them on every row buries the one thing
  that is actually different about each person.
- Flag exclusion risk **inside the row itself**, visibly, so nobody writes to a blocked
  candidate by accident — and name the substitute who moves up.

#### The summary email to the hiring owner

Sections, in order:

1. **Opening** — what was combined (their inbound CVs + our search), and the ordering
   criterion in one sentence, naming any criterion that changed since last time.
2. **How we searched** — the vectors actually run, including the low-yield ones, in
   plain language. This is what justifies trusting the coverage.
3. **The table.**
4. **The process, as numbered phases** — each phase more expensive than the last, so
   only survivors of the cheap filter reach the costly one. State plainly which phases
   do not yet exist and what is blocking them; never present a missing step as ready.
5. **The ask** — exactly what the hiring owner should do next, with the reason
   (e.g. write by email rather than phone so answers arrive in writing; copy in the
   requester), plus a line saying the messages are already written for them and what
   the two mechanical steps are. Say plainly that the drafts are a base they may
   reword, not an obligation — a prepared message must not read as a script imposed
   on the person who has to sign it.
6. **The top few, one block per candidate — and everything for that candidate lives
   in that block.** Under each name, in this order: the assessment (_why I like them_,
   _in favour_, _against_, _what we don't know_), then the one-click contact link, then
   the complete message ready to paste.

   **Never split "what I think" and "what to send" into two sections of their own.**
   Two parallel lists force the reader to hold a position in each and match them up by
   hand, and the matching is exactly the error-prone step: it is how the wrong question
   ends up in the right person's message. One block per candidate, self-contained.

   Write the "against" honestly; a summary where every finalist is excellent is a
   summary that decides nothing.

Rules for the per-candidate messages:

- **No placeholders. None.** No `[NAME]`, no `[if inbound / if sourced]`, no "paste the
  question from below". Every variant is resolved per candidate before delivery — the
  right greeting, the right opening for how that person reached us, and their specific
  question already inlined. The test is literal: the hiring owner should not have to
  type or decide a single character, only click and paste.
- **Give a one-click opener above each message**, so the mechanical work is a click plus
  a paste. For a known email address, a `mailto:` link with recipient, cc and subject
  already filled. Where no contact address exists, link the platform profile instead and
  **say so in one line** — a button that silently does something different from its
  neighbours is worse than no button.
- Written for the hiring owner to send under **their own** identity, never ours.
- Must not state pay, work mode or any condition that is not yet authorised. If the
  requester removed a condition from an earlier version, that is a standing constraint
  on everything written afterwards, not a local edit.
- Reference the exact public artifact that made a sourced person interesting, and claim
  no certainty the evidence does not support.

Stop after drafts. The hiring owner chooses whom to contact and sends.

#### Keep every derived artifact in sync

If a table also exists as an attachment or exported document, regenerate it in the same
pass. A body listing thirty-one candidates beside an attachment listing fourteen is
worse than no attachment, and the mismatch is invisible to whoever forwards it.

## Constraints

- Public or expressly permissioned sources only.
- Never bypass authentication, CAPTCHA, rate limits, paywalls, robots rules, platform
  blocks or anti-automation controls.
- Never automate LinkedIn unless LinkedIn has expressly authorized that exact use.
- Never source employees of excluded customers, suppliers, partners or employers.
- Never profile or contact minors.
- Preserve unknown geography and absent public proof as unknowns, not rejection.
- Rank only job-relevant professional evidence; never protected traits or proxies.
- No autonomous contact, posting, connection request, sponsorship purchase or payment.
- Keep vacancy values and candidate artifacts private and out of public repositories.
- Delete or review candidate data when `retention_until` is reached.

## Safety Notes

- A public social profile is not blanket permission to process every visible fact.
  Limit collection to information necessary and relevant to the vacancy, retain source
  provenance, and ensure the candidate receives the required privacy information.
- A high score is prioritization, not a hiring decision. Never reject or hire solely
  through automated processing.
- Search snippets can be stale or misattribute same-name people. Open the source and
  corroborate identity before recording a claim.
- Competition pages may include minors without obvious labels. If adult status is not
  reasonably clear, omit the person.
- Recommendations, awards and follower counts can be gamed. Treat them as contextual
  signals and corroborate with chronology or work.

## Failures Overcome

- **Perfect-query rejection:** The previous recipe required a geography match and
  discarded missing locations. This version preserves `unknown` and makes location a
  first-contact question.
- **Portfolio survivorship bias:** The previous recipe treated public code as the
  strongest universal proof and hid experienced private-sector programmers. This
  version combines chronology, recommendations, talks, projects and learning signals;
  missing public work is neutral.
- **Static-source ceiling:** A fixed list repeatedly searches the same obvious sites
  and misses unknown sources. Step 2 records provenance and recursively follows teams,
  events, sponsors, speakers and repositories so the source graph compounds.
- **Adjacent talent hand-wave:** Saying “search adjacent profiles” produced no action.
  Step 4 maps each role requirement to concrete neighboring artifacts and searches
  their authors.
- **Same-name dossier contamination:** Broad web searches merged unrelated people into
  one flattering fictional super-candidate. Step 5 requires two corroborating identity
  signals and keeps ambiguity explicit.
- **LinkedIn block-loop:** Browser automation escalated platform blocks and risked the
  account without creating a durable asset. The recipe records LinkedIn as permissioned
  only and builds an independent source graph instead.
- **Research becoming surveillance:** “Thorough scraping” drifted into unrelated
  personal information. Step 5 defines an employment-relevant dossier schema and
  excludes sensitive and non-professional data.
- **Skill-keyword population error:** Searching the marquee technology of the field
  returned professors, lab heads and vendor founders — all real, all unhireable for a
  factory post. Searching by town returned the people who take these jobs. Skill terms
  now rank; town terms discover.
- **Distance mistaken for commute:** Ranking by map proximity kept dense-city addresses
  that are a slow hour away and dropped motorway towns that are half an hour away. The
  geography engine now measures drive time and carries named counterexamples in both
  directions.
- **Provenance grouping in a decision artifact:** The table was split into “their CVs”,
  “new CVs” and “our local search”, which documented the author's contribution and
  destroyed comparability. One table, ordered by fit; provenance is a column.
- **Stale criteria, stale ranking:** When the requirements changed, the reflex was to
  search again. Re-scoring the existing pool moved a candidate from tenth to third — he
  had been in hand the whole time, mis-ranked by the old weights. Re-rank before
  re-searching.
- **Exclusion check as a silent drop:** An unresolved customer/supplier question against
  a strong candidate risks either quietly losing them or writing to them by mistake.
  Exclusions now gate contact rather than discovery, appear in the row, and carry a
  named substitute.
- **Attachment drift:** The email body was updated while its attached copy of the same
  table was not, so the two disagreed. Derived artifacts are regenerated in the same
  pass.
- **Promising unauthorised terms:** An outreach draft offered a work-mode benefit that
  had not been approved yet. A condition removed by the requester is a constraint on
  everything written afterwards, not a local edit.
- **Assessment and message as parallel lists:** The commentary on the finalists sat in
  one section and the message templates in another, so the reader had to pair “item 4”
  with “question 4” by hand — the one step where the wrong question reaches the wrong
  person. Everything about a candidate now lives in that candidate's block.
- **Placeholders as unpaid work:** A single template with `[NAME]` and a
  “pick your opening” bracket looks efficient to the author and hands every remaining
  decision to the person who has to send it. Resolve every variant per candidate; a
  draft with a blank in it is not a draft.
- **The missing-address gap:** Sourced candidates often have no public email, so a
  uniform “click to email” row lies for some of them. State the contact route per
  candidate and label the exception rather than degrading silently.
