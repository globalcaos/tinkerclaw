/**
 * Drives the built tinker-ui against mock-gateway.mjs (same folder) through the ADVICE LINE contract (Broca retrieval v2,
 * phase E, FORK 2026-10-06): one compact line under the prompt it belongs to, `Use: … · Inspiration: … (§ section) · source:
 * Jev|local`, drawn through the existing chip row, and NOTHING else in the chat.
 *
 *   A1  after load, the two prompts whose stored turn carries a `<recipe_advice>` tag each have the line, under them
 *   A2  no line under a plain prompt, under a runtime notice, or under the live prompt before its event
 *   A3  the line is not a message: not a `.msg`, no fill, no border, 11 px muted text, inside the column
 *   A4  the stored tag is not painted in the bubble the owner reads (it sits in the collapsed "appended by the system" fold)
 *   A5  a live trail event stamps the line on the LAST prompt only; the number of user bubbles and of `.msg` rows is unchanged
 *   A6  an event for another session draws nothing here
 *   A7  the page sent no `chat.send` (the line is not a prompt) and no other write
 *   A8  after a reload the stored lines come back and nothing else changes
 *
 * `--mode control` runs the same page against a build WITHOUT the feature (develop) and asserts the absence instead: no line
 * is drawn, live or stored. It also prints what such a build paints for the stored tag.
 *
 * Usage: node drive.mjs --url http://127.0.0.1:18997 --out /tmp/advice-e2e [--mode new|control]
 * Exit code 1 when an assertion fails.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const URL_ = args.url ?? "http://127.0.0.1:18997";
const OUT = args.out ?? "/tmp/advice-e2e";
const CONTROL = args.mode === "control";
mkdirSync(OUT, { recursive: true });

const LINE_JEV =
  "Use: plan-family-trip, flight-scan · Inspiration: review-site (§ Build the page) · source: Jev";
const LINE_LOCAL = "Use: acme-coding · source: local";
const LINE_LIVE = "Use: torrent-scout · Inspiration: flight-scan (§ Compare prices) · source: Jev";

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(what);
};
const post = (path, body) =>
  fetch(`${URL_}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

/** Every user prompt, in order, with the advice lines that follow it before the next prompt. */
const snapshot = () =>
  page.evaluate(() => {
    const host = document.getElementById("messages");
    const out = [];
    let cur = null;
    for (const el of host ? [...host.children] : []) {
      if (el.matches(".msg.user")) {
        cur = {
          text: (el.querySelector(":scope > p")?.textContent ?? el.textContent ?? "").trim(),
          visible: el.innerText,
          lines: [],
          chips: 0,
        };
        out.push(cur);
      } else if (cur && el.matches(".msg-advice-line")) {
        cur.lines.push(el.textContent.trim());
      } else if (
        cur &&
        el.matches(
          "[class*=msg-recipe-notice], [class*=msg-skill-notice], [class*=msg-plugin-notice]",
        )
      ) {
        cur.chips++;
      } else if (el.matches(".msg.user, .turn-seg, .turn-rail-cap")) {
        // a reply starts: lines after this belong to no prompt row
      }
    }
    return {
      prompts: out,
      userBubbles: host?.querySelectorAll(".msg.user").length ?? 0,
      msgRows: host?.querySelectorAll(".msg").length ?? 0,
      lineCount: host?.querySelectorAll(".msg-advice-line").length ?? 0,
    };
  });

const boot = async () => {
  await page.waitForFunction(
    () => document.querySelectorAll("#messages .msg.user").length >= 5,
    null,
    {
      timeout: 20000,
    },
  );
  await page.waitForTimeout(1500);
};
const shoot = async (name) => {
  const msgs = page.locator("#messages");
  // the chat opens scrolled to the newest turn: take the bottom as it is, then the top, both at native size
  await msgs.screenshot({ path: `${OUT}/${name}-bottom.png` });
  await page.evaluate(() => {
    document.getElementById("messages").scrollTop = 0;
  });
  await page.waitForTimeout(300);
  await msgs.screenshot({ path: `${OUT}/${name}-top.png` });
  await page.evaluate(() => {
    const m = document.getElementById("messages");
    m.scrollTop = m.scrollHeight;
  });
  await page.waitForTimeout(300);
};

await page.goto(`${URL_}/tinker/`, { waitUntil: "load" });
await boot();
let s = await snapshot();
await shoot(CONTROL ? "control-stored" : "new-stored");

if (CONTROL) {
  check(
    s.lineCount === 0,
    "C1. no advice line is drawn for the stored tags",
    `lines=${s.lineCount}`,
  );
  console.log("INFO  what the build without the feature paints for the stored tag, prompt 1:");
  console.log("      " + JSON.stringify(s.prompts[0]?.visible));
  await post("/__mock/advice", { line: LINE_LIVE });
  await page.waitForTimeout(800);
  s = await snapshot();
  check(s.lineCount === 0, "C2. a live advice event draws nothing", `lines=${s.lineCount}`);
  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "));
  await shoot("control-live");
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
  process.exit(failures.length ? 1 : 0);
}

const [p1, p2, p3, p4, p5] = s.prompts;
check(s.userBubbles === 5, "0. five user prompts are on screen", `n=${s.userBubbles}`);
check(
  p1?.lines.length === 1 && p1.lines[0] === LINE_JEV,
  "A1a. the Jev line is under the first prompt, exactly",
  JSON.stringify(p1?.lines),
);
check(
  p3?.lines.length === 1 && p3.lines[0] === LINE_LOCAL,
  "A1b. the local line is under the third prompt, after its recipe chip",
  JSON.stringify(p3?.lines),
);
check(
  p3?.chips === 1,
  "A1c. the recipe chip under the third prompt is still drawn once",
  `chips=${p3?.chips}`,
);
check(
  p2?.lines.length === 0 && p4?.lines.length === 0 && p5?.lines.length === 0,
  "A2. no line under a plain prompt, a runtime notice, or the live prompt before its event",
  `p2=${p2?.lines.length} p4=${p4?.lines.length} p5=${p5?.lines.length}`,
);
check(s.lineCount === 2, "A2b. exactly two lines in the whole chat", `lines=${s.lineCount}`);

// A3 ─ it must not look like a message.
const look = await page.evaluate(() => {
  const el = document.querySelector("#messages .msg-advice-line");
  if (!el) return null;
  const cs = getComputedStyle(el);
  const col = document.getElementById("messages").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight);
  return {
    isMsg: el.classList.contains("msg") || el.classList.contains("user"),
    bg: cs.backgroundColor,
    border: ["Top", "Right", "Bottom", "Left"].map((d) => cs[`border${d}Width`]).join("/"),
    font: cs.fontSize,
    color: cs.color,
    withinColumn: r.left >= col.left - 1 && r.right <= col.right + 1,
    lines: Math.round(r.height / lh),
    cursor: cs.cursor,
    interactive: el.querySelectorAll("a, button, input, textarea, [onclick], .fs-link").length,
  };
});
console.log("INFO  advice line style:", JSON.stringify(look));
check(
  look &&
    !look.isMsg &&
    /rgba\(0, 0, 0, 0\)|transparent/.test(look.bg) &&
    /^0px(\/0px){3}$/.test(look.border),
  "A3a. it is not a message: not a .msg, no fill, no border",
  `bg=${look?.bg} border=${look?.border}`,
);
check(
  look?.font === "11px" && look.withinColumn && look.lines <= 2 && look.interactive === 0,
  "A3b. 11 px, inside the column, at most two lines, nothing to click",
  JSON.stringify(look),
);
const alpha = Number(
  /rgba?\([^)]*?,\s*[^,]*?,\s*[^,]*?(?:,\s*([\d.]+))?\)/.exec(look?.color ?? "")?.[1] ?? 1,
);
check(alpha < 0.8, "A3c. the text is muted next to the chat text", `color=${look?.color}`);

// A4 ─ the stored tag is not in the visible bubble.
const bubble1 = await page.evaluate(() => {
  const el = document.querySelector("#messages .msg.user");
  const full = el.querySelector(".user-prompt-full");
  const clone = el.cloneNode(true);
  clone.querySelector(".user-prompt-toggle")?.remove();
  return {
    visibleText: clone.textContent.trim(),
    foldOpen: full ? full.closest("details")?.open : null,
  };
});
check(
  !/recipe_advice/.test(bubble1.visibleText) && bubble1.foldOpen === false,
  "A4. the owner's bubble shows only what was typed; the tag is behind the closed fold",
  JSON.stringify(bubble1),
);

// A5 ─ live event stamps the last prompt only.
const before = await snapshot();
await post("/__mock/advice", { line: LINE_LIVE });
await page.waitForTimeout(800);
const after = await snapshot();
await shoot("new-live");
check(
  after.prompts[4]?.lines.length === 1 && after.prompts[4].lines[0] === LINE_LIVE,
  "A5a. the live event draws its line under the last prompt",
  JSON.stringify(after.prompts[4]?.lines),
);
check(
  after.prompts[0].lines.length === 1 &&
    after.prompts[2].lines.length === 1 &&
    after.lineCount === 3,
  "A5b. nothing else gained or lost a line",
  `lines=${after.lineCount}`,
);
check(
  after.userBubbles === before.userBubbles && after.msgRows === before.msgRows,
  "A5c. no new user bubble and no new message row",
  `bubbles ${before.userBubbles}->${after.userBubbles}, rows ${before.msgRows}->${after.msgRows}`,
);

// A6 ─ another session's event draws nothing here.
await post("/__mock/advice", {
  line: "Use: intruder · source: Jev",
  sessionKey: "agent:main:tinker:someoneelse",
});
await page.waitForTimeout(600);
const foreign = await snapshot();
check(
  foreign.lineCount === 3 && !JSON.stringify(foreign).includes("intruder"),
  "A6. an advice event for another session draws nothing",
  `lines=${foreign.lineCount}`,
);

// A7 ─ the page sent nothing that writes.
const frames = JSON.parse(await fetch(`${URL_}/__mock/frames`).then((r) => r.text()));
check(
  !frames.includes("chat.send") && !frames.some((m) => /send|abort|inject/.test(m)),
  "A7. the page sent no chat.send and no other write",
  frames.join(","),
);

// A8 ─ reload: stored lines return, the live one (never stored by this mock) does not.
await page.reload({ waitUntil: "load" });
await boot();
const re = await snapshot();
await shoot("new-reloaded");
check(
  re.lineCount === 2 &&
    re.prompts[0].lines[0] === LINE_JEV &&
    re.prompts[2].lines[0] === LINE_LOCAL,
  "A8. after a reload the stored lines are back, each under its own prompt",
  JSON.stringify(re.prompts.map((p) => p.lines.length)),
);

check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
