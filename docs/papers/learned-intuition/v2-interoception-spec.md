# AMYGDALA v2 — action prudence plus stream interoception (rewrite spec)

_Drafted 2026-08-30. Governs the rewrite of `learned-intuition.md` (22,581 words, unchanged since
2026-04-06). Objective set by the architect: "watch the comings and goings of your tokens, and detect
inconsistency, novelty, abruptness."_

## The reframe, in one line

The existing action loop asks **"should this action be stopped?"** at `before_tool_call`. The new,
complementary stream loop asks **"does this stream feel right?"** on every span in and out. Keep
the discrete circuit breaker as the terminal defence; add continuous interoception early enough to
catch a wrong interpretation before it becomes an action, draft, claim, or external message.

## Why the reframe is forced (not cosmetic)

1. **The failure class v1 cannot see.** 2026-08-30: a coherent request was misread into a commitment
   the user never made. No tool call was involved. An action gate is structurally blind to it —
   it watches the wrong end of the turn. Every v1 channel scores the INPUT; nothing scores the
   agent's own OUTPUT.
2. **v1's own ensemble is already retired.** The ten networks are out of the decision path
   (mislabelled training data; frozen-MiniLM danger classification measured _below chance_).
   The paper still presents them as the architecture.
3. **The winning mechanisms required no training.** Clause-cosine 0.896 AUROC vs a trained head at
   0.701; k-NN novelty 0.875. The zero-train baselines beat the learned ones. That inversion is the
   most publishable finding in the corpus and v1 buries it.
4. **The biology actually supports v2.** The amygdala is not in the motor pathway. It receives from
   thalamus/sensory cortex and _projects_ to hypothalamus, brainstem and PFC to modulate a
   continuous stream. v1's circuit-breaker framing was the weaker analogy all along.

## The unit of observation

A **span**: user message · thinking block · assistant text block · tool call · tool result. Each is
embedded once through the MiniLM encoder that is _already always loaded_ (`encoder.onnx`, 90.9 MB).
Three signals, one embedder, zero new models, zero training.

## The three signals

| signal            | question                              | statistic                                                                                     | status                                                                                 |
| ----------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **NOVELTY**       | "I have never been here."             | `1 − mean(top-k cos(span, reference ring))`; habituates by construction                       | **built + validated**, AUROC 0.875 OOD. Extend from tool-call situations to all spans. |
| **INCONSISTENCY** | "two things that should agree don't." | family of paired comparisons (below)                                                          | **partly built, and broken** — see the envelope bug                                    |
| **ABRUPTNESS**    | "the stream just jumped."             | `cos(w_t, w_{t−1})` over sliding windows — the _first derivative_ of the embedding trajectory | **not built at all.** The genuinely new contribution.                                  |

### Inconsistency is a family, not a check

v1 ships exactly one pair (action clause ↔ purpose clause, within a single message). The pairs that
matter:

- user's request ↔ **my restatement of it** — the misinterpretation detector, the missing one
- my claim now ↔ my claim earlier in the session — self-contradiction
- my stated plan ↔ what I actually did — drift
- action clause ↔ purpose clause — the existing check, keep it, fix the envelope bug

**Critical refinement — cosine is the wrong statistic for the most important pair.** When a misread
stays on topic, topic-similarity is HIGH. The 2026-08-30 case ("maybe he'll sell in a year" → "a
standing 500€ offer") would score as coherent. The signal that actually fires is _asymmetric
entailment_: my restatement contains a commitment — a price, deadline, promise, obligation, quantity
— absent from the source. That is a **set difference over extracted commitment spans**, not a
cosine. Inconsistency therefore has two mechanisms and the paper must name both.

### Abruptness — what only the derivative catches

Novelty asks "far from everything I know." Abruptness asks "far from where I was one span ago."
Cheaper, faster, and it catches a disjoint failure set: persona/voice collapse mid-reply (the
hand-written `PERSONALITY ALERT` nudges are a crude proxy for exactly this), a topic swerve where the
reply stops answering the question, the context-compaction seam, a hallucinated pivot into material
that was never in the input, and tool-result shock.

## The spine: the efferent path

**This is the paper's centre, because it is the diagnosed failure.** Every v1 verdict lands in
`recentDecisions`, a JSONL, a broadcast and an agent event — a panel. The one seam that could reach
the model (`amygdalaNudge`, `src/agents/system-prompt.ts:533/784`) is confirmed dead at `:46`:
_"nothing in `src/` ever populates it."_ A detector with no projection is not a detector.

Three projection levels, escalating:

1. **tag** — attach salience to the span, no behaviour change (all v1 does today)
2. **interrupt** — inject a note into context _before the next generation step_
3. **halt** — stop the turn and ask

And the timing claim v1 gets wrong: **the projection must land at the commitment point, which is not
always a tool call.** For a drafting turn the commitment point is the draft.

## Section disposition

**Survives:** §1 (the README debacle — still the best opening in the corpus) · §4.1–4.3 situation
embeddings + templates (the substrate all three signals ride) · §4.6 ambiguity detection (promote
from subsection to spine — it was the seed of v2) · §4.7 conformal prediction · §4.10 trust ramp +
§12 rule-intuition boundary (governance, still right) · §8 LLM-proof pipeline (MORE important now:
the agent must not self-assess — never let the suspect be the investigator).

**Demoted to published negative results:** §4.4/§4.5 the ten-network two-family architecture · §5
architectures A–E · §9 PPO training. Ten networks built, beaten by a zero-train cosine — papers
rarely publish that, and it is the honest headline.

**Falsified by our own data:** §10 context-pressure alleviation. The nudge injection has never fired
since declaration; 268 consecutive `persona-nudge` rows are byte-identical with
`embeddingSource: neutral-stub`. Keep as a failed prediction _with the measurement_.

## The empirical section v1 never had

v1 ships an evaluation _plan_ (§13). v2 ships an autopsy of its own deployment:

- 579 live decision rows (`~/.openclaw/data/amygdala-decisions.jsonl`, 2026-08-30 10:31→13:55)
- signal census: `none` 525 · `novelty` 47 · `incongruity` 6 · `aegis` 1
- **6/6 incongruity firings are false positives**, all the same cause: `index.ts:606` passes the RAW
  WIRE PROMPT to `checkIncongruity`, so `segmentByPurpose` splits inside the
  `Sender (untrusted metadata)` JSON block and compares metadata against unrelated tail. Cosine
  0.077–0.138, all under the 0.14 threshold. One firing flagged the user's _complaint about the
  misread_ and missed the misread.
- an instrument declared and never fired since declaration

## Thinking-stream decision (resolved 2026-08-31)

Hidden reasoning is **optional evidence, not an architectural dependency**. The default design
monitors user-visible input/output, retrieved context metadata, drafts, tool calls and tool results.
When a provider exposes reasoning spans, a local opt-in mode may process them ephemerally and retain
only derived alert records. Raw reasoning and embeddings are not persisted by default: embeddings
are inversion-adjacent, and provider-independent behaviour must not require hidden-token access.

## Known bugs the rewrite must not paper over

1. Envelope contamination in `checkIncongruity` (`index.ts:606`) — strip the preamble before segmenting.
2. Dead injection seam (`src/agents/system-prompt.ts:46`) — no efferent path exists.
3. ~~Personality-nudge writer/reader schema mismatch~~ — **stale (verified 2026-09-02):** the reader in `tinkerclaw-identity-persistence/index.ts:97` already accepts the `adjustments` array. The live defect is upstream: the nets run on `embeddingSource: neutral-stub`, so the nudge is a constant. Out of scope for the v2 plan.
4. `before_agent_finalize` never fires on the tinker-bridge path — `NATIVE_HOOK_RELAY_PROVIDERS = ["codex"]` only. The halt seam for Claude Code sessions must be a native `Stop` hook (plan Task 8).

**Implementation plan:** `docs/superpowers/plans/2026-09-02-amygdala-v2-interoception.md` (2026-09-02).
