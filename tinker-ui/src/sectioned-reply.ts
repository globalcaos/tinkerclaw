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
// label rather than a literal marker line. Heuristic — only standalone marker
// lines are removed; a marker that is part of a longer sentence is left alone.
const RESIDUAL_MARKER_RE =
  /(^|\n)\s*#{0,4}\s*(?:\*\*|__)?\s*(?:💬\s*(?:\*\*|__)?\s*ANSWER|🧠\s*(?:\*\*|__)?\s*AMYGDALA|🫀\s*(?:\*\*|__)?\s*AMYGDALA|🌿\s*(?:\*\*|__)?\s*FRACTAL(?:\s+ACTION)?)\s*:?\s*(?:\*\*|__)?\s*:?\s*(?=\n|$)/gi;
export function scrubResidualSectionMarkers(text: string): string {
  return text.replace(RESIDUAL_MARKER_RE, (_match, prefix) => prefix ?? "");
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
  // Fold any pre-marker narration (sec.other) into the answer so it renders
  // inline and nothing falls on the floor. When there is no ANSWER marker but a
  // FRACTAL one exists, promote sec.other to be the answer body. (Previously
  // sec.other was diverted into a fabricated collapsed amygdala block — that is
  // exactly the behaviour being retired.)
  const effectiveAnswer = sec.answer
    ? sec.other
      ? `${sec.other}\n\n${sec.answer}`
      : sec.answer
    : sec.other && sec.fractal
      ? sec.other
      : undefined;
  if (effectiveAnswer) {
    h += `<div class="msg assistant">${md(scrubResidualSectionMarkers(effectiveAnswer))}${elapsed}</div>`;
  } else if (sec.other && !sec.fractal) {
    // No markers at all — fall back to raw.
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
