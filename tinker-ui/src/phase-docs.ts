// FORK 2026-08-16 (the architect: "whenever I click on any of those elapsed time messages, I want it to
// show a popup with the explanation of what it really means, with references to the papers and
// links to them too").
//
// The timing rows answer "how long"; this answers "what was it actually doing, and what does a
// big number here mean". Kept as pure data + a lookup so it is unit-testable — app.ts is a
// browser entry with no test harness (the turn-phase.ts precedent).
//
// EVERY LINK IN THIS FILE WAS FETCHED AND CONFIRMED before being written down. The permalinks
// came back from thetinkerzone's own sitemap and WP REST API through a real browser (the site
// 403s curl/WebFetch — the known Cloudflare/JA3 blackout).
//
// WHY THAT MATTERED: the post ids were listed in a memory note in J-number order, and the order
// is WRONG — 221 is HIVEMIND, 222 is Learned Intuition, 223 is AEGIS, not the J9/J10/J11 that
// sequence implies. Three links would have pointed at the wrong paper. Do not add an entry here
// from a remembered id; fetch it.
//
// FORK 2026-08-16 (the architect: "read J1. The paper links should go to thetinkerzone.com").
//   - J1 / TOTAL RECALL is now present. Its permalink was confirmed twice over — via the
//     sitemap and via post id 171 — after the first sweep was cut short by rate-limiting.
//   - EVERY reference now points at thetinkerzone.com. The two arXiv links that stood in for
//     the retrieval and long-context background (Lewis et al. 2020; Beltagy et al. 2020) are
//     gone: those ideas are covered by J1 and by Budget Prompting in the architect's own words,
//     and this popup is about THIS system. The host allowlist in the test enforces it.
//
// The claims quoted from J1 below are its own measured results (§9.2, §9.3, §9.4), not
// paraphrase: 94% 2-hop exact-match recall after 5 compaction cycles vs 4% for narrative
// compaction; a 2% false-recall rate vs 24%; `recall` invoked on only 22% of turns.

export type PhaseRef = {
  /** How the reference is shown. */
  label: string;
  /** Verified URL, or undefined when the reference is real but its link is not confirmed. */
  url?: string;
  /** One line on why THIS phase should send you to THIS reference. */
  note: string;
};

/**
 * FORK 2026-08-22 (the architect: "I want it to be framed as what the profit is ... for me and for a
 * newcomer that just cloned our repo").
 *
 * Every stage below costs the architect seconds of his life. A popup that only says WHAT a
 * stage does is an excuse; the question it has to answer is WHAT THOSE SECONDS BUY, and
 * whether the trade is currently a good one.
 *
 * THREE RULES, because the honest version is more useful than the flattering one:
 *
 *   1. `profit` states the mechanism of the benefit — what would go wrong, or cost more, if
 *      the stage were deleted. Not "improves memory": *which* failure it prevents.
 *   2. `evidence` carries only MEASURED numbers, each attributed to its source — a paper
 *      section, or this deployment's own journal. Never a plausible-sounding estimate.
 *   3. `caveat` is mandatory wherever the benefit is NOT currently being realised here. Total
 *      Recall's compaction machinery is excellent and has fired zero times on this box. A
 *      newcomer who reads only the paper will believe it is load-bearing. It is not, yet.
 */
export type PhaseDoc = {
  /** Heading for the popup. */
  title: string;
  /** Where the number comes from — the two are not the same quantity. */
  measuredBy: "gateway" | "client";
  /** What the machine is literally doing during this window. */
  what: string;
  /** What a LARGE number here actually indicates. This is the part worth reading. */
  whenSlow: string;
  /** WHAT THESE SECONDS BUY — the failure they prevent, not a description of the work. */
  profit?: string;
  /** Where the stated benefit is NOT currently realised on this deployment. Never flattering. */
  caveat?: string;
  /** Observed figures, so the popup is grounded rather than theoretical. */
  observed?: string;
  refs: PhaseRef[];
};

const J_SERIES = "https://thetinkerzone.com";

/** Keyed by the phase LABEL as it appears in the row (the gateway's own words). */
const DOCS: Record<string, PhaseDoc> = {
  sending: {
    title: "sending",
    measuredBy: "client",
    what: "From pressing Enter until the gateway acknowledges the message: one websocket round trip, then the gateway validating the prompt, writing your turn into the session transcript, assigning it a run id and putting it on a queue. No model is involved yet.",
    whenSlow:
      "This should be ~1s. When it is not, the gateway's event loop is saturated — it is single-threaded, so a heavy call from any panel or any other session delays even this acknowledgement. A slow 'sending' is therefore a symptom of load elsewhere, never of your prompt.",
    observed: "median 1.5s over 24h (n=76), but 50s observed on a loaded gateway.",
    refs: [
      {
        label: "Budget Prompting: Cutting the Cost of Always-On Memory Agents (2-3×)",
        url: `${J_SERIES}/budget-prompting-cutting-the-cost-of-always-on-memory-agents-2-3x/`,
        note: "Why an always-on agent keeps the gateway busy between your turns at all.",
      },
    ],
  },

  "preparing context": {
    title: "preparing context",
    measuredBy: "client",
    what: "From the gateway acknowledging your message until a model is actually named. This is a BRACKET: it contains the queue wait, the session and transcript load, the compaction check, every plugin hook, and model selection. The gateway-measured rows sit INSIDE this window — do not add them together.",
    whenSlow:
      "Almost always queueing rather than work. A turn waits for its lane, and lanes serialise: one long reflection or subagent run parks everything behind it. Measured lane waits reach 26 minutes. If this is large while the stages inside it are small, the machine was not busy on your behalf — it was busy.",
    profit:
      "Most of this window is not buying anything — it is the cost of everything else running on one machine. The parts that ARE buying something are the gateway stages nested inside it; the rest is contention. Judge it by whether the stages inside account for it: on a traced turn on 2026-08-22, instrumented stages accounted for ~26s of a 90s window, and the remaining ~64s was waiting, not working.",
    caveat:
      "Do not add this to the rows beneath it. It CONTAINS them: every gateway stage and every plugin row happens inside this window, so summing them double-counts. The stage breakdown under this row does not sum to it either — the difference is queueing, and it is shown as its own line rather than left as an inference.",
    observed:
      "median ~350s over 24h (n=62), spread 10s → 43min. Only ~11ms of it is currently narrated.",
    refs: [
      {
        label: "Budget Prompting: Cutting the Cost of Always-On Memory Agents (2-3×)",
        url: `${J_SERIES}/budget-prompting-cutting-the-cost-of-always-on-memory-agents-2-3x/`,
        note: "The cost model for everything that happens in this window.",
      },
      {
        label:
          "PREFRONTAL: Giving Your Agent an Executive Function with a Recipe Execution Substrate",
        url: `${J_SERIES}/prefrontal-giving-your-agent-an-executive-function-with-a-recipe-execution-substrate/`,
        note: "What decides the shape of a turn before the model sees it.",
      },
      {
        label: "HIVEMIND: Role-Bound Agent Swarms for Enterprise Continuity",
        url: `${J_SERIES}/hivemind-hierarchical-agent-swarms-for-enterprise-knowledge-management/`,
        note: "Why concurrent agents contend, which is what the queue wait in here really is.",
      },
      {
        label: "Total Recall: Pointer-Based Compaction and Task-Conditioned Retrieval (J1)",
        url: `${J_SERIES}/total-recall-pointer-based-compaction-and-task-conditioned-retrieval-for-persistent-llm-agents/`,
        note: "The compaction check and the retrieval pack both happen inside this window — J1 is the architecture for both.",
      },
    ],
  },

  "recalling memories": {
    title: "recalling memories",
    measuredBy: "gateway",
    what: "The retrieval step (the before_prompt_build hook). It searches the engram store and the distilled Claude-Code experience store for material relevant to what you just asked, scores it, and prepends the winners to the system prompt under a fixed token budget — the Push Pack of J1 §3.2. Scoring is TASK-CONDITIONED, not just similarity: J1 §4 multiplies a base relevance by premise, phase, supersession and task-relevance terms, because a purely similarity-driven retriever over-injects obsolete objectives and debug noise.",
    whenSlow:
      "THIS ROW IS A SUM, NOT A STAGE. Eight plugin handlers run inside it, one after another, and the number is their total — expand the row to see which one spent it. Historically that distinction mattered enormously: the retrieval pack was optimised from 19.5s to ~1.1s and this row barely moved, because the pack was one participant out of eight.",
    profit:
      "It buys answers that do not need a discovery conversation first. Everything the model would otherwise have to ASK you for — which file, what was decided, what already failed — is resolved in one pass before the turn starts. The alternative is three or four round trips of clarifying questions, each a full model call you wait for and pay for. That is the trade these seconds are making: one retrieval now against several round trips later.",
    caveat:
      "The retrieval pack ADDS tokens to every prompt (a measured p50 of 714) and removes none. It does not make prompts cheaper; it makes them sufficient. The token saving described in the papers is a counterfactual about very long sessions, which this deployment does not currently have.",
    observed:
      "Measured on this system 2026-08-22: the whole chain 12.7s, of which tinkerclaw-total-recall was 14,717ms on the sampled turn and every other plugin 1–9ms. The pack build itself measures p50 1.82s in production, down from 19.46s before 2026-08-19. J1 §9.3: the on-demand `recall` path is needed on only 22% of turns, so the pushed pack alone answers the other 78%.",
    refs: [
      {
        label: "Instant Recall: A Pre-Computed Concept Index for O(1) Memory Retrieval",
        url: `${J_SERIES}/instant-recall-a-pre-computed-concept-index-for-o1-memory-retrieval-in-persistent-ai-agents/`,
        note: "The index that makes this step cheap instead of a scan.",
      },
      {
        label: "MNEMOSYNE: Four Hooks That Upgrade Your Agent's Memory Without Forking It",
        url: `${J_SERIES}/mnemosyne-four-hooks-that-upgrade-your-agents-memory-without-forking-it/`,
        note: "before_prompt_build is one of those hooks — this is the hook firing.",
      },
      {
        label: "Fractal Reasoning: Multi-Resolution Memory and Self-Similar Metacognition",
        url: `${J_SERIES}/fractal-reasoning-multi-resolution-memory-and-self-similar-metacognition-for-llm-agents/`,
        note: "How memory is held at several resolutions so retrieval can pick one.",
      },
      {
        label: "Total Recall: Pointer-Based Compaction and Task-Conditioned Retrieval (J1)",
        url: `${J_SERIES}/total-recall-pointer-based-compaction-and-task-conditioned-retrieval-for-persistent-llm-agents/`,
        note: "THE paper for this stage: why retrieval is conditioned on the active task, not just similarity. Its §4 is the scoring function this step runs.",
      },
    ],
  },

  "compacting context": {
    title: "compacting context",
    measuredBy: "gateway",
    what: 'The before_compaction hook. When the conversation nears the model\'s context window, older events are EVICTED FROM THE CONTEXT CACHE but not destroyed — the event store is append-only and lossless, and what remains in the prompt is a pointer: "[Events T12–T47 evicted. Key topics: … Use recall(query) to retrieve.]". J1 calls this pointer-based compaction, and the point is that the marker is a retrieval directive carrying no semantic content, so it cannot be mistaken for ground truth the way a summary can.',
    whenSlow:
      "Eviction itself is cheap — J1 §9.4 measures the pointer-compaction step at 1.46ms. A large reading here therefore means the summarising path ran, which is a full model call. If that happens often the session is running hot against its window, and the fix is a smaller resident context rather than a faster compactor.",
    profit:
      "It buys eviction WITHOUT destruction, which is the difference between a context that shrinks and a memory that is lost. Summarising history into prose is irreversible: exact strings, causal chains and negative knowledge — 'we tried X and it failed' — cannot be reconstructed from a summary, and the model cannot tell that they are missing. Evicting to a pointer keeps the context lean while leaving every evicted event retrievable, so the saving is context budget rather than knowledge.",
    caveat:
      "On THIS deployment it has never run. 0 firings in 980 gate evaluations: the gate sits at 980,000 tokens of a 1,000,000-token window and observed fill peaks at 33%. The context here stays lean because the window is large and sessions are short — not because this is working. It is insurance that has not yet been claimed on.",
    observed:
      "J1 §9.2: after 5 compaction cycles, exact-match recall is 94% under Total Recall's 2-hop retrieval versus 4% for narrative compaction and 0% for truncation; false recall stays at 2% versus 24% for narrative summarising. §9.4: 100% needle recall under forced compaction versus 0% for truncation, at 1.46ms, with linear O(T) storage instead of the quadratic growth of recursive summarising. On this system: 0 firings in 980 gate evaluations; context fill p50 3.0%, p90 26.7%, max 33%.",
    refs: [
      {
        label: "Total Recall: Pointer-Based Compaction and Task-Conditioned Retrieval (J1)",
        url: `${J_SERIES}/total-recall-pointer-based-compaction-and-task-conditioned-retrieval-for-persistent-llm-agents/`,
        note: "Why this evicts to a pointer instead of summarising — narrative compaction destroys precise strings, causal chains and negative knowledge irreversibly.",
      },
      {
        label: "Budget Prompting: Cutting the Cost of Always-On Memory Agents (2-3×)",
        url: `${J_SERIES}/budget-prompting-cutting-the-cost-of-always-on-memory-agents-2-3x/`,
        note: "Why keeping the resident context small is the whole saving.",
      },
      {
        label:
          "Sleep Consolidation: How Nightly Prompting Makes a Stateless Agent Get Better Over Time",
        url: `${J_SERIES}/sleep-consolidation-how-nightly-prompting-makes-a-stateless-agent-get-better-over-time/`,
        note: "Layer 3 of the same pipeline: the episodic summaries built offline over the lossless store.",
      },
    ],
  },

  "preparing the turn": {
    title: "preparing the turn",
    measuredBy: "gateway",
    what: "The agent_turn_prepare hook: plugins fold in anything queued for this specific turn — injections left by a previous turn, recipe state, scheduled nudges — before the prompt is built.",
    whenSlow:
      "Usually a plugin doing real work here rather than deferring it. This hook is on the critical path by design, so anything expensive in it is paid by you, live.",
    refs: [
      {
        label:
          "PREFRONTAL: Giving Your Agent an Executive Function with a Recipe Execution Substrate",
        url: `${J_SERIES}/prefrontal-giving-your-agent-an-executive-function-with-a-recipe-execution-substrate/`,
        note: "The substrate that decides what a turn should do before it starts.",
      },
    ],
  },

  "choosing a model": {
    title: "choosing a model",
    measuredBy: "gateway",
    what: "The before_model_resolve hook: which model and effort level this turn should run at. In Auto this is a local decision from configured ranks and gates — it is NOT an extra LLM call, which is a common misreading of the wait that precedes it.",
    whenSlow:
      "It should be near-instant. A large reading means a plugin is consulting something remote to decide, which is the wrong place to do it — routing should be a pure function of state you already hold.",
    profit:
      "It buys the right amount of effort for the question, at effectively zero cost. Running every turn at one setting means either over-thinking trivia or under-thinking hard problems — and under-thinking is the expensive one, because it returns an answer that looks finished, is not, and costs another full turn to correct.",
    observed: "~0ms — a local decision from configured ranks and gates, not an extra model call.",
    refs: [
      {
        label: "Round Table: Exploiting Cognitive Diversity as a Computational Resource",
        url: `${J_SERIES}/round-table-exploiting-cognitive-diversity-as-a-computational-resource-in-persistent-ai-agents/`,
        note: "Why the choice of model is itself a capability, not just a cost dial.",
      },
      {
        label:
          "Learned Intuition: A Reflex Layer That Stops Your Agent Before It Does the Wrong Thing",
        url: `${J_SERIES}/learned-intuition-a-reflex-layer-that-stops-your-agent-before-it-does-the-wrong-thing/`,
        note: "The gating layer that can veto or redirect a turn at this point.",
      },
    ],
  },

  "assembling the prompt": {
    title: "assembling the prompt",
    measuredBy: "gateway",
    what: "The before_agent_start hook: the final assembly — persona and identity block, system prompt, retrieved memory, tool definitions and your message, in the order the prompt cache expects.",
    whenSlow:
      "Order matters more than size here. A changed prefix invalidates the provider's prompt cache, so the whole system prompt is re-written instead of re-read — which costs both latency and money on the NEXT turn, not this one.",
    refs: [
      {
        label:
          "Identity Persistence: Keeping an LLM Agent's Personality Stable Across Sessions, Model Swaps and Restarts",
        url: `${J_SERIES}/identity-persistence-keeping-an-llm-agents-personality-stable-across-sessions-model-swaps-and-restarts/`,
        note: "The persona block assembled here, and why it must stay stable.",
      },
      {
        label: "Budget Prompting: Cutting the Cost of Always-On Memory Agents (2-3×)",
        url: `${J_SERIES}/budget-prompting-cutting-the-cost-of-always-on-memory-agents-2-3x/`,
        note: "Prompt-cache-aware ordering is one of the techniques measured there.",
      },
    ],
  },
};

/** Shown when a phase has no entry — a new gateway stage must still explain itself honestly. */
const FALLBACK: PhaseDoc = {
  title: "this stage",
  measuredBy: "gateway",
  what: "A stage the gateway reported by name but that this build has no written explanation for yet.",
  whenSlow:
    "Treat the number as real and the label as the gateway's own word for it — nothing here is inferred from elapsed time.",
  refs: [
    {
      label: "The Building Jarvis series",
      url: `${J_SERIES}`,
      note: "The papers behind the architecture these phases belong to.",
    },
  ],
};

/**
 * Look up the explanation for a row's label.
 *
 * Matching is exact-then-prefix: the gateway sends fixed labels for its hooks, but the model
 * stage arrives as "starting <model-name>", which must not need a new entry per model.
 */
export function phaseDocFor(label: string | undefined | null): PhaseDoc {
  const key = (label ?? "").trim().toLowerCase();
  if (!key) {
    return FALLBACK;
  }
  const exact = DOCS[key];
  if (exact) {
    return exact;
  }
  if (key.startsWith("starting ")) {
    return {
      title: key,
      measuredBy: "gateway",
      what: `The model call is opening: ${key.slice("starting ".length)} has been selected and the request is being handed to the provider. Everything before this row was preparation; everything after it is the model thinking.`,
      whenSlow:
        "This marks a boundary rather than a duration, so a large number means the handover itself stalled — provider connection, auth refresh, or a worker being respawned because the system prompt changed.",
      refs: [
        {
          label: "Round Table: Exploiting Cognitive Diversity as a Computational Resource",
          url: `${J_SERIES}/round-table-exploiting-cognitive-diversity-as-a-computational-resource-in-persistent-ai-agents/`,
          note: "Why this agent runs several providers rather than one.",
        },
      ],
    };
  }
  return FALLBACK;
}

/** Every documented label, so a test can assert the set matches what the gateway emits. */
export function documentedPhaseLabels(): string[] {
  return Object.keys(DOCS);
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-PLUGIN DOCS
//
// A phase row is a SUM. `before_prompt_build` runs eight plugin handlers one after another,
// and until 2026-08-22 the UI showed only their total — which is how the retrieval pack was
// optimised from 19.5s to ~1.1s while the number the architect actually watches barely moved.
// Each row now expands, and each plugin has to justify its own milliseconds.
// ─────────────────────────────────────────────────────────────────────────────

export type PluginDoc = {
  /** Human name — the plugin id is machine noise. */
  title: string;
  /** One line: what this handler does during this stage. */
  what: string;
  /** THE POINT: what these milliseconds buy, stated as the failure they prevent. */
  profit: string;
  /** Measured numbers only, each attributed. Omitted when nothing has been measured. */
  evidence?: string;
  /** Where the benefit is NOT currently realised on this deployment. */
  caveat?: string;
  refs: PhaseRef[];
};

const PLUGIN_DOCS: Record<string, PluginDoc> = {
  "tinkerclaw-total-recall": {
    title: "Total Recall · ENGRAM",
    what: "Searches this session's event store and the cross-session Claude Code experience store for material related to what you just typed, scores it against the ACTIVE TASK rather than raw similarity, and staples the winners to the front of the prompt under a fixed token budget.",
    profit:
      "It buys answers that do not need a discovery conversation. Without it, anything outside the live context has to be re-established by asking you — three or four round trips of 'which file?', 'what did we decide?', each one a full model call you wait for and pay for. One retrieval pass in advance replaces that. Task-conditioning is the part that matters: a purely similarity-driven retriever re-injects obsolete objectives and debug noise, which is worse than retrieving nothing because it is confidently wrong.",
    evidence:
      "J1 §9.2: 94% exact-match recall at 2-hop after 5 compaction cycles, versus 4% for narrative summarising and 36% for MemGPT-style paging. §9.3: false recall stays flat at 2% versus 24% for summarising, and the on-demand `recall` tool is needed on only 22% of turns — i.e. the pushed pack alone answers the other 78%. On this system: the pack costs a measured p50 1.82s (was 19.46s before 2026-08-19) and adds a p50 of 714 tokens to the prompt.",
    caveat:
      "It ADDS tokens, it never removes them — roughly +4.7% on a 15,000-token system prompt. The token saving in the paper is a counterfactual about long sessions, and the compaction half of the architecture has fired 0 times in 980 gate evaluations here, because a 1M window against a peak fill of 33% never reaches the threshold. The recall benefit is real today; the compaction benefit is insurance that has not yet been needed.",
    refs: [
      {
        label: "Total Recall: Pointer-Based Compaction and Task-Conditioned Retrieval (J1)",
        url: `${J_SERIES}/total-recall-pointer-based-compaction-and-task-conditioned-retrieval-for-persistent-llm-agents/`,
        note: "The architecture this plugin implements — §3.2 the Push Pack, §4 task-conditioned scoring, §9 the measurements quoted above.",
      },
      {
        label: "Budget Prompting: Cutting the Cost of Always-On Memory Agents (2-3×)",
        url: `${J_SERIES}/budget-prompting-cutting-the-cost-of-always-on-memory-agents-2-3x/`,
        note: "Why the pack has a fixed token budget instead of injecting everything relevant.",
      },
      {
        label: "MNEMOSYNE: Four Hooks That Upgrade Your Agent's Memory Without Forking It",
        url: `${J_SERIES}/mnemosyne-four-hooks-that-upgrade-your-agents-memory-without-forking-it/`,
        note: "`before_prompt_build` is one of those four hooks — this is that hook firing.",
      },
    ],
  },

  "tinkerclaw-identity-persistence": {
    title: "Identity Persistence · CORTEX",
    what: "Injects the persona block: who this agent is, how it speaks, and its current relational stance, assembled from the SOUL definition and live personality state.",
    profit:
      "It buys a stable voice across context resets, model swaps and restarts. The failure it prevents is specific and expensive: as context fills, attention dilutes and the persona drifts, so the agent you spent months tuning gradually reverts to a generic assistant — and standard memory systems make this worse, because compaction preserves facts while stripping style. Re-establishing a voice by hand costs far more than the milliseconds this takes.",
    evidence:
      "Identity Persistence §7: 50-turn stability at mean SyncScore 0.977; drift recovery from 0.027 back to 0.980; 442× separation between on- and off-persona responses. Human evaluation (30 production logs, 3 judges, Krippendorff's α = 0.81) scored consistency 4.2 ± 0.4 versus 2.6 ± 0.7 for baseline, with recovery within 5 turns in 92% of cases versus 15%. Cost is under 3% of baseline inference: the stable persona block is prompt-cached above 95% of the time, which drops injection from ~$0.006 to ~$0.0006 per turn. On this system it measures 6ms.",
    refs: [
      {
        label:
          "Identity Persistence: Keeping an LLM Agent's Personality Stable Across Sessions, Model Swaps and Restarts",
        url: `${J_SERIES}/identity-persistence-keeping-an-llm-agents-personality-stable-across-sessions-model-swaps-and-restarts/`,
        note: "The paper for this plugin, including the drift model and every figure above.",
      },
    ],
  },

  "tinkerclaw-prefrontal": {
    title: "Recipe Execution · PREFRONTAL",
    what: "Two handlers. One matches the turn against the saved recipe library and seeds a plan when it recognises the shape of the task; the other sets the posture for the turn — how much thinking budget to spend, and which model tier it warrants.",
    profit:
      "It buys the right amount of effort for the question. Without it every turn runs at one setting, so trivial questions are over-thought and hard ones are under-thought — and under-thinking is the expensive failure, because it produces an answer that looks finished and is not, which you then pay to correct. The recipe half buys not re-deriving a procedure you have already solved: a matched recipe replaces the planning conversation with a plan.",
    evidence:
      "Measured on this system at 1ms and 2ms for its two handlers — routing is a pure function of state already held, not an extra model call, which is the common misreading of the pause that precedes it.",
    refs: [
      {
        label:
          "PREFRONTAL: Giving Your Agent an Executive Function with a Recipe Execution Substrate",
        url: `${J_SERIES}/prefrontal-giving-your-agent-an-executive-function-with-a-recipe-execution-substrate/`,
        note: "The substrate that decides the shape of a turn before the model sees it.",
      },
      {
        label: "Round Table: Exploiting Cognitive Diversity as a Computational Resource",
        url: `${J_SERIES}/round-table-exploiting-cognitive-diversity-as-a-computational-resource-in-persistent-ai-agents/`,
        note: "Why choosing the model is a capability decision, not only a cost dial.",
      },
    ],
  },

  "active-memory": {
    title: "Working Memory",
    what: "Looks up the recent working set — what this session has been doing lately — and offers it for injection alongside the retrieval pack.",
    profit:
      "It buys continuity across the seam where the live context ends. Retrieval answers 'what do we know'; this answers 'what were we just doing', which is the thing most likely to be needed and least likely to still be in the window after a compaction or a restart.",
    evidence:
      "Measured on this system: did not fire on the sampled turn, so it currently costs nothing on that path. No independent benefit measurement exists for this plugin.",
    caveat:
      "This is one of three retrieval systems registered on the same hook, alongside Total Recall and the vector store. Nobody has measured whether their results overlap, so part of this cost may be duplicated work — an open question, not a known waste.",
    refs: [
      {
        label: "MNEMOSYNE: Four Hooks That Upgrade Your Agent's Memory Without Forking It",
        url: `${J_SERIES}/mnemosyne-four-hooks-that-upgrade-your-agents-memory-without-forking-it/`,
        note: "The hook contract this plugin and Total Recall both attach to.",
      },
    ],
  },

  "memory-lancedb": {
    title: "Vector Recall",
    what: "Embedding-based nearest-neighbour search over stored memory, offered at prompt-build time.",
    profit:
      "It buys recall of things you did not name exactly. Keyword search finds what you can spell; embeddings find what you meant — the case where you ask about 'the thing with the certificates' and the note says 'SSL renewal'. The pre-computed-index literature argues this should be resolved BEFORE the model sees the prompt, so retrieval costs no inference-time search at all.",
    evidence:
      "J2 (Instant Recall) §9: a pre-computed concept index reaches 0.85 CORF-Recall@20 at 54ms p95 — 5.9× faster than MemGPT-style sequential retrieval (0.79 at 320ms) and 7.7× faster than full multi-source RAG (0.87 at 418ms), at a false-positive rate of 0.18. Its failure-mode census (n=612 annotated queries) attributes ~31% of retrieval misses to anchor silence and ~23% to source blindness.",
    caveat:
      "Did not fire on the sampled turn here. Separately, the pre-computed index J2 describes is NOT running on this deployment: the concept loader reports 0 concepts on every gateway start and its index directory does not exist. What ships is inference-time search, which is the thing the paper argues against — so treat J2's numbers as the target, not as this system's performance.",
    refs: [
      {
        label: "Instant Recall: A Pre-Computed Concept Index for O(1) Memory Retrieval (J2)",
        url: `${J_SERIES}/instant-recall-a-pre-computed-concept-index-for-o1-memory-retrieval-in-persistent-ai-agents/`,
        note: "The index that is supposed to make this step a lookup rather than a scan — including every figure above, and the failure taxonomy it is built from.",
      },
      {
        label: "Fractal Reasoning: Multi-Resolution Memory and Self-Similar Metacognition",
        url: `${J_SERIES}/fractal-reasoning-multi-resolution-memory-and-self-similar-metacognition-for-llm-agents/`,
        note: "Why memory is held at several resolutions, so retrieval can pick one.",
      },
    ],
  },

  "tinkerclaw-computational-humor": {
    title: "Humor Embeddings · LIMBIC",
    what: "Supplies the structural machinery behind humour — pattern types, a scoring function, and an audience model — so wit is a controllable capability rather than an accident of prompting.",
    profit:
      "It buys humour the system can explain and calibrate. A frontier model is already funny by pattern recall, but it cannot tell you WHY a joke works, cannot avoid repeating itself, and cannot be tuned per audience. This adds the scoring function that makes those three possible.",
    evidence:
      "None yet, and the paper says so plainly: whether its scoring function outperforms simply asking a frontier model to rate funniness is an OPEN QUESTION its validation protocol is designed to answer. Measured cost on this system: 9ms.",
    caveat:
      "The only stage here whose benefit is unvalidated by its own authors. Listed honestly rather than dressed up — at 9ms it is also the cheapest thing on the list, so the trade is easy either way.",
    refs: [
      {
        label: "Computational humour: structure, scoring and audience calibration",
        note: "The framework this plugin implements. Its §7.2 validation protocol is the open question above. Link not yet confirmed — cited unlinked rather than guessed.",
      },
    ],
  },

  "skill-workshop": {
    title: "Skill Authoring",
    what: "Injects guidance about the skill-authoring workflow when the configuration asks for it.",
    profit:
      "It buys correctly-shaped skills on the first attempt. The failure it prevents is a skill written to the wrong contract, which fails silently at invocation time and costs a debugging session to find.",
    evidence:
      "Did not fire on the sampled turn — it is configuration-gated, so it costs nothing unless enabled.",
    refs: [],
  },

  diffs: {
    title: "Diff Guidance",
    what: "Adds a fixed block of guidance on how to present code changes as diffs.",
    profit:
      "It buys reviewable output. A change described in prose has to be read and mentally reconstructed before it can be judged; a diff can be checked. This is a constant string with no computation behind it.",
    evidence: "A static constant — no search, no I/O. Did not fire on the sampled turn.",
    refs: [],
  },

  "tinkerclaw-memory-enhancements": {
    title: "Memory Enhancements · MNEMOSYNE",
    what: "Participates in the compaction hook, deciding what leaves the live context and how it is replaced.",
    profit:
      "It buys eviction without destruction. The industry-standard alternative — summarising history into prose — is irreversible: precise strings, causal chains and negative knowledge ('we tried X, it failed') cannot be recovered from a summary. Pointer-based eviction leaves a retrieval directive instead, so nothing is lost, only moved.",
    evidence:
      "J1 §9.4: 100% needle recall under forced compaction versus 0% for truncation, with compaction latency of 1.46ms at 200 events and strictly linear O(T) storage growth rather than the quadratic bloat of recursive summarising. Narrative compaction hallucinated needles in 24% of cases by cycle 5; this stayed flat at 2%.",
    caveat:
      "Has fired 0 times in 980 gate evaluations on this deployment. The gate sits at 980,000 tokens of a 1,000,000-token window and observed fill peaks at 33%. This is correct, tested insurance that has never been claimed on — which is worth knowing before you spend effort optimising it.",
    refs: [
      {
        label: "Total Recall: Pointer-Based Compaction and Task-Conditioned Retrieval (J1)",
        url: `${J_SERIES}/total-recall-pointer-based-compaction-and-task-conditioned-retrieval-for-persistent-llm-agents/`,
        note: "§5 eviction-to-a-pointer, and why the marker is a retrieval directive carrying no semantic content — so it cannot be mistaken for ground truth the way a summary can.",
      },
      {
        label:
          "Sleep Consolidation: How Nightly Prompting Makes a Stateless Agent Get Better Over Time",
        url: `${J_SERIES}/sleep-consolidation-how-nightly-prompting-makes-a-stateless-agent-get-better-over-time/`,
        note: "The offline layer that builds episodic summaries over the lossless store, rather than in place of it.",
      },
    ],
  },
};

/** Shown for a plugin the UI has no entry for — a new one must still say something true. */
const PLUGIN_FALLBACK: PluginDoc = {
  title: "this plugin",
  what: "A plugin that ran during this stage but that this build has no written explanation for yet.",
  profit:
    "Unknown — and that is the finding. A handler on the critical path with no stated benefit is exactly what this breakdown exists to surface: it is spending your seconds without an argument for why.",
  refs: [
    {
      label: "The Building Jarvis series",
      url: J_SERIES,
      note: "The papers behind the architecture these stages belong to.",
    },
  ],
};

/**
 * Look up the explanation for one plugin id.
 *
 * Exact match only. Plugin ids are stable machine identifiers from the registry, so a fuzzy
 * match here would silently attribute one plugin's justification to another — and the whole
 * point of this breakdown is knowing WHICH handler spent the time.
 */
export function pluginDocFor(pluginId: string | undefined | null): PluginDoc {
  const key = (pluginId ?? "").trim();
  if (!key) {
    return PLUGIN_FALLBACK;
  }
  return PLUGIN_DOCS[key] ?? PLUGIN_FALLBACK;
}

/** A friendly name for a plugin id, for the breakdown row itself. */
export function pluginDisplayName(pluginId: string): string {
  const doc = PLUGIN_DOCS[pluginId.trim()];
  if (doc) {
    return doc.title;
  }
  // Strip the fork prefix so an undocumented plugin still reads as words, not as a package id.
  return pluginId.replace(/^tinkerclaw-/, "").replace(/-/g, " ");
}

/** Every documented plugin id, so a test can pin the set and the host allowlist. */
export function documentedPluginIds(): string[] {
  return Object.keys(PLUGIN_DOCS);
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER STAGE DOCS — the inside of "preparing context"
//
// "preparing context" is the longest row in the chat and it is a CLIENT-measured bracket:
// everything between `chat.send` returning and a model being named. Until 2026-08-23 its
// contents were measurable only in the journal, so the one row the architect actually watches
// stayed a single opaque number. These are the twelve awaited steps inside it.
//
// Same rules as PLUGIN_DOCS: profit first, evidence measured and attributed, caveat mandatory
// where the cost is not buying what it appears to.
// ─────────────────────────────────────────────────────────────────────────────

export type StageDoc = {
  title: string;
  what: string;
  profit: string;
  evidence?: string;
  caveat?: string;
};

const STAGE_DOCS: Record<string, StageDoc> = {
  "mcp-tools": {
    title: "Collecting MCP tools",
    what: "Asks every connected MCP server for its current tool list, then sorts and de-collides the names so two servers cannot both claim one tool name.",
    profit:
      "It buys tools that are actually there. The list is fetched per turn rather than cached because a server that started, stopped or gained a tool since the last turn would otherwise be described wrongly — and a model told it has a tool that does not answer produces a failed call and a confused retry, which costs far more than this does.",
    evidence:
      "Measured on this system: p50 839ms, p90 3,869ms, max 5,680ms over 20 runs — the LARGEST per-turn item in the whole pre-model pipeline. Its cost is the round trip to each server; the local sort and rename is trivial.",
    caveat:
      "This is the next thing worth attacking. Caching the catalogue would remove ~0.9s from every turn, at the price of a newly added MCP tool not appearing until the cache is invalidated — a capability question, not a latency one, and so not a decision the latency budget gets to make alone.",
  },
  "lsp-runtime": {
    title: "Language-server tools",
    what: "Builds the language-server tool surface for the workspace — the code-aware operations the agent can perform on this repository.",
    profit:
      "It buys code understanding that is structural rather than textual: go-to-definition and symbol search instead of grep. The failure it prevents is an agent reasoning about code from string matching, which is how you get an edit applied to the wrong one of four identically-named functions.",
    evidence:
      "Measured p50 105ms, p90 141ms. Small, and perfectly constant — it never gets cheaper.",
  },
  "session-lock": {
    title: "Locking the transcript",
    what: "Takes the write lock on this session's transcript file so two runs cannot interleave writes into it.",
    profit:
      "It buys a transcript that is not corrupt. Two runs writing the same JSONL concurrently produce interleaved half-lines, and the transcript IS the memory — a corrupted one loses history that no retry can reconstruct.",
    evidence:
      "Measured p50 2ms — free unless contended. Its entire observed cost is one cold sample of 2,667ms after a gateway restart.",
  },
  "session-repair": {
    title: "Repairing the transcript",
    what: "Checks the transcript for damage from an interrupted write and repairs it before anything reads it.",
    profit:
      "It buys a session that survives a crash. Without it, one truncated line from a kill or a power loss makes the whole transcript unparseable, and the session is gone rather than merely dented.",
    evidence:
      "Measured p50 1ms — free unless there is damage. Its worst observed sample is 2,367ms.",
  },
  "session-prewarm": {
    title: "Warming the transcript file",
    what: "Pulls the transcript into the operating system's page cache before it is parsed.",
    profit:
      "It buys one disk read instead of many small ones during parsing. Pure I/O scheduling — it changes nothing about what the model sees.",
    evidence: "Measured p50 0ms; free once the file is warm.",
  },
  "mcp-runtime": {
    title: "MCP connection",
    what: "Gets or creates the per-session connection to the MCP servers.",
    profit:
      "It buys a connection that is reused rather than re-established per turn. This is the cheap, cached half of MCP — the expensive half is asking those servers what tools they have.",
    evidence: "Measured p50 8ms. Cached; contrast `mcp-tools` at p50 839ms.",
  },
  "resource-reload": {
    title: "Reloading settings",
    what: "Re-reads settings, extensions and compaction guards from disk.",
    profit:
      "It buys configuration changes that take effect on the next turn rather than the next restart. Editing a setting and having it ignored until a reboot is the failure it prevents.",
    evidence: "Measured p50 17ms.",
  },
  "session-open": {
    title: "Opening the session",
    what: "Opens and parses the transcript into a session manager the runner can query.",
    profit:
      "It buys the conversation so far. This is where prior turns become something the model can be shown.",
    evidence:
      "Measured p50 3ms. Runs SYNCHRONOUSLY on the shared event loop, so it was worth watching — an earlier analysis ranked it a real blocking cost at 99ms, and twenty runs put it at 3ms.",
  },
  "system-prompt-build": {
    title: "Assembling the system prompt",
    what: "Builds the ~60,000-character system prompt: identity, skills, tool definitions, memory sections and runtime facts.",
    profit:
      "It buys the agent knowing what it is and what it can do. Everything the model is told about itself is constructed here.",
    evidence:
      "Measured p50 2ms — far cheaper than its size suggests, because assembling a string is not the expensive part. Shipping it is: this prompt is ~15,000 tokens on every turn.",
  },
  "skills-load": {
    title: "Loading skills",
    what: "Resolves which skills exist and are enabled for this run — walking the skill directories, reading each manifest, and applying any environment overrides they declare.",
    profit:
      "It buys the agent knowing what it can do on THIS turn. A skill added, removed or edited since the last turn takes effect immediately rather than at the next restart, which is what makes editing a skill and trying it a single step instead of two.",
    caveat:
      "SYNCHRONOUS, and therefore on the shared event loop: while it runs, nothing else in the gateway moves. That is the same shape as the retrieval pack build, which measured 19.5s of pure freeze before it was fixed. Instrumented on 2026-08-23 because the region containing it held 3.2s on a quiet turn and 41s on a busy one.",
  },
  "skills-prompt": {
    title: "Writing the skills section",
    what: "Turns the resolved skill list into the block of prompt text that tells the model which skills exist and when to reach for each.",
    profit:
      "It buys a skill being INVOKED rather than merely installed. A skill the model has not been told about is dead weight on disk — this is the step that makes the difference.",
    caveat: "Also synchronous, and sits immediately after the load above.",
  },
  "tools-build": {
    title: "Building the tool set",
    what: "Constructs every tool the model may call this turn — bash, file access, message sending, the sandbox wiring — and applies the allow-list.",
    profit:
      "It buys tools bound to THIS run's context: the right workspace, the right sandbox policy, the right elevation. A tool built once and reused across runs would carry the first run's permissions into every later one, which is a security failure rather than a performance win.",
    caveat: "Synchronous, in the same blocking window as the two skill stages above.",
  },
  "bootstrap-routing": {
    title: "Choosing bootstrap files",
    what: "Decides WHICH workspace context files this run should be given — AGENTS.md, SOUL.md, IDENTITY.md, BOOTSTRAP.md and the rest — based on the run kind, whether this session has already bootstrapped, and whether the model has file access to fetch them itself.",
    profit:
      "It buys not re-injecting an agent's whole identity on every turn. The alternative is either shipping every context file every time (expensive, and it crowds the window) or shipping none (an agent that forgets who it is between turns).",
  },
  "bootstrap-context": {
    title: "Assembling bootstrap context",
    what: "Turns that routing decision into the actual list of context files and their contents, applying the per-file and total character budgets.",
    profit:
      "It buys a bounded identity block. Without the budget, one long workspace file would silently consume the context the conversation needs.",
  },
  "bootstrap-files-read": {
    title: "Reading bootstrap files",
    what: "The disk read itself: opening and reading each workspace context file selected above.",
    profit:
      "It buys the agent knowing its own standing instructions on this turn rather than a cached snapshot from whenever the process started — the files are re-read so an edit takes effect on the next turn, not the next restart.",
    caveat:
      "This is a suspect, not a verdict. It sits inside the region that measured 41s on one of the architect's turns, and it is the only disk work in that region — but the four previous attempts to name this region's cost from source were all wrong, so it is instrumented rather than blamed. The numbers will say.",
  },
  "engram-store-load": {
    title: "Loading the memory stores",
    what: "Reading the session's event store and the shared cross-session experience store from disk and parsing them — currently 6.2 MB and 15.6 MB, one JSON.parse per line.",
    profit:
      "It buys memory that includes what happened thirty seconds ago. The store is re-read when the file has changed, so a correction written by another process reaches this turn instead of the next restart.",
    evidence:
      "Measured p50 0ms on most turns — the parsed store is memoised on file identity and survives between builds far more often than the invalidation rule suggests. A controlled run of the cold case measures 179ms.",
  },
  "engram-search-rank": {
    title: "Searching and ranking memory",
    what: "Full-text search across both stores, task-conditioned scoring, redundancy rerank, then assembly into the token-bounded pack that gets stapled to the prompt.",
    profit:
      "This is the half that actually retrieves. It buys the answers that would otherwise need a round of clarifying questions — see the Total Recall plugin popup for the full argument and its measured recall figures.",
    evidence:
      "The cost is O(events × query terms). Measured on the live corpus (3,081 events): a 400-character prompt costs 439ms, a 12,324-character one costs 10,261ms — the architect's own turn measured 10,735ms before the term-deduplication fix took it to ~1.8s.",
  },
  sandbox: {
    title: "Resolving the sandbox",
    what: "Decides which directories this run may read and write.",
    profit:
      "It buys a blast radius. The failure it prevents is an agent writing outside the workspace it was given — cheap insurance, and it genuinely is cheap.",
    evidence: "Measured p50 0ms.",
  },
  "context-bootstrap": {
    title: "Starting the context engine",
    what: "Initialises the context engine for a new or resumed session.",
    profit: "It buys a resumed session picking up where it left off rather than starting blank.",
    evidence: "Measured p50 0ms — free.",
  },
  "session-manager-prepare": {
    title: "Final session setup",
    what: "Last session-manager preparation before the agent object is created.",
    profit: "Plumbing. It buys a correctly constructed agent; it costs nothing.",
    evidence: "Measured p50 0ms — free.",
  },
};

/** Shown for a stage with no entry — a new one must still say something true. */
const STAGE_FALLBACK: StageDoc = {
  title: "this stage",
  what: "A step the runner reported by name but that this build has no written explanation for yet.",
  profit:
    "Unknown — and that is the finding. A step on the critical path with no stated benefit is exactly what this breakdown exists to surface.",
};

/**
 * FORK 2026-08-23 — the GAP stages, `before:<stage>`.
 *
 * Timing twelve individual awaits left the space between them unmeasured, and that space is
 * where the time is: measured over 196 runs, the spans account for p50 1.0s of a p50 5.0s wall
 * clock. The architect read the consequence straight off his screen — "'not accounted for by
 * any stage' holds over 95% of the time". The runner now also emits the interval BEFORE each
 * stage, so the breakdown tiles and an unnamed interval cannot hide again.
 *
 * These are not stages; they are waiting. Naming them as such matters, because a gap before
 * `mcp-tools` is a completely different problem from `mcp-tools` being slow.
 */
function gapDocFor(afterStage: string): StageDoc {
  const name = STAGE_DOCS[afterStage]?.title ?? afterStage.replace(/-/g, " ");
  return {
    title: `Waiting before ${name}`,
    what: `Time between the previous stage finishing and "${name}" starting. No stage is running here — this is the runner getting from one step to the next, plus anything else on the single event loop that took its turn in between.`,
    profit:
      "Nothing. This is the one line on the breakdown that buys you absolutely nothing — it is pure waiting, and every millisecond of it is available to be removed if its cause can be found. The stages around it are doing work; this is the space between them.",
    evidence:
      "Measured across 196 runs: the instrumented stages account for p50 1.0s while the wall clock across them is p50 5.0s, so roughly four seconds in five were falling into gaps like this one. p90 8.1s, max 125.6s.",
    caveat:
      "A large gap is not necessarily this stage's fault. The gateway runs one thing at a time, so a gap can be another session's work, a background reflection, or a panel refresh taking the loop. It says WHERE the time went, not yet WHY.",
  };
}

/**
 * FORK 2026-08-24 — which PLUGIN owns a stage, for gateways that predate the `plugin` tag.
 *
 * The gateway now stamps the owner onto the event itself, which is authoritative. This table is
 * the fallback for the window where a browser has the new UI and the gateway has not restarted
 * yet — without it, "Total Recall" goes back to being one opaque number for the length of that
 * window, which is exactly the complaint being fixed.
 *
 * Keep it SMALL. An entry here is a guess about someone else's code; the tag is a fact.
 */
const STAGE_OWNER_FALLBACK: Record<string, string> = {
  "engram-store-load": "tinkerclaw-total-recall",
  "engram-search-rank": "tinkerclaw-total-recall",
};

/** The plugin that owns a stage, or undefined when the stage belongs to the runner itself. */
export function stageOwner(stage: { id: string; plugin?: string }): string | undefined {
  return stage.plugin ?? STAGE_OWNER_FALLBACK[stage.id.trim()];
}

/** Look up one runner stage. Exact match: stage names are stable identifiers from the runner. */
export function stageDocFor(stage: string | undefined | null): StageDoc {
  const key = (stage ?? "").trim();
  if (key.startsWith("before:")) {
    return gapDocFor(key.slice("before:".length));
  }
  return (key && STAGE_DOCS[key]) || STAGE_FALLBACK;
}

/** Human name for a stage id, for the breakdown row. */
export function stageDisplayName(stage: string): string {
  const key = stage.trim();
  if (key.startsWith("before:")) {
    const after = key.slice("before:".length);
    return `⋯ waiting before ${STAGE_DOCS[after]?.title ?? after.replace(/-/g, " ")}`;
  }
  return STAGE_DOCS[key]?.title ?? key.replace(/-/g, " ");
}

/** Every documented stage, so a test can pin the set against what the runner emits. */
export function documentedStageIds(): string[] {
  return Object.keys(STAGE_DOCS);
}
