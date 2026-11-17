// FORK 2026-11-14 — burn review (b1113-c-app-3 F2, b1113-c-app-4 F3, b1113-c-app-6 F3 + F5).
//
// THE DEFECT. The chat page builds HTML strings from model, tool, cron and skill text and writes them
// with innerHTML. Four holes let that text become markup:
//   1. app.ts `esc()` escaped & < > only, yet feeds dozens of double-quoted attributes
//      (the thinking indicator's `title="${esc(task)}"`, error `data-hint`, …). A quote in a tool
//      title ended the attribute and the rest became live attributes such as `onmouseover`.
//   2. `altEsc()` (the sidebar tabs) had the same gap: a cron job name lands in `data-name="…"`.
//   3. `toolExpandedDetail()` wrote the Read/Edit/Write file path, `offset`/`limit` and `timeout`
//      raw, so a file named `<img src=x onerror=…>` ran script when its row was expanded.
//   4. The Skills tab wrote a SKILL.md `emoji` raw (and the Agents tab an agent emoji).
//
// app.ts is a browser entry with no harness, so this file lifts the real functions out of the source
// (types stripped from the signature only) and runs them against jsdom.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = ["tinker-ui/src", "src"]
  .map((p) => join(process.cwd(), p))
  .find((p) => existsSync(join(p, "app.ts")));
if (!srcRoot) {
  throw new Error(`tinker-ui/src not found from ${process.cwd()}`);
}
const APP = readFileSync(join(srcRoot, "app.ts"), "utf8");

/** The source of a function from its signature line to the closing brace at the same indent. */
function liftFn(signature: string, indent = ""): string {
  const start = APP.indexOf(signature);
  if (start < 0) {
    throw new Error(`not found in app.ts: ${signature}`);
  }
  const close = `\n${indent}}\n`;
  return APP.slice(start, APP.indexOf(close, start) + close.length);
}

function stripSig(js: string): string {
  return js.replace(/\((\w+): \w+(?:, (\w+): \w+)?\)(?:: \w+)? \{/, (_m, a, b) =>
    b ? `(${a}, ${b}) {` : `(${a}) {`,
  );
}

const esc = new Function(`${stripSig(liftFn("function esc(s: string)"))}\nreturn esc;`)() as (
  s: string,
) => string;
const altEsc = new Function(
  `${stripSig(liftFn("function altEsc(s: unknown): string {", "  "))}\nreturn altEsc;`,
)() as (s: unknown) => string;
const toolExpandedDetail = new Function(
  [
    stripSig(liftFn("function esc(s: string)")),
    stripSig(liftFn("function shortenPath(s: string): string {")),
    stripSig(liftFn("function toolExpandedDetail(name: string, input: unknown): string {")),
    "return toolExpandedDetail;",
  ].join("\n"),
)() as (name: string, input: unknown) => string;

function parse(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe("esc() — safe inside double-quoted attributes (thinking indicator, error hint)", () => {
  it("a tool title with quotes cannot add an event handler to the thinking label", () => {
    const task = 'Where does "x onmouseover=alert(1) y" appear in the code';
    const host = parse(`<span class="thinking-task" title="${esc(task)}">${esc(task)}</span>`);
    const span = host.firstElementChild as HTMLElement;
    expect(span.getAttributeNames().sort()).toEqual(["class", "title"]);
    expect(span.getAttribute("title")).toBe(task);
    expect(span.textContent).toBe(task);
  });

  it("a single quote is neutralised too", () => {
    expect(esc(`it's "x"`)).toBe("it&#39;s &quot;x&quot;");
  });
});

describe("altEsc() — safe inside double-quoted attributes (cron job name, …)", () => {
  const hostile = 'Daily digest" style="position:fixed;inset:0" onmouseover="window.__pwned=1';

  it("a cron name cannot add attributes to the Remove span", () => {
    const host = parse(
      `<span class="alt-cron-del" data-id="x" data-name="${altEsc(hostile)}">Remove</span>`,
    );
    const span = host.querySelector(".alt-cron-del") as HTMLElement;
    expect(span.getAttributeNames().sort()).toEqual(["class", "data-id", "data-name"]);
    expect(span.dataset.name).toBe(hostile);
  });

  it("a benign quoted name round-trips intact", () => {
    const host = parse(`<span data-name="${altEsc('Check "urgent" mail')}"></span>`);
    expect((host.firstElementChild as HTMLElement).dataset.name).toBe('Check "urgent" mail');
  });

  it("null still gives an empty string", () => {
    expect(altEsc(null)).toBe("");
  });
});

describe("toolExpandedDetail() — every tool-input value is text, never markup", () => {
  const evil = "/tmp/<img src=x onerror=window.__pwned=1>.md";

  for (const [name, input] of [
    ["Read", { file_path: evil }],
    ["Edit", { file_path: evil, old_string: "a", new_string: "b" }],
    ["Write", { file_path: evil, content: "hi" }],
    ["Read", { file_path: "/tmp/a.md", offset: "<img src=x onerror=1>", limit: 2 }],
    ["process", { action: "poll", sessionId: "s", timeout: "<img src=x onerror=1>" }],
  ] as const) {
    it(`${name} ${Object.keys(input).join("+")}: no element is created from the input`, () => {
      const host = parse(toolExpandedDetail(name, input));
      expect(host.querySelector("img")).toBeNull();
    });
  }

  it("the path still reads as the path", () => {
    const host = parse(toolExpandedDetail("Read", { file_path: evil }));
    expect(host.textContent).toContain(evil);
  });
});

describe("Skills and Agents tabs escape the emoji (source check)", () => {
  const code = APP.replace(/\/\/.*$/gm, "");
  const slice = (from: string, to: string) => {
    const s = code.indexOf(from);
    expect(s).toBeGreaterThan(-1);
    return code.slice(s, code.indexOf(to, s));
  };

  it("Skills tab: SKILL.md emoji goes through altEsc", () => {
    const body = slice("async function renderSkillsTab(", "async function renderNodesTab(");
    expect(body).not.toMatch(/\$\{s\.emoji \? s\.emoji/);
    expect(body).toContain("altEsc(s.emoji)");
  });

  it("Agents tab: agent emoji goes through altEsc", () => {
    const body = slice("async function renderAgentsTab(", "async function renderSkillsTab(");
    expect(body).not.toContain("${a.emoji}");
    expect(body).toContain("altEsc(a.emoji)");
  });
});
