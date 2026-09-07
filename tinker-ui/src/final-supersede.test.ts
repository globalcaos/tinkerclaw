import { describe, expect, it } from "vitest";
import {
  bubbleSegStart,
  bubbleText,
  fingerprintText,
  isRunTextBubble,
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
