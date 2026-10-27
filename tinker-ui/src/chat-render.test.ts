/** @vitest-environment jsdom */
import MarkdownIt from "markdown-it";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearOrphanedViewerOpen,
  freshElements,
  graftChatNode,
  graftTimingBlocks,
  renderChatInto,
  unitElement,
  unitKeyOf,
  type ChatRenderOptions,
} from "./chat-render.js";
import { buildChatUnits, type ChatUnit, type ChatUnitDeps } from "./chat-units.js";
import { historyRowIdentity } from "./history-reconcile.js";
import { renderSectionedReply, splitSectionedReply } from "./sectioned-reply.js";

type Row = Record<string, any>;

afterEach(() => {
  document.body.innerHTML = "";
});

function pane(): HTMLElement {
  const el = document.createElement("div");
  el.id = `messages-${Math.random().toString(36).slice(2)}`;
  document.body.appendChild(el);
  return el;
}

// ─── Plain keyed rows ────────────────────────────────────────────────────────────────────────

type Plain = { id: string; text: string };
const plainOpts: ChatRenderOptions<Plain> = {
  rowKey: (r) => r.id,
  rowHtml: (r) => `<div class="msg" data-id="${r.id}">${r.text}</div>`,
};
const plainRows = (n: number): Plain[] =>
  Array.from({ length: n }, (_, k) => ({ id: `r${k + 1}`, text: `row ${k + 1}` }));
const nodeOf = (el: HTMLElement, id: string) => el.querySelector(`[data-id="${id}"]`);

describe("renderChatInto — node reuse", () => {
  it("a delta to the live bubble keeps every other row's node and repaints only the live one", () => {
    const el = pane();
    const rows = plainRows(400);
    renderChatInto(el, rows, plainOpts);
    const row10 = nodeOf(el, "r10");
    const liveBefore = nodeOf(el, "r400");
    const before = Array.from(el.children);

    rows[399] = { id: "r400", text: "row 400, still streaming…" };
    const created = renderChatInto(el, rows, plainOpts);

    expect(nodeOf(el, "r10")).toBe(row10);
    expect(created).toHaveLength(1);
    expect(nodeOf(el, "r400")).not.toBe(liveBefore);
    expect(nodeOf(el, "r400")?.textContent).toBe("row 400, still streaming…");
    const after = Array.from(el.children);
    expect(after.slice(0, 399).every((node, k) => node === before[k])).toBe(true);
  });

  it("a trim removes exactly the trimmed rows; the next row becomes first, same node", () => {
    const el = pane();
    const rows = plainRows(400);
    renderChatInto(el, rows, plainOpts);
    const trimmed = rows.slice(0, 50).map((r) => nodeOf(el, r.id));
    const row51 = nodeOf(el, "r51");

    const created = renderChatInto(el, rows.slice(50), plainOpts);

    expect(created).toHaveLength(0);
    expect(trimmed.every((node) => node !== null && node.parentNode === null)).toBe(true);
    expect(el.firstElementChild).toBe(row51);
    expect(el.children).toHaveLength(350);
  });

  it("an append adds nodes without recreating the existing ones", () => {
    const el = pane();
    const rows = plainRows(100);
    renderChatInto(el, rows, plainOpts);
    const before = Array.from(el.children);
    const created = renderChatInto(el, [...rows, ...plainRows(105).slice(100)], plainOpts);
    expect(created).toHaveLength(5);
    expect(Array.from(el.children).slice(0, 100)).toEqual(before);
  });

  it("an older page inserted on top leaves the rows below untouched", () => {
    const el = pane();
    const rows = plainRows(200);
    renderChatInto(el, rows.slice(100), plainOpts);
    const before = Array.from(el.children);
    const created = renderChatInto(el, rows, plainOpts);
    expect(created).toHaveLength(100);
    expect(Array.from(el.children).slice(100)).toEqual(before);
  });

  it("gives a repeated key its own unit instead of stealing the first one's node", () => {
    const el = pane();
    renderChatInto(
      el,
      [
        { id: "a", text: "one" },
        { id: "a", text: "two" },
      ],
      plainOpts,
    );
    expect(el.innerHTML).toBe(
      '<div class="msg" data-id="a">one</div><div class="msg" data-id="a">two</div>',
    );
  });

  it("drops what another writer put at the top level, as the innerHTML assignment did", () => {
    const el = pane();
    const rows = plainRows(3);
    renderChatInto(el, rows, plainOpts);
    el.insertBefore(document.createElement("aside"), el.children[1]);
    el.appendChild(document.createTextNode("stray"));
    renderChatInto(el, rows, plainOpts);
    expect(el.innerHTML).toBe(rows.map((r) => plainOpts.rowHtml(r, 0)).join(""));
  });

  it("re-renders a unit whose node another writer swapped out", () => {
    const el = pane();
    const rows = plainRows(3);
    renderChatInto(el, rows, plainOpts);
    const swapped = document.createElement("div");
    swapped.textContent = "replacement";
    nodeOf(el, "r2")!.replaceWith(swapped);
    const created = renderChatInto(el, rows, plainOpts);
    expect(created).toHaveLength(1);
    expect(el.innerHTML).toBe(rows.map((r) => plainOpts.rowHtml(r, 0)).join(""));
  });

  it("undoes a recorded graft before comparing, so neither unit loses or duplicates the node", () => {
    const el = pane();
    const opts: ChatRenderOptions<Plain> = {
      rowKey: (r) => r.id,
      rowHtml: (r) => `<div data-id="${r.id}"><p>${r.text}</p><span class="g">${r.id}</span></div>`,
    };
    const rows = plainRows(2);
    renderChatInto(el, rows, opts);
    const moved = el.querySelector('[data-id="r1"] .g') as HTMLElement;
    graftChatNode(el, moved, nodeOf(el, "r2")!);
    expect(nodeOf(el, "r2")!.querySelectorAll(".g")).toHaveLength(2);

    rows[1] = { id: "r2", text: "changed" };
    renderChatInto(el, rows, opts);
    expect(el.innerHTML).toBe(rows.map((r) => opts.rowHtml(r, 0)).join(""));
    expect(nodeOf(el, "r1")!.querySelector(".g")).toBe(moved);
  });
});

// FORK 2026-10-02 (chat-viewport.ts) — the scroll anchor names a row by its UNIT, because a row the
// page watched being written has no transcript id to name it by.
describe("unitKeyOf / unitElement — naming the row on screen", () => {
  it("maps a top-level node to its unit key and back, across reuse and re-parse", () => {
    const el = pane();
    renderChatInto(el, plainRows(3), plainOpts);
    const r2 = nodeOf(el, "r2")!;
    expect(unitKeyOf(r2)).toBe("r2");
    expect(unitElement(el, "r2")).toBe(r2);
    // A re-parse (changed HTML) hands the key to the new node.
    const rows = plainRows(3);
    rows[1] = { id: "r2", text: "row 2, edited" };
    renderChatInto(el, rows, plainOpts);
    const r2b = nodeOf(el, "r2")!;
    expect(r2b).not.toBe(r2);
    expect(unitKeyOf(r2b)).toBe("r2");
    expect(unitElement(el, "r2")).toBe(r2b);
  });

  it("answers null for a unit that left, and for a node no unit owns", () => {
    const el = pane();
    renderChatInto(el, plainRows(3), plainOpts);
    renderChatInto(el, plainRows(2), plainOpts);
    expect(unitElement(el, "r3")).toBeNull();
    const stray = document.createElement("div");
    el.appendChild(stray);
    expect(unitKeyOf(stray)).toBeNull();
  });

  it("names a repeated key's second unit by its suffixed key", () => {
    const el = pane();
    const twice: Plain[] = [
      { id: "r1", text: "a" },
      { id: "r1", text: "b" },
    ];
    renderChatInto(el, twice, plainOpts);
    const [first, second] = Array.from(el.children);
    expect(unitKeyOf(first)).toBe("r1");
    expect(unitKeyOf(second)).toBe("r1#2");
    expect(unitElement(el, "r1#2")).toBe(second);
  });
});

// FORK 2026-09-24 (task 9 review minor) — an inline file viewer sits at the TOP level, after its
// row. The keyed pass removes it (no unit names it) but REUSES the row, whose link keeps the
// `file-viewer-open` class — styled as open with nothing open.
describe("clearOrphanedViewerOpen", () => {
  const linkRows = [{ id: "f1", text: '<span class="sys-file-link" data-path="/x">x</span>' }];

  it("strips the class from links once the keyed pass removed the viewer", () => {
    const el = pane();
    renderChatInto(el, linkRows, plainOpts);
    const link = el.querySelector(".sys-file-link") as HTMLElement;
    link.classList.add("file-viewer-open");
    const viewer = document.createElement("div");
    viewer.className = "file-viewer-inline";
    el.querySelector('[data-id="f1"]')!.after(viewer);

    renderChatInto(el, linkRows, plainOpts); // the row is reused, the viewer removed
    expect(el.querySelector(".file-viewer-inline")).toBeNull();
    expect(el.querySelector(".sys-file-link")).toBe(link);
    // CONTROL: the reused link still claims an open viewer.
    expect(link.classList.contains("file-viewer-open")).toBe(true);
    expect(clearOrphanedViewerOpen(el)).toBe(1);
    expect(link.classList.contains("file-viewer-open")).toBe(false);
  });

  it("leaves the class alone while a viewer is on the page", () => {
    const el = pane();
    renderChatInto(el, linkRows, plainOpts);
    const link = el.querySelector(".sys-file-link") as HTMLElement;
    link.classList.add("file-viewer-open");
    const viewer = document.createElement("div");
    viewer.className = "file-viewer-inline";
    link.after(viewer); // inside the row's own subtree: kept with the reused unit
    renderChatInto(el, linkRows, plainOpts);
    expect(clearOrphanedViewerOpen(el)).toBe(0);
    expect(link.classList.contains("file-viewer-open")).toBe(true);
  });
});

// FORK 2026-09-24 (task 9 review minor) — renderChatInto parses each unit ALONE; that equals the
// whole-pane innerHTML parse only if every unit's HTML is balanced. Dev and test builds assert it.
describe("renderChatInto — the balanced-unit precondition (dev/test builds)", () => {
  const one = (html: string) => [{ id: "u1", text: html }];
  const raw: ChatRenderOptions<Plain> = { rowKey: (r) => r.id, rowHtml: (r) => r.text };

  it("rejects a unit that leaves an element, a comment or a table open", () => {
    expect(import.meta.env.DEV).toBe(true); // vitest builds are dev builds
    for (const html of [
      '<div class="msg">no close',
      "<p>para",
      "<details><summary>s</summary>",
      "<!-- open comment",
      "<table><tr><td>cell",
      '<a href="x',
    ]) {
      expect(() => renderChatInto(pane(), one(html), raw), html).toThrow(/not balanced/);
    }
  });

  it("accepts balanced markup even where the serializer rewrites it", () => {
    const md = new MarkdownIt().render(`it's a "quoted" word & more`); // &quot; and &amp; in text
    for (const html of [
      md,
      "<details open><summary>s</summary>x</details>",
      "<br/>",
      "text only",
    ]) {
      const el = pane();
      expect(() => renderChatInto(el, one(html), raw), html).not.toThrow();
    }
    // CONTROL: a literal round-trip (serialized === source) would reject all but the last, though
    // each parses the same alone as inside the whole pane.
    const scratch = document.createElement("div");
    scratch.innerHTML = md;
    expect(scratch.innerHTML === md).toBe(false);
  });
});

describe("freshElements — listeners bound once per node", () => {
  it("a reused row keeps exactly one handler across many passes", () => {
    const el = pane();
    const clicks = new Map<string, number>();
    const bind = (created: ChildNode[]) =>
      freshElements(created, "[data-id]").forEach((node) =>
        node.addEventListener("click", () => {
          const id = node.getAttribute("data-id")!;
          clicks.set(id, (clicks.get(id) ?? 0) + 1);
        }),
      );
    const rows = plainRows(5);
    bind(renderChatInto(el, rows, plainOpts));
    for (let k = 0; k < 4; k++) {
      rows[4] = { id: "r5", text: `live ${k}` };
      bind(renderChatInto(el, rows, plainOpts));
    }
    (nodeOf(el, "r2") as HTMLElement).click();
    (nodeOf(el, "r5") as HTMLElement).click();
    expect(clicks.get("r2")).toBe(1);
    expect(clicks.get("r5")).toBe(1);
  });

  it("finds matches on the created node itself and inside it", () => {
    const el = pane();
    const created = renderChatInto(
      el,
      [{ id: "x", text: '<span data-tid="t1"></span>' }],
      plainOpts,
    );
    expect(freshElements(created, "[data-id],[data-tid]").map((n) => n.tagName)).toEqual([
      "DIV",
      "SPAN",
    ]);
  });
});

// ─── DOM parity against the full rebuild, with the real run builder ──────────────────────────

const mdParser = new MarkdownIt({ html: false, linkify: true, breaks: true });
const md = (t: string) => mdParser.render(t);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ocAttrs = (msg: Row, part: string) => {
  const id = historyRowIdentity(msg);
  return id ? ` data-oc-id="${esc(id)}" data-oc-part="${part}"` : "";
};
const textOf = (msg: Row): string =>
  typeof msg.content === "string"
    ? msg.content
    : ((msg.content ?? []) as Row[])
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n");

/**
 * The markup shapes the real app.ts renderMsg emits (user bubble with its position, answer with
 * elapsed chip, thinking label, tool rows paired across rows, expanded tool detail, system rows,
 * a 🌿 fractal <details>, a sectioned reply through the real renderSectionedReply, the phase
 * timing block, html-render cards), so parsing and nesting are exercised as in the app.
 */
function makeRenderMsg(expanded: Set<string>): ChatUnitDeps["renderMsg"] {
  return (raw, idx, isThinking, results, names, structured) => {
    const msg = raw as Row;
    const key = typeof msg._uid === "string" ? msg._uid : `i${idx}`;
    const role = String(msg.role ?? "").toLowerCase();
    const text = textOf(msg);
    if (msg._isPhaseTiming) {
      return `<div class="msg-phase-group"${ocAttrs(msg, "timing")}><div class="msg-phase-timing" data-tid="p${key}">⏱ ${esc(text)} <span class="mpt-info">ⓘ</span></div></div>`;
    }
    if (role === "user") {
      const blocks = Array.isArray(msg.content) ? (msg.content as Row[]) : [];
      if (blocks.length > 0 && blocks.every((b) => b.type === "tool_result")) {
        return "";
      }
      const queued = msg._queued ? ` msg-queued` : "";
      return `<div class="msg user${queued}" data-msg-idx="${idx}" data-timestamp="12:00:0${idx % 10}">${md(text)}</div>`;
    }
    if (role !== "assistant") {
      return `<div class="msg system" data-tid="s${key}">▸ ${esc(text.slice(0, 40))}</div>`;
    }
    if (msg._isReasoning) {
      return text.trim()
        ? `<div class="msg assistant msg-thinking"${ocAttrs(msg, "thinking")}><span class="thinking-label">Thinking:</span> ${md(text)}</div>`
        : "";
    }
    // The real chip is the gap to the preceding prompt, so it does not move when rows shift.
    const chip = `<span class="msg-elapsed">+${key.length}s</span>`;
    const sectioned = splitSectionedReply(text);
    if (sectioned && (sectioned.answer || sectioned.fractal)) {
      return renderSectionedReply(
        sectioned,
        chip,
        md,
        esc,
        "",
        (k) => (k ? ` data-fold-key="${esc(k)}"` : ""),
        key,
      );
    }
    let h = "";
    for (const b of Array.isArray(msg.content) ? (msg.content as Row[]) : []) {
      if (b.type === "text" && String(b.text ?? "").trim()) {
        const prefix = isThinking ? `<span class="thinking-label">Thinking:</span> ` : "";
        const card = /\bcard\b/.test(b.text)
          ? `<div class="chat-html-inline"><table><tr><td>${esc(b.text)}</td></tr></table></div>`
          : "";
        h += `<div class="msg assistant${isThinking ? " msg-thinking" : ""}${structured ? " structured" : ""}"${ocAttrs(msg, "main")}>${prefix}${md(b.text)}${card}${chip}</div>`;
      } else if (b.type === "tool_use") {
        const tid = `t${key}-${b.id}`;
        const paired = results.get(b.id ?? "");
        const icon = paired ? (paired.isError ? "✗" : "✓") : "⋯";
        h += `<div class="tool-row" data-tid="${tid}"><span class="status">${icon}</span><span class="detail">${esc(String(b.name))}</span></div>`;
        if (expanded.has(tid)) {
          h += `<div class="tool-detail"><div class="code-block">${esc(paired?.content ?? "")}</div></div>`;
        }
      } else if (b.type === "tool_result" && !names.has(b.tool_use_id ?? "")) {
        h += `<div class="tool-row" data-tid="r${key}"><span class="detail">orphan</span></div>`;
      }
    }
    if (typeof msg.content === "string" && msg.content.trim()) {
      if (text.trimStart().startsWith("🌿 FRACTAL")) {
        h += `<details class="fractal-details" data-fractal-uid="${esc(key)}"><summary class="fractal-summary">🌿 Fractal</summary><div class="msg assistant msg-fractal">${md(text)}</div></details>`;
      } else {
        h += `<div class="msg assistant"${ocAttrs(msg, "main")}>${md(text)}</div>`;
      }
    }
    return h;
  };
}

type World = {
  rows: Row[];
  expanded: Set<string>;
  streamRunId: string | null;
  streamMsgUid: string | null;
  indicator: boolean;
  queued: Row[];
};

function unitsOf(w: World): ChatUnit[] {
  return buildChatUnits(w.rows, {
    renderMsg: makeRenderMsg(w.expanded),
    extractUserText: (m) => {
      const t = textOf(m as Row).trim();
      return t && !t.startsWith("OpenClaw runtime context") ? t : null;
    },
    expandedTools: w.expanded,
    streamRunId: w.streamRunId,
    streamMsgUid: w.streamMsgUid,
    esc,
    skillNoticesHtmlAfter: (view, i) =>
      textOf(view[i] as Row).includes("skill")
        ? `<div class="msg-skill-notice">🔧 skill</div>`
        : "",
    renderThinkingIndicator: () =>
      w.indicator
        ? `<div class="thinking-indicator"><div class="thinking-run"><div class="thinking-dots"><span></span><span></span><span></span></div><span class="thinking-elapsed">3s</span></div></div>`
        : "",
    queuedRows: () => w.queued,
  });
}

const keyed: ChatRenderOptions<ChatUnit> = { rowKey: (u) => u.key, rowHtml: (u) => u.html };

/** Two panes, one per sink; every frame must leave them byte-identical. */
function parityRig() {
  const full = pane();
  const kept = pane();
  let frames = 0;
  let created = 0;
  let units = 0;
  return {
    kept,
    frame(w: World): ChildNode[] {
      const us = unitsOf(w);
      full.innerHTML = us.map((u) => u.html).join("");
      graftTimingBlocks(full);
      const fresh = renderChatInto(kept, us, keyed);
      graftTimingBlocks(kept);
      expect(kept.innerHTML).toBe(full.innerHTML);
      frames++;
      created += fresh.length;
      units += us.length;
      return fresh;
    },
    stats: () => ({ frames, created, units }),
  };
}

let serial = 0;
const oc = (row: Row): Row => ({ ...row, __openclaw: { id: `x${++serial}` } });
const u = (text: string): Row =>
  oc({ role: "user", _uid: `m${++serial}`, content: [{ type: "text", text }] });
const a = (text: string, extra: Row = {}): Row =>
  oc({ role: "assistant", _uid: `m${++serial}`, content: [{ type: "text", text }], ...extra });
const call = (id: string, narration: string): Row =>
  oc({
    role: "assistant",
    _uid: `m${++serial}`,
    content: [
      { type: "text", text: narration },
      { type: "tool_use", id, name: "exec", input: {} },
    ],
  });
const res = (id: string, isError = false): Row =>
  oc({
    role: "user",
    _uid: `m${++serial}`,
    content: [{ type: "tool_result", tool_use_id: id, content: `out ${id}`, is_error: isError }],
  });
const LONG = "The answer, in full: ".padEnd(160, "x");
const turn = (n: number): Row[] => [
  u(`prompt ${n}, use the skill`),
  call(`c${n}a`, `checking thing ${n}`),
  res(`c${n}a`),
  call(`c${n}b`, `and the other ${n}`),
  res(`c${n}b`, n % 3 === 0),
  a(`${LONG} **${n}**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two`),
];
const world = (rows: Row[]): World => ({
  rows,
  expanded: new Set(),
  streamRunId: null,
  streamMsgUid: null,
  indicator: false,
  queued: [],
});

describe("renderChatInto — DOM parity with the full innerHTML rebuild", () => {
  it("plain turns, then an appended turn", () => {
    const rig = parityRig();
    const w = world([...turn(1), ...turn(2), ...turn(3)]);
    rig.frame(w);
    const before = Array.from(rig.kept.childNodes);
    w.rows.push(...turn(4));
    const fresh = rig.frame(w);
    expect(before.every((node) => node.parentNode === rig.kept)).toBe(true);
    expect(fresh.every((node) => !before.includes(node))).toBe(true);
  });

  it("a live streaming run: deltas, a tool call, the result, the final collapse", () => {
    const rig = parityRig();
    const w = world([...turn(1), ...turn(2)]);
    rig.frame(w);
    const prompt = { role: "user", _uid: "live-p", content: [{ type: "text", text: "go" }] };
    const bubble: Row = {
      role: "assistant",
      _uid: "live-b",
      _temporary: true,
      content: [{ type: "text", text: "" }],
    };
    w.rows.push(prompt, bubble);
    Object.assign(w, { streamRunId: "run-1", streamMsgUid: "live-b", indicator: true });
    rig.frame(w);
    const settled = rig.kept.querySelector("[data-oc-id]");
    for (const piece of ["Let me", " look", " at the", " logs."]) {
      bubble.content[0].text += piece;
      const fresh = rig.frame(w);
      expect(fresh).toHaveLength(1);
      expect(rig.kept.querySelector("[data-oc-id]")).toBe(settled);
    }
    w.rows.push(
      {
        role: "assistant",
        _uid: "live-t",
        _temporary: true,
        content: [{ type: "tool_use", id: "L1", name: "exec", input: {} }],
      },
      {
        role: "user",
        _uid: "live-r",
        content: [{ type: "tool_result", tool_use_id: "L1", content: "done" }],
      },
    );
    rig.frame(w);
    const answer: Row = {
      role: "assistant",
      _uid: "live-a",
      _temporary: true,
      content: [{ type: "text", text: "" }],
    };
    w.rows.push(answer);
    w.streamMsgUid = "live-a";
    for (const piece of ["Found", " it: the", " cache was", " stale. ".padEnd(200, "y")]) {
      answer.content[0].text += piece;
      rig.frame(w);
    }
    for (const r of w.rows) delete r._temporary;
    Object.assign(w, { streamRunId: null, streamMsgUid: null, indicator: false });
    rig.frame(w);
    expect(rig.kept.querySelectorAll(".reasoning-group").length).toBe(3);
  });

  it("a finished run's group opened and closed, and a tool row expanded", () => {
    const rig = parityRig();
    const w = world([...turn(1), ...turn(2)]);
    rig.frame(w);
    const gid = rig.kept.querySelector(".reasoning-header")!.getAttribute("data-tid")!;
    w.expanded.add(gid);
    rig.frame(w);
    const tid = rig.kept.querySelector(".tool-row")!.getAttribute("data-tid")!;
    w.expanded.add(tid);
    rig.frame(w);
    w.expanded.delete(gid);
    rig.frame(w);
  });

  it("thinking bubbles and the answer split, native reasoning included", () => {
    const rig = parityRig();
    const w = world([
      u("think first"),
      a("weighing the options", { _isReasoning: true }),
      call("k1", "reading the config"),
      res("k1"),
      a("more weighing", { _isReasoning: true }),
      a(`${LONG} with a card inside`),
      a("💬 ANSWER: sectioned answer body\n🌿 FRACTAL: a lesson with **bold**"),
    ]);
    rig.frame(w);
    w.rows.push(u("again"), a("", { _isReasoning: true }), a("short"));
    rig.frame(w);
  });

  it("client-only rows: notes, warnings, timing, queued prompts, the indicator", () => {
    const rig = parityRig();
    const w = world([...turn(1)]);
    w.rows.push(
      {
        role: "assistant",
        _uid: "note-1",
        _isPhaseTiming: true,
        content: [{ type: "text", text: "context 1.2s" }],
      },
      {
        role: "assistant",
        _uid: "warn-1",
        _isWarning: true,
        content: [{ type: "text", text: "⚠️ fallback" }],
      },
      {
        role: "user",
        _uid: "rt-1",
        content: [{ type: "text", text: "OpenClaw runtime context (internal): x" }],
      },
      { role: "system", _uid: "sys-1", content: "system note" },
    );
    rig.frame(w);
    w.queued = [{ role: "user", _queued: true, content: [{ type: "text", text: "next one" }] }];
    w.indicator = true;
    rig.frame(w);
    w.queued = [];
    rig.frame(w);
  });

  it("an older page inserted at the top, then a trim of the top rows", () => {
    const rig = parityRig();
    const older = [...turn(1), ...turn(2), ...turn(3)];
    const newer = [...turn(4), ...turn(5), ...turn(6)];
    const w = world([...newer]);
    rig.frame(w);
    const lastAnswer = rig.kept.lastElementChild;
    w.rows = [...older, ...newer];
    rig.frame(w);
    expect(rig.kept.lastElementChild).toBe(lastAnswer);
    w.rows = w.rows.slice(12);
    rig.frame(w);
    expect(rig.kept.lastElementChild).toBe(lastAnswer);
  });

  it("a reset merge: new row objects for the same identities, one of them rewritten", () => {
    const rig = parityRig();
    const w = world([...turn(1), ...turn(2)]);
    rig.frame(w);
    const tool = rig.kept.querySelector(".reasoning-group");
    w.rows = w.rows.map((r) => structuredClone(r));
    const fresh = rig.frame(w);
    expect(fresh).toHaveLength(0);
    expect(rig.kept.querySelector(".reasoning-group")).toBe(tool);
    w.rows[5] = { ...w.rows[5], content: [{ type: "text", text: `${LONG} (rewritten)` }] };
    rig.frame(w);
  });

  it("a reflection's timing block grafted into its 🌿 section survives every re-render", () => {
    const rig = parityRig();
    const w = world([
      ...turn(1),
      // Tagged by runId in the main run: grafted into the NEXT 🌿 section, a later reply's.
      {
        role: "assistant",
        _uid: "tm-1",
        _isPhaseTiming: true,
        _fractalPass: true,
        content: [{ type: "text", text: "reflect 0.8s" }],
      },
      u("second prompt"),
      call("g1", "checking the graft"),
      res("g1"),
      a(`💬 ANSWER: ${LONG}\n🌿 FRACTAL: lesson one`),
      // Closed by a 🌿 bubble: tagged with that bubble's uid, which sectioned markup does not
      // carry, so it stays in place, marked unnested.
      {
        role: "assistant",
        _uid: "tm-2",
        _isPhaseTiming: true,
        content: [{ type: "text", text: "reflect 0.5s" }],
      },
      oc({ role: "assistant", _uid: "fr-2", content: "🌿 FRACTAL: lesson two" }),
    ]);
    rig.frame(w);
    expect(rig.kept.querySelectorAll("details.fractal-details .mpg-graft")).toHaveLength(1);
    expect(rig.kept.querySelectorAll(".mpg-graft.is-unnested")).toHaveLength(1);
    // The destination section re-renders; the origin group is reused.
    w.rows[10].content[0].text = `💬 ANSWER: ${LONG}\n🌿 FRACTAL: lesson one, revised`;
    rig.frame(w);
    // The origin group re-renders; the destination is reused.
    w.rows[6].content[0].text = "reflect 0.9s";
    rig.frame(w);
    w.rows.push(u("more"));
    rig.frame(w);
    expect(rig.kept.querySelectorAll("details.fractal-details .mpg-graft")).toHaveLength(1);
    expect(rig.kept.querySelectorAll(".mpg-graft")).toHaveLength(2);
  });

  it("randomised sequences of appends, deltas, older pages, trims, resets and toggles", () => {
    let seed = 20260923;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    let totalFrames = 0;
    for (let s = 0; s < 60; s++) {
      const rig = parityRig();
      const w = world([...turn(serial)]);
      let live: Row | null = null;
      for (let step = 0; step < 14; step++) {
        const op = pick([
          "append",
          "stream",
          "delta",
          "tool",
          "final",
          "older",
          "trim",
          "reset",
          "edit",
          "toggle",
          "queue",
          "reflect",
        ]);
        if (op === "append") w.rows.push(...turn(serial));
        if (op === "stream" && !live) {
          live = {
            role: "assistant",
            _uid: `lv${++serial}`,
            _temporary: true,
            content: [{ type: "text", text: "…" }],
          };
          w.rows.push(
            { role: "user", _uid: `lp${serial}`, content: [{ type: "text", text: "live prompt" }] },
            live,
          );
          Object.assign(w, { streamRunId: "run", streamMsgUid: live._uid, indicator: true });
        }
        if (op === "delta" && live) live.content[0].text += ` word${step}`;
        if (op === "tool" && live) {
          const id = `lt${++serial}`;
          w.rows.push(
            {
              role: "assistant",
              _uid: `lu${serial}`,
              _temporary: true,
              content: [{ type: "tool_use", id, name: "read", input: {} }],
            },
            {
              role: "user",
              _uid: `lr${serial}`,
              content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
            },
          );
        }
        if (op === "final") {
          for (const r of w.rows) delete r._temporary;
          live = null;
          Object.assign(w, { streamRunId: null, streamMsgUid: null, indicator: false });
        }
        if (op === "older") w.rows.unshift(...turn(serial), ...turn(serial));
        if (op === "trim") w.rows.splice(0, Math.floor(rnd() * Math.min(8, w.rows.length)));
        if (op === "reset") w.rows = w.rows.map((r) => (r === live ? r : structuredClone(r)));
        if (op === "edit" && w.rows.length) {
          const r = pick(w.rows);
          if (Array.isArray(r.content) && r.content[0]?.type === "text")
            r.content[0].text += " (edited)";
        }
        if (op === "toggle") {
          const ids = Array.from(rig.kept.querySelectorAll("[data-tid]")).map(
            (n) => n.getAttribute("data-tid")!,
          );
          if (ids.length) {
            const id = pick(ids);
            if (w.expanded.has(id)) w.expanded.delete(id);
            else w.expanded.add(id);
          }
        }
        if (op === "queue")
          w.queued = w.queued.length
            ? []
            : [{ role: "user", _queued: true, content: [{ type: "text", text: "queued" }] }];
        if (op === "reflect") {
          // One block that moves (tagged mid-run, lands in the next reply's 🌿 section) and one
          // closed by a 🌿 bubble, which stays put.
          w.rows.push(
            {
              role: "assistant",
              _uid: `tr${++serial}`,
              _isPhaseTiming: true,
              _fractalPass: true,
              content: [{ type: "text", text: "reflect" }],
            },
            u("after the reflection"),
            a(`💬 ANSWER: ${LONG}\n🌿 FRACTAL: noted ${serial}`),
            {
              role: "assistant",
              _uid: `tq${++serial}`,
              _isPhaseTiming: true,
              content: [{ type: "text", text: "reflect" }],
            },
            oc({ role: "assistant", _uid: `fx${serial}`, content: "🌿 FRACTAL: noted" }),
          );
        }
        rig.frame(w);
        totalFrames++;
      }
    }
    expect(totalFrames).toBe(60 * 14);
  });
});
