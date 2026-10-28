import { describe, expect, it, vi } from "vitest";
import {
  askFromCommand,
  createAskSessionUi,
  parseAskSessionCall,
  renderAskCard,
  renderTrail,
  type AskCardDeps,
} from "./ask-session-card.js";

// FORK 2026-10-21 — the purple ask-session card: a purple box with the question asked, the session it woke and the
// answer; expanded, all the thinking and tool calls of that other session.

const S = "~/src/tinkerclaw/skills/ask-session/scripts/sessions.py";
const SID = "4e4c3737-d158-46a5-a7e8-d54e915a48d2";
const record = (extra: Record<string, unknown> = {}) =>
  "[ask-session] " +
  JSON.stringify({
    v: 1,
    id: SID,
    title: "OpenRAMAN build plan",
    date: "2026-10-12",
    question: 'Where is the "parked" plan?',
    transcript: { path: "/x.jsonl", fromByte: 100, toByte: 900 },
    duration_s: 41.3,
    error: false,
    ...extra,
  });
const okOut = [
  `Session ${SID} (2026-10-12) says:`,
  "",
  "**Short answer:** the plan is parked.",
  "",
  "[testimony, not verified; woke in 41.3 s; preamble on; tokens: in 10]",
  record(),
].join("\n");

const deps = (open: string[] = []): AskCardDeps => ({
  esc: (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  md: (s) => `<p>${s}</p>`,
  toolSummary: (name) => `ran ${name}`,
  toolDetail: (name) => `<div class="explanation">${name}</div>`,
  isExpanded: (tid) => open.includes(tid),
});

describe("recognising an ask", () => {
  it("reads the id and the quoted question from the skill's documented command forms", () => {
    expect(askFromCommand(`python3 -I ${S} ask 8b4c7d70 "Why SQLite and not JSON?"`)).toEqual({
      sessionId: "8b4c7d70",
      question: "Why SQLite and not JSON?",
    });
    expect(
      askFromCommand(
        `S=${S}; python3 -I $S ask 8b4c7d70 'Which file holds the limit?' --timeout 90`,
      ),
    ).toEqual({ sessionId: "8b4c7d70", question: "Which file holds the limit?" });
    expect(askFromCommand(`python3 -I ${S} ask 8b4c "say \\"hi\\" twice"`)?.question).toBe(
      'say "hi" twice',
    );
  });

  it("leaves find, show, cost and unrelated commands as ordinary rows", () => {
    expect(askFromCommand(`python3 -I ${S} find "gantt tab"`)).toBeNull();
    expect(askFromCommand(`python3 -I ${S} show 8b4c7d70`)).toBeNull();
    expect(askFromCommand(`git log --oneline`)).toBeNull();
    expect(parseAskSessionCall("Read", { command: `${S} ask 8b4c7d70 "q"` })).toBeNull();
  });

  it("is a running card before the result arrives", () => {
    const c = parseAskSessionCall("Bash", { command: `python3 -I ${S} ask 8b4c7d70 "q?"` })!;
    expect(c).toMatchObject({
      state: "running",
      sessionId: "8b4c7d70",
      question: "q?",
      answer: null,
    });
  });

  it("takes session, title, question and range from the record and the answer from the text", () => {
    const c = parseAskSessionCall(
      "Bash",
      { command: `python3 -I ${S} ask 4e4c3737 "Where?"` },
      { content: okOut, isError: false },
    )!;
    expect(c).toMatchObject({
      state: "answered",
      sessionId: SID,
      title: "OpenRAMAN build plan",
      date: "2026-10-12",
      question: 'Where is the "parked" plan?',
      answer: "**Short answer:** the plan is parked.",
      range: { fromByte: 100, toByte: 900 },
      durationS: 41.3,
    });
  });

  it("reads the --json form and an array-of-text result", () => {
    const json = JSON.stringify({
      id: SID,
      title: "T",
      question: "q",
      answer: "A.",
      testimony: true,
      error: false,
      transcript: { fromByte: 1, toByte: 2 },
    });
    const c = parseAskSessionCall(
      "exec",
      { command: `python3 -I ${S} ask ${SID} "q" --json` },
      { content: JSON.stringify([{ type: "text", text: json }]) },
    )!;
    expect(c).toMatchObject({ state: "answered", answer: "A.", range: { fromByte: 1, toByte: 2 } });
  });

  it("shows a refusal and a failed wake as such", () => {
    const refused = parseAskSessionCall(
      "Bash",
      { command: `python3 -I ${S} ask 8b4c7d70 "q"` },
      { content: "ask-session: refused: a running process holds this session", isError: true },
    )!;
    expect(refused).toMatchObject({
      state: "refused",
      note: "refused: a running process holds this session",
    });
    const failed = parseAskSessionCall(
      "Bash",
      { command: `python3 -I ${S} ask 8b4c7d70 "q"` },
      {
        content: "ask-session: the wake failed (exit 1, 3 s).\n" + record({ error: true }),
        isError: true,
      },
    )!;
    expect(failed.state).toBe("failed");
    expect(failed.range).toEqual({ fromByte: 100, toByte: 900 });
  });
});

const slice = [
  { role: "user", content: "⟦ASK-SESSION⟧ wake-up note and the question" },
  { role: "assistant", content: [{ type: "thinking", thinking: "look at the note" }] },
  { role: "assistant", content: [{ type: "text", text: "Reading the project note." }] },
  {
    role: "assistant",
    content: [
      { type: "toolcall", id: "tu1", name: "Read", arguments: { file_path: "/n.md" } },
      { type: "tool_result", tool_use_id: "tu1", content: "parked <since> 10-12" },
    ],
  },
  { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
  { role: "assistant", content: [{ type: "text", text: "The plan is parked." }] },
];

describe("the woken session's trail", () => {
  it("draws thinking, narration and tool rows in order, without the wake prompt", () => {
    const h = renderTrail(slice, "ask:t", deps());
    expect(h).not.toContain("ASK-SESSION");
    const order = [
      "look at the note",
      "Reading the project note.",
      "ran Read",
      "The plan is parked.",
    ].map((s) => h.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].toSorted((a, b) => a - b)).toEqual(order);
    expect(h).toContain(
      '<div class="tool-row" data-tid="ask:t:tu1"><span class="status ok">✓</span>',
    );
    expect(h.match(/ask-trail-thinking/g)).toHaveLength(1); // the empty (redacted) thinking block draws nothing
    expect(h).not.toContain("tool-detail");
  });

  it("opens a tool row like the feed does: detail plus its escaped output", () => {
    const h = renderTrail(slice, "ask:t", deps(["ask:t:tu1"]));
    expect(h).toContain('<div class="tool-detail"><div class="explanation">Read</div>');
    expect(h).toContain("parked &lt;since> 10-12");
  });
});

describe("the card", () => {
  const call = parseAskSessionCall(
    "Bash",
    { command: `python3 -I ${S} ask 4e4c3737 "Where?"` },
    { content: okOut, isError: false },
  )!;

  it("shows who was woken, the question and the answer while closed", () => {
    const h = renderAskCard(call, "ask:t", undefined, deps());
    expect(h).toContain('class="ask-card ask-card-answered"');
    expect(h).toContain("OpenRAMAN build plan");
    expect(h).toContain("4e4c3737 · 2026-10-12 · 41.3 s");
    expect(h).toContain("Where is the &quot;parked&quot; plan?");
    expect(h).toContain("<p>**Short answer:** the plan is parked.</p>");
    expect(h).toContain('data-tid="ask:t"');
    expect(h).not.toContain("ask-card-trail");
  });

  it("loads the slice once when opened, then draws it inside the frame", async () => {
    const req = vi.fn().mockResolvedValue({ messages: slice, truncated: false });
    const repaint = vi.fn();
    const ui = createAskSessionUi({ ...deps(["ask:t"]), req, repaint });
    expect(ui.cardHtml(call, "ask:t")).toContain("Loading the woken session's turn");
    ui.cardHtml(call, "ask:t");
    expect(req).toHaveBeenCalledTimes(1);
    expect(req).toHaveBeenCalledWith("askSession.slice", {
      sessionId: SID,
      fromByte: 100,
      toByte: 900,
    });
    await vi.waitFor(() => expect(repaint).toHaveBeenCalled());
    const h = ui.cardHtml(call, "ask:t");
    expect(h).toContain('<div class="ask-card-trail">');
    expect(h).toContain("ran Read");
    expect(h).toContain("(1 tool call)");
    expect(req).toHaveBeenCalledTimes(1);
  });

  it("does not fetch while closed, and says so when no range was recorded", () => {
    const req = vi.fn().mockResolvedValue({ messages: [] });
    const closed = createAskSessionUi({ ...deps(), req, repaint: () => {} });
    closed.cardHtml(call, "ask:t");
    expect(req).not.toHaveBeenCalled();
    const old = { ...call, range: null };
    const open = createAskSessionUi({ ...deps(["ask:t"]), req, repaint: () => {} });
    expect(open.cardHtml(old, "ask:t")).toContain("No transcript range was recorded");
    expect(req).not.toHaveBeenCalled();
  });

  it("shows the gateway's error in the frame", async () => {
    const repaint = vi.fn();
    const ui = createAskSessionUi({
      ...deps(["ask:t"]),
      req: vi.fn().mockRejectedValue(new Error("unknown method: askSession.slice")),
      repaint,
    });
    ui.cardHtml(call, "ask:t");
    await vi.waitFor(() => expect(repaint).toHaveBeenCalled());
    expect(ui.cardHtml(call, "ask:t")).toContain("unknown method: askSession.slice");
  });
});
