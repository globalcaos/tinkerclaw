import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bubbleSegStart,
  bubbleText,
  finalTextBubbles,
  fingerprintText,
  isRunTextBubble,
  planFinalWrite,
  runTextBubbles,
  sameTextCount,
  supersedingAppendTail,
} from "./final-supersede.js";
import { resliceSegments } from "./stream-reslice.js";

const txt = (text: string) => [{ type: "text", text }];

describe("runTextBubbles — which bubbles a superseding final reconciles against", () => {
  it("selects this run's assistant text bubbles, in render order", () => {
    const messages = [
      { role: "user", content: txt("hi"), _runId: "r1" },
      { role: "assistant", content: txt("first"), _runId: "r1" },
      { role: "assistant", content: txt("other run"), _runId: "r2" },
      { role: "assistant", content: txt("second"), _runId: "r1" },
    ];
    expect(runTextBubbles(messages, "r1").map(bubbleText)).toEqual(["first", "second"]);
  });

  it("ignores bubbles with no run stamp, and tool-only bubbles with no text block", () => {
    const messages = [
      { role: "assistant", content: txt("unstamped") },
      { role: "assistant", content: [{ type: "tool_use", id: "t1" }], _runId: "r1" },
    ];
    expect(runTextBubbles(messages, "r1")).toEqual([]);
  });

  it("returns nothing for an empty runId rather than matching undefined stamps", () => {
    expect(runTextBubbles([{ role: "assistant", content: txt("x") }], "")).toEqual([]);
    expect(isRunTextBubble({ role: "assistant", content: txt("x") }, "")).toBe(false);
  });
});

describe("the double-final reconciliation (the 'answers twice every turn' bug)", () => {
  // Shapes measured live on one tool-using turn, same runId:
  //   final #1 (lifecycle, streamed buffer): the narration only
  //   final #2 (backstop, joined deliveredReplies): narration + the answer that never streamed
  const narration = "Running the literal string `echo HELLOPROBE` in bash so I can report back.";
  const answer = "\n\nIt printed HELLOPROBE.";
  const supersedingBody = narration + answer;

  it("appends ONLY the unseen answer — the narration is not rendered twice", () => {
    const rendered = [{ role: "assistant", content: txt(narration), _runId: "r1" }];
    const bubbles = runTextBubbles(rendered, "r1").map((m) => ({
      text: bubbleText(m),
      segStart: bubbleSegStart(m),
    }));

    const out = resliceSegments(bubbles, supersedingBody);

    // Everything the run ends up showing: the reconciled bubbles plus any appended tail. The
    // answer may arrive either as an in-place EXTENSION of the narration bubble (it is a legal
    // growth — same prefix, longer) or as a new tail bubble; the contract is about the RESULT,
    // not which of the two the reslice law picks.
    const all = out.texts.join("") + (out.appendTail ?? "");

    // THE REGRESSION: the narration must appear exactly ONCE. Before the fix the superseding
    // final was pushed whole alongside the already-promoted narration bubble, so it appeared twice
    // — the "Jarvis answers twice every turn" report.
    expect(all.split("Running the literal string").length - 1).toBe(1);
    // ...and the answer that never streamed is still there. Dropping the second final would have
    // satisfied the assertion above while silently losing this.
    expect(all).toContain("It printed HELLOPROBE.");
    // Nothing gained, nothing lost.
    expect(all.replace(/\s+/g, " ").trim()).toBe(supersedingBody.replace(/\s+/g, " ").trim());
    // No bubble ever shrinks.
    expect(out.texts[0].startsWith(narration)).toBe(true);
  });

  it("appends nothing when the superseding body is already fully on screen", () => {
    const bubbles = [{ text: supersedingBody, segStart: 0 }];
    const out = resliceSegments(bubbles, supersedingBody);
    expect(out.texts).toEqual([supersedingBody]);
    expect(out.appendTail ?? "").toBe("");
  });

  it("never deletes rendered text when the two bodies diverge", () => {
    // A body that shares no prefix with what is on screen must still not blank the bubble --
    // divergence becomes an append, never an overwrite.
    const bubbles = [{ text: "something the user already read", segStart: 0 }];
    const out = resliceSegments(bubbles, "a completely different envelope");
    expect(out.texts[0]).toBe("something the user already read");
  });

  it("a run with nothing on screen yields no prior bubbles, so the final is pushed whole", () => {
    // This is the FIRST-final path: unchanged behaviour, which is what keeps a normal turn normal.
    expect(
      runTextBubbles([{ role: "assistant", content: txt("x"), _runId: "other" }], "r1"),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FORK 2026-08-30 — the ORIGINAL-TAB sequence, from the live report on
// `agent:main:tinker:mtfp4w3a`: the last two answers rendered TWICE in the tab that had been open
// all along, while `chat.history` held exactly ONE final assistant message and a tab opened fresh
// on the same session was clean.
//
// The tests above only ever exercised the geometry where final #2 is a strict textual EXTENSION of
// final #1 (`narration` → `narration + answer`). That is the one shape the two gateway builders
// agree on, and it is why this shipped: the shapes they DISAGREE on are the ordinary ones.
// `emitChatFinal` sends the streamed buffer verbatim; `broadcastChatFinal` sends
// `deliveredReplies.map(p => p.text.trim()).join("\n\n")`. Every difference between them is
// whitespace, and every test inside `resliceSegments` is a strict `startsWith`/`endsWith`.
//
// `applyFinal` below is the two branches of app.ts's chat-final handler, reduced to the decision
// under test: a FIRST final for a run (nothing of that run on screen) is pushed whole and stamped
// with its runId; a SECOND final for the same runId supersedes, and reconciles instead of pushing.
// app.ts itself is a 29k-line browser entry that cannot be imported, so the harness stands in for
// its control flow while the RULE under test is the real, shipped module.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("the original-tab double-final sequence (2026-08-30)", () => {
  type Bubble = { role: string; content: { type: string; text: string }[]; _runId?: string };

  const applyFinal = (messages: Bubble[], runId: string, body: string): Bubble[] => {
    const prior = runTextBubbles(messages as Record<string, unknown>[], runId);
    if (prior.length === 0) {
      // FIRST final: nothing this run put on screen, so it is pushed whole — stamped, so the
      // second final the gateway always sends can find it.
      return [...messages, { role: "assistant", content: txt(body), _runId: runId }];
    }
    // SUPERSEDING final: reconcile against what the run already shows.
    const out = resliceSegments(
      prior.map((m) => ({ text: bubbleText(m), segStart: bubbleSegStart(m) })),
      body,
    );
    const next = messages.map((m) => {
      const idx = prior.indexOf(m as never);
      return idx < 0 ? m : { ...m, content: txt(out.texts[idx] ?? bubbleText(m)) };
    });
    const tail = supersedingAppendTail(
      next.filter((m) => m._runId === runId).map((m) => bubbleText(m)),
      body,
    );
    return tail ? [...next, { role: "assistant", content: txt(tail), _runId: runId }] : next;
  };

  const visible = (messages: Bubble[]) => messages.map(bubbleText).join("\n");
  const copies = (messages: Bubble[], phrase: string) => visible(messages).split(phrase).length - 1;

  const ANSWER = "A careful map now exists, and every road on it is checked.";

  it("does not render the answer twice when the streamed buffer had a leading newline", () => {
    // The exact geometry that produced two byte-identical bubbles: #1 carries the model's leading
    // newline, #2 is the same text `.trim()`ed. Nothing is a prefix of anything, so the old rule
    // credited ZERO characters as shown and appended the entire body a second time.
    const streamed = `\n${ANSWER}`;
    let messages: Bubble[] = [];
    messages = applyFinal(messages, "r1", streamed);
    messages = applyFinal(messages, "r1", streamed.trim());

    expect(copies(messages, ANSWER)).toBe(1);
  });

  it("does not re-render parts that were streamed '\\n'-joined and rebuilt '\\n\\n'-joined", () => {
    const narration = "Checking the map before I answer.";
    const fractal = "FRACTAL: nothing durable to record.";
    // The stream ran the parts together with single newlines...
    const streamed = `${narration}\n${ANSWER}\n${fractal}`;
    // ...and the backstop rebuilt them from the delivered replies with the fixed "\n\n" joiner.
    const rebuilt = [narration, ANSWER, fractal].join("\n\n");

    let messages: Bubble[] = [];
    messages = applyFinal(messages, "r1", streamed);
    messages = applyFinal(messages, "r1", rebuilt);

    expect(copies(messages, ANSWER)).toBe(1);
    expect(copies(messages, narration)).toBe(1);
    expect(copies(messages, fractal)).toBe(1);
  });

  it("still delivers the post-tool answer that exists only in the second final", () => {
    // The reason the second final cannot simply be ignored: claude-cli emits no stream during tool
    // work, so #1 is the narration alone and the answer arrives only in #2. Suppressing it would
    // trade a visible duplicate for silent data loss.
    const narration = "Running the check now.";
    let messages: Bubble[] = [];
    messages = applyFinal(messages, "r1", narration);
    messages = applyFinal(messages, "r1", `${narration}\n\n${ANSWER}`);

    expect(copies(messages, narration)).toBe(1);
    expect(copies(messages, ANSWER)).toBe(1);
  });

  it("keeps two DISTINCT messages that happen to carry identical text", () => {
    // The guard against re-inventing `dedupeAssistantAnswers()`: asking the same question twice
    // must show the same answer twice. Different runs are never compared.
    let messages: Bubble[] = [];
    messages = applyFinal(messages, "r1", ANSWER);
    messages = applyFinal(messages, "r1", ANSWER);
    messages = applyFinal(messages, "r2", ANSWER);
    messages = applyFinal(messages, "r2", ANSWER);

    expect(copies(messages, ANSWER)).toBe(2);
  });

  it("a fresh reconstruction from server history stays clean, as the cloned tab did", () => {
    // The control that made this a CLIENT-state bug: `chat.history` holds one message and carries
    // no `_runId`, so a tab built from it has no run bubbles, takes no supersede path, and cannot
    // duplicate. Any fix that made the reconstruction dirty would be fixing the wrong layer.
    const history: Bubble[] = [{ role: "assistant", content: txt(ANSWER) }];
    expect(runTextBubbles(history as Record<string, unknown>[], "r1")).toEqual([]);
    expect(copies(history, ANSWER)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROVENANCE (2026-08-30). The whitespace fix above landed and the architect still saw duplicates
// on the ORIGINAL tab, while a freshly cloned tab of the same session stayed clean. Same page and
// same module, so the difference is per-tab STATE — and the state the supersede rule depends on is
// the client-only `_runId` stamp, which `loadChat`'s `messages = incoming` destroys wholesale.
//
// These tests do not assert a fix. They pin down the two halves of the mechanism so the next live
// reproduction is read rather than guessed: the fingerprint that makes a duplicate visible in the
// console without printing anyone's message, and the exact blindness of the fallback guard that
// runs once the stamps are gone.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("fingerprintText — content-free message identity for the duplicate log", () => {
  it("gives the two finals of one answer the SAME identity despite their whitespace", () => {
    // This is the whole point: #1 is the streamed buffer, #2 is the parts trimmed and rejoined on
    // "\n\n". A fingerprint that disagreed on those would never show the duplicate as a duplicate.
    const streamed = "\nFirst part.\nSecond part.";
    const rebuilt = "First part.\n\nSecond part.";
    expect(fingerprintText(streamed)).toBe(fingerprintText(rebuilt));
  });

  it("separates genuinely different bodies, and never echoes the text", () => {
    const fp = fingerprintText("the quick brown fox");
    expect(fp).not.toBe(fingerprintText("the quick brown fix"));
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).not.toContain("quick");
  });

  it("reports empty and whitespace-only bodies as `empty` rather than a hash", () => {
    expect(fingerprintText("")).toBe("empty");
    expect(fingerprintText("   \n\t ")).toBe("empty");
    expect(fingerprintText(undefined)).toBe("empty");
  });
});

describe("sameTextCount — 'is this already on screen?'", () => {
  it("counts a body already shown, ignoring whitespace differences", () => {
    expect(sameTextCount(["Alpha beta.", "Gamma."], "Alpha   beta.")).toBe(1);
  });

  it("counts a legitimately repeated answer twice — it is not a dedupe rule", () => {
    // Asking the same question twice must stay two answers. Anything reading this number as
    // permission to delete would be re-inventing the deleted `dedupeAssistantAnswers()`.
    expect(sameTextCount(["Same answer.", "Same answer."], "Same answer.")).toBe(2);
  });

  it("never matches an empty candidate", () => {
    expect(sameTextCount(["", "  "], "")).toBe(0);
  });
});

describe("why the fallback guard cannot see a multi-bubble duplicate (the lost-stamp path)", () => {
  // The run put TWO bubbles on screen — narration, then the post-tool answer. The gateway's second
  // final carries them JOINED, because `broadcastChatFinal` rebuilds the body from deliveredReplies.
  const narration = "Let me open the file and check what it says.";
  const answer = "The file declares the timeout twice, and the second one wins.";
  const onScreen = [narration, answer];
  const secondFinalBody = `${narration}\n\n${answer}`;

  it("the whole-body guard scores ZERO — the joined body equals no single bubble", () => {
    // `pushAssistantMsgDeduped` asks exactly this question, against one bubble at a time. Both
    // halves are plainly on screen and the answer is still "not found", so the body is pushed
    // whole and the turn renders twice. This is the guard app.ts documents at the reconnect note;
    // the finding is that it is INSUFFICIENT, not bypassed — it simply cannot express the case.
    expect(sameTextCount(onScreen, secondFinalBody)).toBe(0);
  });

  it("the run-scoped rule scores it correctly — nothing is missing, so nothing is appended", () => {
    // Same inputs, the question posed per-RUN instead of per-bubble. The whole body is accounted
    // for across the two bubbles, so the tail is empty and no duplicate can be produced. The rule
    // is right; it is only ever reached while the run's `_runId` stamps still exist.
    expect(supersedingAppendTail(onScreen, secondFinalBody)).toBe("");
  });

  it("and a run whose stamps were stripped is invisible to that rule", () => {
    // What a history reload leaves behind: the same two bubbles, carrying no run stamp. The
    // supersede path selects nothing, so app.ts falls to the whole-body guard above — the exact
    // sequence a `history:replace` line between two same-runId `final:decision` lines would prove.
    const reloaded = [
      { role: "assistant", content: txt(narration) },
      { role: "assistant", content: txt(answer) },
    ];
    expect(runTextBubbles(reloaded as Record<string, unknown>[], "r1")).toEqual([]);
    expect(supersedingAppendTail([], secondFinalBody)).toBe(secondFinalBody);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FORK 2026-10-03 — THE MID-WORD TAIL (bug-log [final-mixed-coordinates]). Two live tabs drew the
// full answer and then a second bubble holding the answer from a mid-word offset to its end, while
// `chat.history` served the answer once. The superseding final reconciled against EVERY bubble
// stamped with the run, reasoning bubbles included, and a reasoning bubble's `_segmentStart` counts
// characters of the THINKING buffer (app.ts thinking writer, live-continuation.ts `start =
// seen.length`). `resliceSegments` ends each bubble at the next one's start, so a narration bubble
// followed by a thought grew to `final[narrStart:thinkingLength]`, the tail rule's cursor stopped
// there, and `final.slice(thinkingLength)` was pushed as a new bubble.
//
// Geometry measured from the second tab's claude-cli transcript (2026-10-03 03:11-03:16Z): four
// narration blocks of 117/153/188/69 characters glued to a 3,752-character answer (the gateway joins
// text blocks with no separator), and seven thoughts of 225/276/264/304/297/326/302 characters, each
// ending "\n\n". The live page cut the answer at 837 = 1364 (the trimmed thinking before thought 6)
// minus 527 (the narration).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("a reasoning bubble never takes part in a final's text reconciliation (2026-10-03)", () => {
  /** Deterministic prose of an exact length that neither starts nor ends with whitespace. */
  const prose = (len: number, seed: number): string => {
    const words = ["tea", "leaf", "hill", "rain", "kettle", "steep", "green", "oolong", "roll"];
    let s = "";
    let x = (seed * 7919 + 17) | 0;
    while (s.length < len + 2) {
      x = (Math.imul(x, 1103515245) + 12345) | 0;
      const u = x >>> 0;
      s += `${words[u % words.length]}${u % 7 === 0 ? ". " : " "}${u % 99991} `;
    }
    return `${s.slice(0, len - 1)}x`;
  };
  const RUN = "run-b";
  const NARRATION = [117, 153, 188, 69].map((n, i) => prose(n, 10 + i));
  const ANSWER = `**Jarvis:** *Sent.* ${prose(3752 - 20, 99)}`;
  const FINAL = NARRATION.join("") + ANSWER;
  const THOUGHTS = [225, 276, 264, 304, 297, 326, 302].map((n, i) => `${prose(n - 2, 50 + i)}\n\n`);

  /** A thought as the live writer pushes it: `_runId`, a text block, and a THINKING-buffer offset
   *  (the trimmed cumulative reasoning when the thought opened). */
  const thought = (k: number): Record<string, unknown> => {
    const before = THOUGHTS.slice(0, k).join("").trim();
    const after = THOUGHTS.slice(0, k + 1)
      .join("")
      .trim();
    return {
      role: "assistant",
      content: txt(after.slice(before.length)),
      _isReasoning: true,
      _reasoningRunId: RUN,
      _runId: RUN,
      _segmentStart: before.length,
    };
  };
  /** A text bubble as the delta writer pushes it: a TEXT-buffer offset. Index 4 is the answer. */
  const text = (i: number): Record<string, unknown> => ({
    role: "assistant",
    content: txt(i < NARRATION.length ? NARRATION[i] : ANSWER),
    _runId: RUN,
    _segmentStart: NARRATION.slice(0, i).join("").length,
  });
  /** The page after the first final promoted everything, in the order the turn wrote it. */
  const page = (): Record<string, unknown>[] => [
    text(0),
    thought(0),
    thought(1),
    thought(2),
    thought(3),
    thought(4),
    text(1),
    text(2),
    thought(5),
    thought(6),
    text(3),
    text(4),
  ];
  /** What app.ts runs on a SUPERSEDING final: the shipped selection, then the shipped write. */
  const supersede = (messages: Record<string, unknown>[], body: string) => {
    const bubbles = finalTextBubbles(messages, RUN, false, () => false);
    const plan = planFinalWrite(bubbles, body, true);
    return { before: bubbles.map(bubbleText), after: plan.texts, tail: plan.appendTail };
  };

  it("pins the measured geometry: the old cut was a thinking length inside the answer", () => {
    expect(thought(5)._segmentStart).toBe(1364);
    expect(1364 - NARRATION.join("").length).toBe(837);
  });

  it("a reasoning bubble is not a run text bubble, though it carries the run and a text block", () => {
    expect(isRunTextBubble(thought(0), RUN)).toBe(false);
    expect(runTextBubbles(page(), RUN)).toHaveLength(5);
  });

  it("a second final with the same body appends nothing (the mid-word tail)", () => {
    expect(supersede(page(), FINAL).tail).toBe("");
  });

  it("no narration bubble grows into the answer", () => {
    const { before, after } = supersede(page(), FINAL);
    expect(after).toEqual(before);
  });

  it("a post-tool answer that never streamed lands whole in its own bubble, the narration untouched", () => {
    // The reason the second final exists at all: the answer can live only in its body.
    const { before, after, tail } = supersede(page().slice(0, -1), FINAL);
    expect(after).toEqual(before);
    expect(tail).toBe(ANSWER);
  });

  // FORK 2026-10-03, review round 1 — in 20 of 649 two-final runs from 2026-09-23 to 10-03 the first
  // final carried the narration only and the second added the answer (measured on the gateway journal).
  // Reslicing the settled narration against the second body let its last bubble grow over the
  // answer, one glued bubble where a reload draws a folded narration and the answer on its own.
  it("a superseding final that adds an answer the first one lacked appends it as its own bubble", () => {
    const narration = "I'll look up the opening hours first.";
    const answer = "**Jarvis:** *The museum opens at ten.* It closes at six on weekdays.";
    for (const withThought of [true, false]) {
      const messages: Record<string, unknown>[] = [
        { role: "assistant", content: txt(narration), _runId: RUN, _segmentStart: 0 },
        ...(withThought ? [thought(0)] : []),
      ];
      const bubbles = finalTextBubbles(messages, RUN, false, () => false);
      const plan = planFinalWrite(bubbles, `${narration}\n\n${answer}`, true);
      expect(plan.texts).toEqual([narration]);
      expect(plan.appendTail).toBe(answer);
    }
  });

  it("a superseding final with the first one's body appends nothing and changes nothing", () => {
    const plan = planFinalWrite(
      finalTextBubbles(page(), RUN, false, () => false),
      FINAL,
      true,
    );
    expect(plan.texts).toEqual([...NARRATION, ANSWER]);
    expect(plan.appendTail).toBe("");
  });

  it("the first final takes the run's live text temps, never a thought, even one still marked live", () => {
    const temps = page().map((m) => ({ ...m, _temporary: true }));
    const owns = (m: Record<string, unknown>) => m._temporary === true && m._runId === RUN;
    const chosen = finalTextBubbles(temps, RUN, true, owns);
    expect(chosen).toHaveLength(5);
    expect(chosen.some((m) => m._isReasoning === true)).toBe(false);
    // ...and only temps: a promoted bubble is not the first final's to reslice.
    expect(finalTextBubbles(page(), RUN, true, owns)).toEqual([]);
  });

  it("the first final grows a partly streamed answer to the full body and appends nothing", () => {
    const temps = page().map((m) => ({ ...m, _temporary: true }));
    temps[temps.length - 1].content = txt(ANSWER.slice(0, 900));
    const owns = (m: Record<string, unknown>) => m._temporary === true && m._runId === RUN;
    const plan = planFinalWrite(finalTextBubbles(temps, RUN, true, owns), FINAL, false);
    expect(plan.texts).toEqual([...NARRATION, ANSWER]);
    expect(plan.appendTail).toBe("");
  });
});

// ─── app.ts wiring (source check) ────────────────────────────────────────────────────────────────
// FORK 2026-10-03 — the module rules above are only as good as app.ts's use of them: restoring the
// inline run-stamp selection in the final handler, or dropping a wire below, brings the mid-word
// tail, the gap-filled twin or the unattributed answer back with every module test green.
describe("app.ts wires the duplicate fixes (source check)", () => {
  const srcRoot = ["tinker-ui/src", "src"]
    .map((p) => join(process.cwd(), p))
    .find((p) => existsSync(join(p, "app.ts")));
  if (!srcRoot) {
    throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
  }
  // Line comments stripped, so a comment can neither satisfy nor break an assertion.
  const app = readFileSync(join(srcRoot, "app.ts"), "utf8").replace(/\/\/.*$/gm, "");

  it("the final handler selects and writes through the module, never by run stamp alone", () => {
    expect(app).toContain("finalTextBubbles(");
    expect(app).toContain("planFinalWrite(");
    expect(app).not.toMatch(/hadTemps \? ownsTempMsg\(m\) : m\._runId === p\.runId/);
  });

  it("a run's shown text is read for that run only (and the turn it resumes)", () => {
    const calls = app.split("runShownTexts(").slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.slice(0, c.indexOf(")"))).toContain("runScopeOf(");
    }
  });

  it("every live text write stamps the bubble's last write", () => {
    expect(app.split("_lastWriteAt").length - 1).toBeGreaterThanOrEqual(6);
  });

  it("every sectioned reply passes the row's history identity", () => {
    const calls = app.split("renderSectionedReply(").slice(1);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.slice(0, c.indexOf(");"))).toContain("ocIdAttrs(msg, part)");
    }
  });
});

describe("the voice-span double (2026-09-24, work tab: every answer twice)", () => {
  // Final #1: the raw streamed text. Final #2: the same reply after the gateway's (now removed)
  // `applyJarvisVoiceMarkup`, byte for byte as it arrived on the wire — note the wrapper TRIMMED
  // each span's content, so the blank line before the second label is gone as well.
  const NARRATION = "**Jarvis:** *A loose cable. Checking the watcher.*";
  const ANSWER_BODY = "**Jarvis:** *The box is back.*\n\nThe link dropped at 10:46.";
  const FRACTAL = "🌿 FRACTAL: clean.";
  const RAW = `${NARRATION}\n\n${ANSWER_BODY}\n\n${FRACTAL}`;
  const MARKED =
    '**Jarvis:** <span class="jarvis-voice">*A loose cable. Checking the watcher.*</span>' +
    '**Jarvis:** <span class="jarvis-voice">*The box is back.*\n\nThe link dropped at 10:46.' +
    "\n\n🌿 FRACTAL: clean.</span>";

  it("appends nothing when the run already shows the reply as one bubble", () => {
    // Before the fix this returned all of MARKED: no shown text could be found inside it.
    expect(supersedingAppendTail([RAW], MARKED)).toBe("");
  });

  it("appends nothing when the stream glued the narration onto the answer with no whitespace", () => {
    // Measured on the same tab: the pre-tool narration and the post-tool answer arrive as ONE text
    // with nothing between them (`…watcher.***Jarvis:**`), and the wrapper put `</span>` exactly
    // there. A rule that read the tag as a space failed this geometry on 3 of 8 real runs.
    const glued = `${NARRATION}${ANSWER_BODY}`;
    const markedGlued =
      '**Jarvis:** <span class="jarvis-voice">*A loose cable. Checking the watcher.*</span>' +
      '**Jarvis:** <span class="jarvis-voice">*The box is back.*\n\nThe link dropped at 10:46.</span>';
    expect(supersedingAppendTail([glued], markedGlued)).toBe("");
  });

  it("appends nothing when the run shows it as narration, answer and fractal bubbles", () => {
    expect(supersedingAppendTail([NARRATION, ANSWER_BODY, FRACTAL], MARKED)).toBe("");
  });

  it("appends nothing after the stream-reslice step, the way app.ts runs it", () => {
    const prior = [{ text: RAW, segStart: 0 }];
    const resliced = resliceSegments(prior, MARKED);
    expect(supersedingAppendTail(resliced.texts, MARKED)).toBe("");
  });

  it("still delivers the part of a marked final that the run never showed", () => {
    const tail = supersedingAppendTail([NARRATION], MARKED);
    expect(tail).toContain("The box is back.");
    expect(tail).toContain("The link dropped at 10:46.");
    expect(tail).not.toContain("A loose cable.");
  });

  it("ignores only the voice span — other markup inside the text still has to match", () => {
    expect(supersedingAppendTail(["**Jarvis:** *hi*"], "**Jarvis:** <b>*hi*</b>")).not.toBe("");
  });
});
