/**
 * Drives the built tinker-ui against mock-gateway.mjs (same folder) through the CALL TIMELINE's "the last run stays on
 * screen" contract (context-window-panel.md §5.3, FORK 2026-10-02 — the owner: "The CALL TIMELINE panel sometimes stays
 * empty, it should always show the last run instead"), in a real browser, reading what the canvas actually painted.
 *
 *   1. A run streamed live is drawn (both builds: the harness's own sanity check).
 *   2. While the next prompt is being prepared, the last run stays drawn and the title names the new prompt.
 *   3. A prompt that ends without a model call leaves the last run drawn.
 *   4. After a reload (every rebuild pushes one), the last run is still drawn, not a history note.
 *   5. (2026-10-02, one column per call) Both lanes are painted across the width: no stretch where nothing flowed.
 *   6. (2026-10-02) The prompt is itemised into buckets from each call's own `usage` composition: no "Unitemised".
 *
 * "Drawn" = pixels painted in the two lanes (the axis band, which the empty state also draws, is left out), the
 * stage note hidden, and the title counting the run's two calls. Run it on the previous build too: a build
 * before 2026-10-02's last-run fix fails 2-4, the rate chart fails 5, and a build that ignores the composition 6.
 *
 * Usage: node drive.mjs --url http://127.0.0.1:18996
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
const URL_ = args.url ?? "http://127.0.0.1:18996";

const failures = [];
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(what);
};
const post = (path, body) =>
  fetch(`${URL_}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.text());

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

/** What the CALL TIMELINE shows: its width, title, stage note, and the pixels painted in its lanes. */
const panel = () =>
  page.evaluate(() => {
    const host = document.getElementById("cache-timeline");
    const canvas = host?.querySelector("canvas");
    const empty = host?.querySelector(".ctl-empty");
    const title = host?.querySelector(".cache-meta--title > span:last-child")?.textContent ?? "";
    let painted = 0;
    // Share of the width where each lane has paint: a stretch with nothing sent or received shows
    // up as columns with none.
    let topCover = 0;
    let botCover = 0;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const W = canvas.width;
      const H = canvas.height;
      const dpr = window.devicePixelRatio || 1;
      // The axis band (call-timeline-canvas.ts: AXIS_CSS_PX = 8, centred between the two lanes).
      const axisH = Math.max(4, Math.round(8 * dpr));
      const axisTop = Math.floor((H - axisH) / 2);
      const data = canvas.getContext("2d").getImageData(0, 0, W, H).data;
      const top = new Uint8Array(W);
      const bot = new Uint8Array(W);
      for (let y = 0; y < H; y++) {
        if (y >= axisTop - 1 && y <= axisTop + axisH + 1) continue;
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3] > 0) {
            painted++;
            (y < axisTop ? top : bot)[x] = 1;
          }
        }
      }
      topCover = top.reduce((a, v) => a + v, 0) / W;
      botCover = bot.reduce((a, v) => a + v, 0) / W;
    }
    return {
      width: canvas?.clientWidth ?? 0,
      title,
      note: empty && !empty.hidden ? empty.textContent : "",
      painted,
      topCover: Math.round(topCover * 1000) / 1000,
      botCover: Math.round(botCover * 1000) / 1000,
      legend: host?.querySelector(".ctl-legend")?.textContent ?? "",
    };
  });
const show = (p) =>
  `title="${p.title}" note="${p.note}" painted=${p.painted} cover=${p.topCover}/${p.botCover}`;
const drawn = (p) => p.painted > 0 && p.note === "" && /\b2 calls\b/.test(p.title);
const boot = async () => {
  await page.waitForFunction(
    () => document.querySelector("#cache-timeline canvas") !== null,
    null,
    {
      timeout: 20000,
    },
  );
  await page.waitForTimeout(3500); // connect, sessions, the anatomy backfill
};

await page.goto(`${URL_}/tinker/`, { waitUntil: "load" });
await boot();
let p = await panel();
check(p.width > 0, "0. the CALL TIMELINE canvas is on screen", `width=${p.width} ${show(p)}`);

// 1 ─ a run streamed live (the mock answers once all of it has been sent).
await post("/__mock/run", { runId: "run-1" });
await page.waitForTimeout(2500); // past the 1.5 s save debounce
p = await panel();
check(drawn(p), "1. a run streamed live is drawn", show(p));
// 5 ─ (2026-10-02) one column per call, side by side: the tool run and the waits between the
// calls are not drawn, so both lanes are painted across the width, bar the 1 px seams.
check(
  p.topCover >= 0.95 && p.botCover >= 0.95,
  "5. both lanes are painted across the width: no gap where nothing flowed",
  show(p),
);
// 6 ─ (2026-10-02) each call carries its itemised prompt: real buckets, nothing unitemised.
check(
  /Moral code/.test(p.legend) && /Tool results/.test(p.legend) && !/Unitemised/.test(p.legend),
  "6. the prompt is itemised into buckets, none unitemised",
  `legend="${p.legend}"`,
);

// 2 ─ the next prompt is sent: before its first call the panel used to go blank ("Preparing prompt N…").
await post("/__mock/prep", { runId: "run-2" });
await page.waitForTimeout(800);
p = await panel();
check(
  drawn(p) && /preparing/.test(p.title),
  "2. while the next prompt is prepared, the last run stays drawn",
  show(p),
);

// 3 ─ and it ends without a single model call.
await post("/__mock/end", { runId: "run-2" });
await page.waitForTimeout(2500);
p = await panel();
check(
  drawn(p) && /no model call/.test(p.title),
  "3. a prompt that made no call leaves the last run drawn",
  show(p),
);

// 4 ─ a reload, as every rebuild pushes one: the page's store starts empty and holds history rows only.
await page.reload({ waitUntil: "load" });
await boot();
p = await panel();
check(drawn(p), "4. after a reload the last run is still drawn", show(p));

check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
