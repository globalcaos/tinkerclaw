// FORK 2026-06-10 (amygdala retirement) — extracted from app.ts so the per-turn
// reply section split/render logic is unit-testable in isolation.
//
// HISTORY: the old design asked the model to structure every reply as three
// labelled sections (🧠 AMYGDALA → 💬 ANSWER → 🌿 FRACTAL) and the UI split them
// into separate bubbles (amygdala + fractal collapsed, answer expanded). The
// 🧠 AMYGDALA per-turn section is now RETIRED — the always-visible Amygdala side
// panel (gate-decision stream) is the feedback surface instead. The per-turn
// injection already dropped amygdala (app.ts buildInjectedPrompt now asks only
// for 💬 ANSWER → 🌿 FRACTAL), and the server no longer loads amygdala-prompt.md.
//
// This module is the last piece of the retirement: the UI must STOP carving a
// collapsed 🧠 amygdala bubble. Two things changed vs the old in-app code:
//   1. The splitter no longer recognises a 🧠/🫀 AMYGDALA marker as a section.
//      Any residual amygdala header the model still emits out of session-history
//      habit therefore falls into the pre-marker `other` text (or the answer
//      body) and renders inline as ordinary prose.
//   2. The renderer no longer fabricates a collapsed "🧠 amygdala" block out of
//      pre-answer narration (`sec.other`). That narration is folded INTO the
//      ANSWER bubble inline so nothing falls on the floor and nothing is hidden.
// 🌿 FRACTAL splitting + collapsed rendering is preserved exactly.

export type SectionedReply = {
  answer?: string;
  fractal?: string;
  other?: string;
};

// Markers tolerate: optional markdown heading marks (#, ##, ###, ####), optional
// bold wrapping (** or __), optional colon, optional space between emoji and
// label, and (for the leading anchor) a sentence terminator so a marker glued to
// the previous sentence ("…resolved.💬 ANSWER") still splits — the terminator is
// kept with the preface via the `skip` offset in pushMarker below. See the app.ts
// git history (FORK 2026-05-24 / 2026-05-26) for the exact tolerance rationale.
//
// NOTE: there is deliberately NO amygdala marker here anymore. A 🧠 AMYGDALA
// header is no longer a recognised section; it falls through to `other`/answer.
const ANS_MARKER_RE =
  /(^|\n|[.!?])\s*#{0,4}\s*(?:\*\*|__)?\s*💬\s*(?:\*\*|__)?\s*ANSWER:?(?:\*\*|__)?:?\s*/i;
const FRA_MARKER_RE =
  /(^|\n|[.!?])\s*#{0,4}\s*(?:\*\*|__)?\s*🌿\s*(?:\*\*|__)?\s*FRACTAL(?:\s+ACTION)?:?(?:\*\*|__)?:?\s*/i;

export function splitSectionedReply(text: string): SectionedReply | null {
  if (!text) {
    return null;
  }
  const ansIdx = text.search(ANS_MARKER_RE);
  const fraIdx = text.search(FRA_MARKER_RE);
  if (ansIdx < 0 && fraIdx < 0) {
    return null;
  }
  // Split by whichever markers exist, in order of appearance.
  const markers: { key: "answer" | "fractal"; start: number; hdrLen: number }[] = [];
  const pushMarker = (idx: number, key: "answer" | "fractal", re: RegExp) => {
    if (idx < 0) {
      return;
    }
    const m = text.slice(idx).match(re);
    if (!m) {
      return;
    }
    // If the anchor captured a sentence terminator (`.`/`!`/`?`), that character
    // belongs to the previous sentence's preface, not the marker. Shift the
    // marker start one byte forward and trim its header length so the period
    // stays with the narration when we slice the preface.
    const prefix = m[1] ?? "";
    const skip = prefix && /[.!?]/.test(prefix) ? 1 : 0;
    markers.push({ key, start: idx + skip, hdrLen: m[0].length - skip });
  };
  pushMarker(ansIdx, "answer", ANS_MARKER_RE);
  pushMarker(fraIdx, "fractal", FRA_MARKER_RE);
  markers.sort((a, b) => a.start - b.start);
  const result: SectionedReply = {};
  const preface = text.slice(0, markers[0]?.start ?? 0).trim();
  if (preface) {
    result.other = preface;
  }
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (!m) {
      continue;
    }
    const bodyStart = m.start + m.hdrLen;
    const bodyEnd = markers[i + 1]?.start ?? text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    if (body) {
      result[m.key] = body;
    }
  }
  return result;
}

// Strip any standalone section-marker line the model echoed inside a body. The
// splitter consumes only the FIRST occurrence of each marker; if the model
// echoes one inline ("see the 💬 ANSWER section above") the duplicate stays as
// plain prose and would leak into the rendered bubble. This also strips a bare
// 🧠/🫀 AMYGDALA header the model may still emit from session-history habit, so
// the residual gut-read text renders as clean inline prose with no "🧠 AMYGDALA:"
// label rather than a literal marker line. A residual marker leaks in TWO ways:
// (a) ALONE on its own line, and (b) GLUED into the middle of a sentence (e.g.
// "Body. 💬 ANSWER restated mid-text." or an inline echo "…in the 💬 ANSWER
// above…"). The regex matches BOTH: a leading boundary of start | newline |
// whitespace and NO trailing newline/end lookahead. It stays emoji+label anchored
// (the emoji MUST precede the label) so ordinary prose like "the answer is 42" is
// NEVER matched. The replace callback below preserves the surrounding text shape.
const RESIDUAL_MARKER_RE =
  /(^|\n|\s)\s*#{0,4}\s*(?:\*\*|__)?\s*(?:💬\s*(?:\*\*|__)?\s*ANSWER|🧠\s*(?:\*\*|__)?\s*AMYGDALA|🫀\s*(?:\*\*|__)?\s*AMYGDALA|🌿\s*(?:\*\*|__)?\s*FRACTAL(?:\s+ACTION)?)\s*:?\s*(?:\*\*|__)?\s*:?/gi;
export function scrubResidualSectionMarkers(text: string): string {
  // Preserve the captured leading boundary so surrounding words/lines don't fuse:
  // a newline stays a newline (standalone-line marker), any other whitespace
  // collapses to a single space (mid-line marker → "Body. restated mid-text."),
  // and a start-of-string boundary (no prefix) is dropped.
  return text.replace(RESIDUAL_MARKER_RE, (_match, prefix: string | undefined) => {
    if (prefix === "\n") return "\n";
    if (prefix && /\s/.test(prefix)) return " ";
    return "";
  });
}

// Separate a leading run of inter-tool NARRATION from the answer body. With the
// tinker-bridge brain, Claude Code emits between-step narration ("let me check X",
// "let me pull Y") as VISIBLE TEXT that fuses into the SAME block as the final
// answer, so the narration shows at the top of the answer bubble. This pure,
// dependency-free, content-local heuristic peels ONLY the leading run of complete
// first-person action sentences at the very start of the text. It is conservative
// by construction: it never blanks the answer, and if the first sentence is not
// narration it is a pure no-op.
const NARRATION_OPENERS = [
  "let me",
  "i'll",
  "i will",
  "now i ",
  "now let me",
  "next i ",
  "next, i",
  "next let me",
  "first i ",
  "first, i",
  "first let me",
];
// Closings / answer-content phrases that share a "let me …" opener but are NOT
// inter-tool narration — never peel these.
const NARRATION_EXCLUDE = [
  "let me know",
  "let me explain",
  "let me clarify",
  "let me summari",
  "let me show",
  "let me walk",
];
const NARRATION_ACTION_VERBS = new Set([
  "check",
  "pull",
  "look",
  "read",
  "verify",
  "confirm",
  "inspect",
  "trace",
  "grep",
  "search",
  "run",
  "open",
  "see",
  "find",
  "get",
  "start",
  "scan",
  "fetch",
  "query",
  "test",
  "examine",
  "gather",
  "probe",
  "dig",
  "review",
  "write",
  "build",
  "load",
]);
function isNarrationSentence(sentence: string): boolean {
  const s = sentence.trim().toLowerCase();
  if (!s || s.length > 200) {
    return false;
  }
  if (NARRATION_EXCLUDE.some((ex) => s.startsWith(ex))) {
    return false;
  }
  if (!NARRATION_OPENERS.some((op) => s.startsWith(op))) {
    return false;
  }
  // Must contain at least one action verb token to count as inter-tool narration.
  const words = s.split(/[^a-z']+/);
  return words.some((w) => NARRATION_ACTION_VERBS.has(w));
}
export function splitLeadingNarration(text: string): { narration: string; answer: string } {
  if (!text) {
    return { narration: "", answer: text };
  }
  // Split into sentences on a terminator boundary; keep it simple — if there is
  // no split point the whole text is a single "sentence".
  const sentences = text.split(/(?<=[.!?])\s+/);
  let n = 0;
  while (n < sentences.length && isNarrationSentence(sentences[n] ?? "")) {
    n++;
  }
  // No leading narration → pure no-op.
  if (n === 0) {
    return { narration: "", answer: text };
  }
  // GUARD: every sentence is narration (no trailing non-narration answer) →
  // never blank the answer; return it whole as the answer.
  if (n >= sentences.length) {
    return { narration: "", answer: text };
  }
  const narration = sentences.slice(0, n).join(" ").trim();
  const answer = sentences.slice(n).join(" ").trim();
  return { narration, answer };
}

// Render a split reply into HTML. `md` (markdown→HTML) and `esc` (HTML-escape)
// are injected so this module stays free of the DOM/markdown-it dependencies in
// app.ts and remains unit-testable.
//
// Visual order: ANSWER (expanded) → FRACTAL (collapsed). The retired 🧠 AMYGDALA
// section is gone: pre-marker narration (sec.other) folds INTO the answer bubble
// inline instead of a collapsed reasoning surface, and no amygdala block is ever
// fabricated.
export function renderSectionedReply(
  sec: SectionedReply,
  elapsed: string,
  md: (text: string) => string,
  esc: (s: string) => string,
): string {
  let h = "";
  // Pre-marker narration (sec.other) PLUS any leading inter-tool narration peeled
  // off the answer body itself (tinker-bridge emits "let me check X" between steps as
  // visible text fused into the same block as the final answer) are surfaced in a
  // collapsed Commentary block ABOVE the answer bubble — not folded inline. The
  // retired 🧠 AMYGDALA section is gone; this is a plain reasoning-style surface,
  // never a fabricated amygdala block.
  // When sec.answer exists: peel leading narration from the answer body.
  // When sec.answer absent: sec.other IS the answer body — peel narration from it so
  // "let me X" sentences go into Commentary rather than inflating the answer div.
  // Do NOT include sec.other directly in leadingNarration: that was the old double-render
  // bug (sec.other appeared in Commentary AND in answerBody simultaneously).
  const peel = sec.answer
    ? splitLeadingNarration(sec.answer)
    : sec.other
      ? splitLeadingNarration(sec.other)
      : { narration: "", answer: "" };
  const leadingNarration = sec.answer
    ? [sec.other, peel.narration].filter(Boolean).join("\n\n")
    : peel.narration;
  // Answer body: de-narrated text in both cases. Fallback to sec.other only if
  // splitLeadingNarration returned empty answer (its all-narration guard prevents this
  // in practice, but it is a safety net against blanking the answer).
  const answerBody = sec.answer
    ? peel.answer
    : sec.other && sec.fractal
      ? peel.answer || sec.other
      : undefined;
  if (leadingNarration) {
    h +=
      `<details class="reasoning-group narration-details">` +
      `<summary class="reasoning-header">▸ Commentary</summary>` +
      `<div class="reasoning-content">` +
      `<div class="msg assistant msg-thinking">` +
      `<span class="thinking-label">Commentary:</span> ${md(scrubResidualSectionMarkers(leadingNarration))}` +
      `</div></div></details>`;
  }
  if (answerBody) {
    h += `<div class="msg assistant">${md(scrubResidualSectionMarkers(answerBody))}${elapsed}</div>`;
  } else if (sec.other && !sec.fractal && !leadingNarration) {
    // No markers at all and nothing peeled — fall back to raw.
    h += `<div class="msg assistant">${md(sec.other)}${elapsed}</div>`;
  }
  // The compacted fractal view shows a one-line content summary; if the turn
  // changed an internal md (or code) file, that is surfaced FIRST (📝 file —
  // change) and styled distinctly so a file mutation never hides behind a
  // generic label.
  const detectFileChange = (t: string): { file: string; change: string } | null => {
    const verb = /\b(chang|updat|edit|wrote|writ|modif|append|added|creat|remov|delet)/i;
    const fileRe = /([\w./-]+\.(?:md|markdown|ts|tsx|js|mjs|json|py|css|sh))/i;
    for (const raw of t.split("\n")) {
      const fm = fileRe.exec(raw);
      if (fm && verb.test(raw)) {
        const change = raw
          .replace(/[*_`#>]/g, "")
          .replace(/^\s*[-+]\s*/, "")
          .trim();
        return { file: fm[1], change: change.length > 110 ? change.slice(0, 110) + "…" : change };
      }
    }
    return null;
  };
  const firstLine = (t: string): string => {
    for (const raw of t.split("\n")) {
      const ln = raw.replace(/[*_`#>]/g, "").trim();
      if (ln && !/^[-=]{2,}$/.test(ln)) return ln.length > 90 ? ln.slice(0, 90) + "…" : ln;
    }
    return "";
  };
  const artifactSummary = (t: string, fallback: string): { html: string; cls: string } => {
    const fc = detectFileChange(t);
    if (fc) {
      return {
        html: `📝 <strong>${esc(fc.file)}</strong> — ${esc(fc.change)}`,
        cls: " artifact-filechange",
      };
    }
    const ln = firstLine(t);
    return { html: ln ? esc(ln) : fallback, cls: "" };
  };
  if (sec.fractal) {
    const s = artifactSummary(sec.fractal, "<em>Fractal</em> — reflection");
    h +=
      `<details class="fractal-details">` +
      `<summary class="fractal-summary${s.cls}">🌿 ${s.html}</summary>` +
      `<div class="msg msg-fractal">${md(sec.fractal)}</div>` +
      `</details>`;
  }
  return h;
}
