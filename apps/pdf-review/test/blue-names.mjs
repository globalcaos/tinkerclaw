// Blue names (2026-11-18, need: see at a glance which files still hold unapproved new text): in the
// 🕘 Recent list a PDF whose paragraphs still wait for ✓ Approve shows its name in the new-text blue, the count in its
// tooltip; the others stay as they are. Throwaway documents on a server this test starts itself (contract-lib.mjs).
//   MODE=desktop node test/blue-names.mjs   ·   MODE=phone node test/blue-names.mjs   (Pi: PW_CHROMIUM=/usr/bin/chromium)
// SHOTS=<folder>: where list-<mode>.png goes (default: the test's own folder).
// Checks: /api/history never scans (no count before one is known); the list draws, then the blue name comes with the
// same count the page's ✓ Approve buttons have; Approve all on the page turns the name back at the next list open; a
// rebuild that adds blue text turns a name blue; a failing scan leaves the list drawn with the last counts known; on the
// phone, the list drawn with no connection keeps the last counts.
import { testServer, makeDoc, rebuild, launch, context, open, check, until, wait, finish, MODE, PHONE, PARAS } from "./contract-lib.mjs";

const srv = testServer("blue-names", 18870 + (PHONE ? 100 : 0));
await srv.start();
const nw = (s) => `<div class="nw" markdown="1">\n\n${s}\n\n</div>`;
const A = makeDoc(srv, "blue", [PARAS[0], nw("A new paragraph written this round, still blue until it is approved."), PARAS[2],
  `Some old words with <span class="nw">a phrase added this round</span> and more old words after it.`, PARAS[4]]);
const B = makeDoc(srv, "plain");
const api = async (p) => (await fetch(srv.base + p)).json();
const enc = encodeURIComponent;
const nameOf = (path) => path.split("/").pop();
const BLUE = "rgb(30, 144, 255)";

// /api/history answers from what is already known: nothing has been scanned yet.
const h0 = (await api("/api/history")).files;
const a0 = h0.find((f) => f.name === nameOf(A.served)), b0 = h0.find((f) => f.name === nameOf(B.served));
check(!!a0 && !!b0, "both throwaway documents are in the history", h0.map((f) => f.name).join(", "));
check(a0 && !("blue" in a0), "/api/history does not scan a file to answer", JSON.stringify(a0));

const browser = await launch();
const ctx = await context(browser);
const errors = [];
const page = await open(ctx, A.url, errors);

async function recent(p = page) {
  await p.evaluate(() => document.getElementById("recentDialog")?.close());
  try {
    if (PHONE) await p.tap("#recentFiles", { timeout: 3000 }); else await p.click("#recentFiles", { timeout: 3000 });
  } catch { await p.evaluate(() => document.getElementById("recentFiles").click()); }
  await p.waitForSelector("#recentDialog[open]", { timeout: 10000 });
  await until(() => p.evaluate(() => !/Loading/.test(document.querySelector("#recentDialog .recentList").textContent)), 15000, 200);
}
// A row by its file's name: on the phone the offline engine links the folder again (/api/folder), so the row may point
// at a newer link to the same file than the one the test made.
const row = (p, path) => p.evaluate((name) => {
  const r = [...document.querySelectorAll("#recentDialog .recentRow")].find((x) => x.querySelector(".recentName")?.textContent === name);
  if (!r) return null;
  const n = r.querySelector(".recentName");
  return { color: getComputedStyle(n).color, blue: n.classList.contains("toApprove"), title: r.title, count: r.dataset.blue, name: n.textContent };
}, nameOf(path));
const settled = (p, path, want) => until(async () => (await row(p, path))?.blue === want, 15000, 250);

// The page's own count: the ✓ Approve buttons it has.
const items = (await api(`/api/approve?path=${enc(A.served)}`)).items;
check(items.length === 2, "the blue document has two paragraphs to approve", `${items.length}`);

await recent();
check(await settled(page, A.served, true), "the blue document's name is blue in the Recent list");
let ra = await row(page, A.served), rb = await row(page, B.served);
check(ra?.color === BLUE, "...in the new-text blue #1e90ff", ra?.color);
check(ra?.title === `${items.length} blue paragraphs to approve`, "...with the page's count in its tooltip", ra?.title);
check(rb && !rb.blue && rb.color !== BLUE && !rb.title, "the plain document's name stays as it was", JSON.stringify(rb));
const h1 = (await api("/api/history")).files;
check(h1.find((f) => f.name === nameOf(A.served))?.blue === 2 && h1.find((f) => f.name === nameOf(B.served))?.blue === 0,
  "once scanned, /api/history carries the counts", JSON.stringify(h1.map((f) => [f.name, f.blue])));
await page.screenshot({ path: `${process.env.SHOTS || srv.dir}/list-${MODE}.png` });

// The scan fails (or the Pi does not answer it): the list still draws, with the last counts known.
await page.route(/\/api\/blue/, (r) => r.abort("failed"));
await recent();
ra = await row(page, A.served);
check(!!ra && ra.blue && !!(await row(page, B.served)), "a failed scan leaves the list drawn with the last counts", JSON.stringify(ra));
await page.unroute(/\/api\/blue/);

if (PHONE) {
  // No connection: the list comes from the phone's copy and keeps the last counts it knew; never an error.
  await until(() => page.evaluate(() => !!navigator.serviceWorker?.controller), 30000);
  await recent(); // online once under the service worker, so it keeps this answer
  await ctx.setOffline(true);
  await recent();
  const txt = await page.textContent("#recentDialog .recentList");
  ra = await row(page, A.served);
  check(!!ra && ra.blue && !/could not be loaded/.test(txt), "offline, the list keeps the last counts it knew", JSON.stringify(ra) + " " + txt.slice(0, 80));
  await ctx.setOffline(false);
}
await page.evaluate(() => document.getElementById("recentDialog")?.close());

// ✓ Approve all on the page: the name is back to normal at the next list open.
await page.waitForSelector("#viewer .apBtn.apAll", { timeout: 20000 });
if (PHONE) await page.tap("#viewer .apBtn.apAll"); else await page.click("#viewer .apBtn.apAll");
await until(async () => (await api(`/api/approve?path=${enc(A.served)}`)).items.length === 0, 30000, 500);
await recent();
check(await settled(page, A.served, false), "after Approve all the name is no longer blue", JSON.stringify(await row(page, A.served)));
ra = await row(page, A.served);
check(ra?.color !== BLUE && !ra?.title, "...and has no tooltip", JSON.stringify(ra));
// once the rebuilt PDF is in, still not blue
await until(async () => !(await api(`/api/built?path=${enc(A.served)}`)).pending, 60000, 1000);
await wait(500);
await recent();
check(await settled(page, A.served, false), "...nor after the rebuilt PDF is in", JSON.stringify(await row(page, A.served)));

// A rebuild that adds blue text turns a name blue.
rebuild(B, { from: "Echo closes", to: `Echo closes the page with <span class="nw">new words added in a later round</span>.`, keep: false });
await recent();
check(await settled(page, B.served, true), "a rebuild that adds blue text turns the plain name blue", JSON.stringify(await row(page, B.served)));
rb = await row(page, B.served);
check(rb?.title === "1 blue paragraph to approve", "...one paragraph, said in the singular", rb?.title);

check(!errors.length, "no page errors", errors.join(" | "));
await browser.close();
await srv.stop();
finish();
