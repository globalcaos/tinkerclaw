/**
 * Drives the built tinker-ui against mock-gateway.mjs through the chat viewport's whole contract (tinker-ui.md §5.20,
 * chat-viewport.ts) in a real browser, where scroll positions have a layout to be measured against. jsdom has none.
 *
 *   1. A tab left following opens at its bottom, after its slow images have grown.
 *   2. Reading history in tab A, then switching to tab B, opens B at ITS bottom — the 2026-10-02 report: B used to
 *      open at A's pixel offset, in the middle of its conversation.
 *   3. Coming back to A finds the row it was reading, at the same offset.
 *   4. A reload finds that row again (ui-state's copy).
 *   5. Scrolling up and back down to an unchanged bottom re-arms follow, so rows that arrive while the tab is away
 *      are shown when it comes back.
 *   6. A tab whose session never goes quiet still gets its history after a reload.
 *   7-8. Scrolling up pages a reset session's archives in, even with an empty live transcript.
 *   9. A tab's earlier COPY pages in only its rows older than the page (the floor), under its own label; an empty
 *      reply draws no divider (2026-10-03).
 *  10. A tab whose session is reset every turn (the parallel worker), left while two turns run, the second still
 *      running when it comes back: the turn it never saw comes back between the rows around it, and the running
 *      turn's rows too, with no scrolling (2026-10-03, 4th report).
 *  11. A reload while reading below closed "▸ Commentary" folds comes back to the row on screen: a fold's
 *      stamped body still reports a box in Chromium while hidden, so it must never be the anchor (2026-10-03).
 *  12. An answer that streams after a thought, for longer than the watched slack, on a tab left and re-opened
 *      during its run, is drawn once while live and once after a reload (2026-10-03, "if I refresh the page,
 *      the duplicate answer goes away").
 *  13. A prompt whose turn starts 20 s after the send is drawn once after a reload under its run, and once when
 *      the run finished while its tab was away (2026-10-03, the prompt drawn twice).
 *
 * Usage: node drive.mjs --url http://127.0.0.1:18997
 * Exit code 1 when an assertion fails.
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
const URL_ = args.url ?? "http://127.0.0.1:18997";
const SESSION_A = "agent:main:main";
const SESSION_B = "agent:main:tinker:mockb";
const SESSION_C = "agent:main:tinker:mockc";
const SESSION_D = "agent:main:tinker:mockd";
const SESSION_E = "agent:main:tinker:mocke";

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
// Two tabs, Main viewed. Seeded once: a reload must find what the page itself wrote.
await ctx.addInitScript(
  ([a, b, c, d, e]) => {
    if (!localStorage.getItem("tinker-tabs")) {
      localStorage.setItem(
        "tinker-tabs",
        JSON.stringify([
          { id: "tab-main", sessionKey: a, title: "🏠 Main", isAttached: true },
          { id: "tab-b", sessionKey: b, title: "Second", isAttached: true },
          { id: "tab-c", sessionKey: c, title: "Third", isAttached: true },
          { id: "tab-d", sessionKey: d, title: "Worker", isAttached: true },
          { id: "tab-e", sessionKey: e, title: "Folds", isAttached: true },
        ]),
      );
      localStorage.setItem("tinker.uiChoices", JSON.stringify({ "tab:active": "tab-main" }));
    }
  },
  [SESSION_A, SESSION_B, SESSION_C, SESSION_D, SESSION_E],
);
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

/** Where the pane stands: distance from the bottom, the first transcript row on screen, its offset. */
const viewport = () =>
  page.evaluate(() => {
    const el = document.getElementById("messages");
    const top = el.getBoundingClientRect().top;
    let first = null;
    for (const n of el.querySelectorAll("[data-oc-id]")) {
      const r = n.getBoundingClientRect();
      if (r.height > 0 && r.bottom > top) {
        first = { id: n.dataset.ocId, off: Math.round(r.top - top) };
        break;
      }
    }
    const ids = Array.from(el.querySelectorAll("[data-oc-id]")).map((n) => n.dataset.ocId);
    return {
      dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      first,
      last: ids.at(-1) ?? null,
      rows: ids.length,
    };
  });
const waitRows = (prefix) =>
  page.waitForFunction(
    (p) => document.querySelectorAll(`#messages [data-oc-id^="oc:${p}-"]`).length > 50,
    prefix,
    { timeout: 20000 },
  );
const settle = (ms = 2200) => page.waitForTimeout(ms); // > the mock's 900 ms image delay
const overChat = async () => {
  const box = await page.locator("#messages").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};
const switchTo = (id) => page.click(`[data-tab-id="${id}"]`);

await page.goto(`${URL_}/tinker/`, { waitUntil: "load" });
await waitRows("A");
await settle();

// 1 ─ a tab left following opens at its bottom, slow images included.
let v = await viewport();
check(v.dist <= 2, "1. tab A opens at its bottom after its images grow", `dist=${v.dist}`);

// Read history in A: real wheel gestures, well away from the bottom.
await overChat();
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(120);
}
await settle(600);
const readingA = await viewport();
check(
  readingA.dist > 1500 && readingA.first !== null,
  "   tab A is now reading history",
  `dist=${readingA.dist}`,
);

// 2 ─ the reported bug: B opened at A's offset.
await switchTo("tab-b");
await waitRows("B");
await settle();
v = await viewport();
check(
  v.dist <= 2,
  "2. switching to tab B opens B at its bottom, not at A's offset",
  `dist=${v.dist}`,
);

// 3 ─ A comes back where it was left.
await switchTo("tab-main");
await settle();
v = await viewport();
check(
  v.first?.id === readingA.first.id && Math.abs(v.first.off - readingA.first.off) <= 2,
  "3. switching back to tab A finds the row it was reading",
  `was ${readingA.first.id}@${readingA.first.off}, now ${v.first?.id}@${v.first?.off}`,
);

// 4 ─ and so does a reload.
await page.reload({ waitUntil: "load" });
await waitRows("A");
await settle(3000);
v = await viewport();
check(
  v.first?.id === readingA.first.id && Math.abs(v.first.off - readingA.first.off) <= 4,
  "4. a reload finds the row tab A was reading",
  `was ${readingA.first.id}@${readingA.first.off}, now ${v.first?.id}@${v.first?.off}`,
);

// 5 ─ up and back down to an unchanged bottom re-arms follow; rows that arrive while away are then shown.
await switchTo("tab-b");
await waitRows("B");
await settle();
await overChat();
await page.mouse.wheel(0, -500);
await page.waitForTimeout(1300); // past the echo window: the last pin's record must not swallow the gesture back
await page.mouse.wheel(0, 5000);
await settle(800);
v = await viewport();
check(v.dist <= 2, "   tab B is back at its bottom by gesture", `dist=${v.dist}`);
await fetch(`${URL_}/__mock/state`, {
  method: "POST",
  body: JSON.stringify({ extra: { [SESSION_B]: 6 } }),
});
await switchTo("tab-main");
await settle(800);
await switchTo("tab-b");
await page.waitForFunction(
  () => document.querySelector('#messages [data-oc-id="oc:B-126"]') !== null,
  null,
  { timeout: 20000 },
);
await settle();
v = await viewport();
check(
  v.dist <= 2 && v.last === "oc:B-126",
  "5. a tab re-armed at an unchanged bottom shows the rows that arrived while away",
  `dist=${v.dist} last=${v.last}`,
);

// 6 ─ a tab whose session never goes quiet still gets its history after a reload (2026-10-02, the
// parallel-worker tab): the merge used to wait for a quiet moment that never came.
await fetch(`${URL_}/__mock/state`, {
  method: "POST",
  body: JSON.stringify({ busy: [SESSION_B] }),
});
await page.reload({ waitUntil: "load" });
await page.waitForTimeout(6000);
v = await viewport();
check(
  v.rows > 50 && (v.last ?? "").startsWith("oc:B-"),
  "6. a busy tab gets its history after a reload",
  `rows=${v.rows} last=${v.last}`,
);
await fetch(`${URL_}/__mock/state`, { method: "POST", body: JSON.stringify({ busy: [] }) });

// 7 ─ a session reset before every turn: scrolling to the top pages its reset archives in above the
// live transcript, newest first, each under a "Session reset" divider (2026-10-02, the worker tab).
await overChat();
// Keep scrolling up, as a reader going back to the beginning does, until nothing more arrives.
let stable = 0;
let lastRows = -1;
for (let i = 0; i < 80 && stable < 6; i++) {
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(250);
  const { rows, loading } = await page.evaluate(() => ({
    rows: document.querySelectorAll("#messages [data-oc-id]").length,
    loading: document.getElementById("messages").classList.contains("archive-loading"),
  }));
  stable = rows === lastRows && !loading ? stable + 1 : 0;
  lastRows = rows;
}
await settle(800);
const arch = await page.evaluate(() => {
  const el = document.getElementById("messages");
  const seq = [];
  const counts = {};
  for (const n of el.querySelectorAll("[data-oc-id], .msg-reset-divider")) {
    const tag = n.classList.contains("msg-reset-divider")
      ? "|"
      : n.dataset.ocId.replace(/^oc:/, "").split("-")[0];
    seq.push(tag);
    counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return {
    order: seq.filter((x, i) => x !== seq[i - 1]).join(" "),
    bx1: counts.Bx1 ?? 0,
    bx2: counts.Bx2 ?? 0,
  };
});
// 20 rows per archive, served 12 at a time: whole only if each archive was read in two pages.
// Assistant rows carry data-oc-id (user bubbles do not): 10 per archive.
check(
  arch.order === "Bx1 | Bx2 | B" && arch.bx1 === 10 && arch.bx2 === 10,
  "7. scrolling up pages every reset archive in above, whole, each under its divider",
  JSON.stringify(arch),
);

// 8 ─ right after a reset the live transcript is EMPTY: scrolling up must still reach the archives.
await fetch(`${URL_}/__mock/state`, {
  method: "POST",
  body: JSON.stringify({ emptyLive: [SESSION_B] }),
});
await page.reload({ waitUntil: "load" });
await settle(3000);
await overChat();
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(250);
  const n = await page.evaluate(() => document.querySelectorAll(".msg-reset-divider").length);
  if (n >= 2) break;
}
await settle(800);
const afterReset = await page.evaluate(() => ({
  dividers: document.querySelectorAll(".msg-reset-divider").length,
  rows: document.querySelectorAll('#messages [data-oc-id^="oc:Bx"]').length,
}));
check(
  afterReset.dividers >= 1 && afterReset.rows > 0,
  "8. with an empty live transcript (just reset), scrolling up still pages the archives in",
  JSON.stringify(afterReset),
);

// 9 ─ a tab with earlier transcripts of every kind (2026-10-03, Main's left file and its backups): the copy that
// overlaps the live rows shows only what is older than them, labelled as a copy; a reply the gateway gave up on
// (empty) draws nothing; the reset archive comes last.
await switchTo("tab-c");
await page.waitForFunction(
  () => document.querySelectorAll('#messages [data-oc-id^="oc:C-"]').length >= 10,
  null,
  { timeout: 20000 },
);
await settle();
await overChat();
stable = 0;
lastRows = -1;
for (let i = 0; i < 80 && stable < 6; i++) {
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(250);
  const { rows, loading } = await page.evaluate(() => ({
    rows: document.querySelectorAll("#messages [data-oc-id]").length,
    loading: document.getElementById("messages").classList.contains("archive-loading"),
  }));
  stable = rows === lastRows && !loading ? stable + 1 : 0;
  lastRows = rows;
}
await settle(800);
const third = await page.evaluate(() => {
  const el = document.getElementById("messages");
  const seq = [];
  for (const n of el.querySelectorAll("[data-oc-id], .msg-reset-divider")) {
    seq.push(
      n.classList.contains("msg-reset-divider")
        ? "|"
        : n.dataset.ocId.replace(/^oc:/, "").split("-")[0],
    );
  }
  return {
    order: seq.filter((x, i) => x !== seq[i - 1]).join(" "),
    labels: Array.from(el.querySelectorAll(".msg-reset-divider")).map((n) => n.textContent.trim()),
  };
});
check(
  third.order === "Cr | Co | C" &&
    third.labels.length === 2 &&
    third.labels[0].startsWith("↺ Session reset") &&
    third.labels[1].includes("saved copy"),
  "9. a copy pages in only rows older than the page, labelled; an empty reply draws no divider",
  JSON.stringify(third),
);

// 10 ─ the parallel worker's pattern: its session is reset before every turn, and its tab is in the background
// while the turns run. A background tab never receives a session's live turns, so the turn it never saw exists
// only in an archive newer than rows it kept, and the turn running when it comes back is deferred (a live writer).
await switchTo("tab-d");
await page.waitForFunction(
  () => document.querySelectorAll('#messages [data-oc-id^="oc:Da-"]').length >= 5,
  null,
  { timeout: 20000 },
);
await settle();
await overChat();
stable = 0;
lastRows = -1;
for (let i = 0; i < 40 && stable < 5; i++) {
  await page.mouse.wheel(0, -4000);
  await page.waitForTimeout(250);
  const rows = await page.evaluate(
    () => document.querySelectorAll("#messages [data-oc-id]").length,
  );
  stable = rows === lastRows ? stable + 1 : 0;
  lastRows = rows;
}
await switchTo("tab-main");
await settle(800);
await fetch(`${URL_}/__mock/state`, {
  method: "POST",
  body: JSON.stringify({ dResets: 2, busy: [SESSION_D] }),
});
await page.waitForTimeout(1500);
await switchTo("tab-d");
await page.waitForTimeout(8000);
const worker = await page.evaluate(() => {
  const el = document.getElementById("messages");
  const seq = [];
  for (const n of el.querySelectorAll("[data-oc-id], .msg-reset-divider")) {
    seq.push(
      n.classList.contains("msg-reset-divider")
        ? "|"
        : n.dataset.ocId.replace(/^oc:/, "").split("-")[0],
    );
  }
  return {
    order: seq.filter((x, i) => x !== seq[i - 1]).join(" "),
    rows: seq.filter((x) => x !== "|").length,
  };
});
check(
  worker.order === "Dx | Da | Db | Dc",
  "10. a reset-every-turn tab left in the background gets back the turn it never saw, and the running one",
  JSON.stringify(worker),
);
await fetch(`${URL_}/__mock/state`, { method: "POST", body: JSON.stringify({ busy: [] }) });

// 11 ─ reading below closed Commentary folds, then a reload: the same row comes back at the same offset.
const firstShown = () =>
  page.evaluate(() => {
    const el = document.getElementById("messages");
    const top = el.getBoundingClientRect().top;
    for (const n of el.querySelectorAll("[data-oc-id]")) {
      const r = n.getBoundingClientRect();
      if (r.height > 0 && r.bottom > top && n.checkVisibility()) {
        return { id: `${n.dataset.ocId}/${n.dataset.ocPart ?? ""}`, off: Math.round(r.top - top) };
      }
    }
    return null;
  });
await switchTo("tab-e");
await page.waitForFunction(
  () => document.querySelectorAll('#messages [data-oc-id^="oc:E-"]').length > 20,
  null,
  { timeout: 20000 },
);
await settle();
const misses = [];
let hiddenStamped = 0;
for (const frac of [0.3, 0.5, 0.7]) {
  await overChat();
  // Get there by gesture, so the pane is READING (a programmatic jump is not a reading position).
  const target = await page.evaluate((f) => {
    const el = document.getElementById("messages");
    return Math.round(el.scrollHeight * f);
  }, frac);
  for (let n = 0; n < 60; n++) {
    const at = await page.evaluate(() => document.getElementById("messages").scrollTop);
    if (Math.abs(at - target) < 300) break;
    await page.mouse.wheel(0, at > target ? -400 : 400);
    await page.waitForTimeout(40);
  }
  await settle(1500);
  hiddenStamped = Math.max(
    hiddenStamped,
    await page.evaluate(
      () =>
        Array.from(document.querySelectorAll("#messages details:not([open]) [data-oc-id]")).filter(
          (n) => n.getBoundingClientRect().height > 0,
        ).length,
    ),
  );
  const was = await firstShown();
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(4000);
  if (
    (await page.evaluate(() => document.querySelector("[data-tab-id].active")?.dataset.tabId)) !==
    "tab-e"
  ) {
    await switchTo("tab-e");
  }
  await settle(3000);
  const now = await firstShown();
  if (!was || !now || was.id !== now.id || Math.abs(was.off - now.off) > 4) {
    misses.push(`${frac}: was ${was?.id}@${was?.off}, now ${now?.id}@${now?.off}`);
  }
}
check(
  misses.length === 0,
  "11. a reload while reading below closed Commentary folds comes back to the row on screen",
  `hidden stamped boxes ${hiddenStamped}; ${misses.join(" | ") || "3/3 positions kept"}`,
);

// 12 ─ the live-only duplicate (2026-10-03). The mock plays a captured turn's shape on the page's own
// prompt: a thought, a narration, a tool call, a second thought, an answer that streams for 17.6 s,
// and the gateway's two finals. The tab is left and re-opened while the run is live, so its history
// read is deferred and the first final releases it. Two extra copies used to follow the answer: the
// served one that gap-fill appended (the run's watched window ended 15 s after the answer bubble
// OPENED, and the import row is stamped when the answer FINISHED), and a tail the second final
// pushed after reslicing its body at the second thought's offset, which counts THINKING characters.
/** Poll the mock's scripted run until `done(run)` holds, for at most 50 s. */
const waitRun = async (done) => {
  let r = { runId: null, finals: 0, answer: "" };
  for (let i = 0; i < 200 && !done(r); i++) {
    await page.waitForTimeout(250);
    r = await (await fetch(`${URL_}/__mock/run`)).json();
  }
  return r;
};
await switchTo("tab-main");
await waitRows("A");
await settle();
const composer = page.locator("#chat-textarea");
await composer.click();
await composer.fill("Check nine: sum up the bench run in one paragraph.");
await composer.press("Enter");
// The run is live 0.3 s after the mock gets the send, and its first thought comes at 6 s.
await waitRun((r) => r.runId !== null);
await page.waitForTimeout(1000);
await switchTo("tab-b");
await page.waitForTimeout(1000);
await switchTo("tab-main");
const run9 = await waitRun((r) => r.finals === 2);
await settle();
/** Every answer bubble's text (no thought, narration or tool row), without the bubble's chrome. */
const answerTexts = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("#messages .msg.assistant:not(.msg-thinking)"), (el) => {
      const body = el.cloneNode(true);
      for (const x of body.querySelectorAll(
        ".msg-elapsed, [class*='badge'], button, .tool-row, .tool-detail",
      )) {
        x.remove();
      }
      return body.textContent.replace(/\s+/g, " ").trim();
    }),
  );
/** How many bubbles show the run's answer, and how many pairs of bubbles repeat each other whole
 *  (equal) or from a point inside (one a strict suffix of the other). A pair under 40 chars is
 *  skipped: two different turns can both answer "Done.". */
const repeats = (texts) => {
  const opening = run9.answer.slice(0, 60);
  const out = { answer: texts.filter((t) => t.includes(opening)).length, equal: 0, tail: 0 };
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const [a, b] = [texts[i], texts[j]];
      if (Math.min(a.length, b.length) < 40) {
        continue;
      }
      if (a === b) {
        out.equal++;
      } else if (a.endsWith(b) || b.endsWith(a)) {
        out.tail++;
      }
    }
  }
  return out;
};
const live9 = repeats(await answerTexts());
await page.reload({ waitUntil: "load" });
await waitRows("A");
await settle(3000);
const reload9 = repeats(await answerTexts());
const once = (r) => r.answer === 1 && r.equal === 0 && r.tail === 0;
check(
  run9.finals === 2 && once(live9) && once(reload9),
  "12. a long answer after a thought and a mid-run tab switch shows once, live and after a reload",
  `finals=${run9.finals} live=${JSON.stringify(live9)} reload=${JSON.stringify(reload9)}`,
);

// 13 ─ the prompt drawn twice (2026-10-03). The turn starts 20 s after its send (46% of prompts start
// more than 15 s late). From then on chat.history serves the prompt as the row the gateway keyed with
// the page's own key, stamped at the turn's start: outside the ±15 s the bubble covers by itself.
// (a) A reload after the turn started and before its first thought: the page knows the run is live
// (its heartbeat), so nothing proves the outbox entry, and the bubble the outbox put back sat beside
// the served row. (b) The tab left before the turn starts and opened after both finals: the background
// refresh at the finals wrote the served row beside the bubble. Each shows the prompt once.
await fetch(`${URL_}/__mock/state`, {
  method: "POST",
  body: JSON.stringify({ runStartDelayMs: 20000, historyDelayMs: 1500, runHeartbeatMs: 1000 }),
});
/** How many prompt bubbles show `text`. */
const promptCount = (text) =>
  page.evaluate(
    (t) =>
      Array.from(
        document.querySelectorAll("#messages .msg.user"),
        (el) => el.textContent ?? "",
      ).filter((s) => s.includes(t)).length,
    text,
  );
const send = async (text) => {
  await composer.click();
  await composer.fill(text);
  await composer.press("Enter");
};
const PROMPT_13A = "Check thirteen A: a turn that starts late, reloaded before its first thought.";
await switchTo("tab-main");
await waitRows("A");
await settle();
await send(PROMPT_13A);
const run13a = await waitRun((r) => r.runId !== null && r.runId !== run9.runId);
await waitRun((r) => r.runId === run13a.runId && r.phase === "started");
await page.reload({ waitUntil: "load" });
await waitRows("A");
await page.waitForTimeout(7000); // the outbox puts its bubbles back 0.8 s after a load, then every 5 s
const reloaded13a = await promptCount(PROMPT_13A);
await waitRun((r) => r.runId === run13a.runId && r.finals === 2);
await settle(3000);
const final13a = await promptCount(PROMPT_13A);
await page.reload({ waitUntil: "load" });
await waitRows("A");
await settle(3000);
const reload13a = await promptCount(PROMPT_13A);
const PROMPT_13B = "Check thirteen B: a turn that starts late, finished while its tab is away.";
await send(PROMPT_13B);
const run13b = await waitRun((r) => r.runId !== null && r.runId !== run13a.runId);
await page.waitForTimeout(1000);
await switchTo("tab-b");
await waitRun((r) => r.runId === run13b.runId && r.phase === "answering");
await waitRun((r) => r.runId === run13b.runId && r.finals === 2);
await page.waitForTimeout(3000); // the background refresh at the finals
await switchTo("tab-main");
await settle(3000);
const back13b = await promptCount(PROMPT_13B);
await page.reload({ waitUntil: "load" });
await waitRows("A");
await settle(3000);
const reload13b = await promptCount(PROMPT_13B);
const counts13 = [reloaded13a, final13a, reload13a, back13b, reload13b];
check(
  counts13.every((n) => n === 1),
  "13. a prompt whose turn starts 20 s late shows once after a reload under its run and after finishing away",
  `reload-under-run=${reloaded13a} after-finals=${final13a} reload=${reload13a} back-from-away=${back13b} reload=${reload13b}`,
);

check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
