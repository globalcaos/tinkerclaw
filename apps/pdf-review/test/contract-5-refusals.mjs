// Contract 5: 409 and 422 refusals of any kind lose nothing.
//   a. a part save answered 422 (the part does not fit): the whole file follows and the mark lands;
//   b. a part save answered 409 (the file moved on): the whole file follows, carried, and the mark lands;
//   c. the Pi keeps every refused upload under state/refused/ (body + .json), and pdf-refused.py lists its notes;
//   d. a paragraph edit refused because the paragraph changed meanwhile: his words stay in the box, the Pi keeps them
//      (state/refused/, edit-drafts.json), and one more tap puts them in place of the changed paragraph.
//   MODE=desktop|phone node test/contract-5-refusals.mjs
import { testServer, makeDoc, count, launch, context, open, comment, waitingOnDevice, check, finish, until, wait, PY, ROOT, PHONE, readFileSync, writeFileSync, copyFileSync } from "./contract-lib.mjs";
import { readdirSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";

const srv = testServer("c5", 18855 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv);
const browser = await launch();
const errors = [];
const refused = () => { try { return readdirSync(`${srv.state}/refused`); } catch { return []; } };
try {
  const ctx = await context(browser);
  const page = await open(ctx, doc.url, errors);

  // a + b: the first part save of each mark is refused by a stand-in, as a real 422 / 409 would be
  for (const [status, word, note] of [[422, "Alpha", "mark whose part save got 422"], [409, "Charlie", "mark whose part save got 409"]]) {
    let faked = 0;
    const fake = (route) => {
      if (!faked && route.request().url().includes("keep=")) { faked++; return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: status === 409 ? "changed" : "the part sent does not fit the file here", need: "whole" }) }); }
      return route.continue();
    };
    await page.route(/\/api\/save/, fake);
    await comment(page, word, note);
    check(await until(() => count(doc.pdf, note) === 1, 30000), `a part save refused with ${status} still puts the mark in the file once`, `faked ${faked}, found ${count(doc.pdf, note)}`);
    await page.unroute(/\/api\/save/, fake);
  }
  check(await until(async () => (await waitingOnDevice(page)) === 0, 20000), "nothing left waiting on the device");

  // c: refused uploads are kept on the Pi, and the recovery script reads their notes
  const n0 = refused().length;
  const marked = `${srv.dir}/marked-for-refusal.pdf`;
  copyFileSync(doc.pdf, marked);
  execFileSync(PY, ["-I", "-c", "import pymupdf,sys; d=pymupdf.open(sys.argv[1]); d[0].add_text_annot((80,80),sys.argv[2]); d.saveIncr()", marked, "note only a refused upload holds"]);
  const body = readFileSync(marked);
  const put = (q, b, headers = {}) => fetch(`${srv.base}/api/save?path=${encodeURIComponent(doc.served)}${q}`, { method: "PUT", body: b, headers });
  const r409 = await put(`&base=${encodeURIComponent("Mon, 01 Jan 2001 00:00:00 GMT|1")}`, body); // an old viewer: no base copy, file moved on
  const r422 = await put(`&base=${encodeURIComponent((await (await fetch(srv.base + doc.served, { method: "HEAD" })).headers.get("Last-Modified")) + "|0")}&keep=10&len=99&crc=1`, body.subarray(0, 50));
  check(r409.status === 409 && r422.status === 422, "the server refuses both uploads", `${r409.status} ${r422.status}`);
  const kept = refused().filter((f) => !f.endsWith("paragraph.json"));
  check(kept.length - n0 >= 4, "each refused upload is kept: body and sidecar", kept.slice(-4).join(" "));
  const listed = execFileSync(PY, [`${ROOT}pdf-refused.py`, doc.pdf.split("/").pop()], { encoding: "utf8", env: { ...process.env, PDF_REVIEW_STATE: srv.state } });
  check(listed.includes("note only a refused upload holds"), "pdf-refused.py lists the note a refused upload held", listed.split("\n").slice(-6).join(" / "));
  check(count(doc.pdf, "note only a refused upload holds") === 0, "and the refused upload did not touch the file");

  // d: a paragraph edit refused because the paragraph changed under the open box
  const md0 = readFileSync(doc.md, "utf8");
  const blocks = md0.split(/\n\n/);
  const index = blocks.findIndex((b) => b.startsWith("Bravo"));
  await page.evaluate(([i, t, p]) => window.__pdfEditPopup({ index: i, text: t }, p), [index, blocks[index], doc.served]);
  await page.waitForSelector(".epWrap textarea");
  const MINE = "Bravo, as he rewrote it in the box while an agent changed it.";
  await page.fill(".epWrap textarea", MINE);
  writeFileSync(doc.md, md0.replace(/^Bravo is.*$/m, "Bravo is the paragraph an agent changed meanwhile."));
  const t = Date.now() / 1000 - 120;
  utimesSync(doc.md, t, t); // no rebuild from the watcher: only the source moved
  await page.click(".epWrap .save");
  await wait(1500);
  const box = await page.evaluate(() => ({ open: !!document.querySelector(".epWrap"), text: document.querySelector(".epWrap textarea")?.value, btn: document.querySelector(".epWrap .save")?.textContent, msg: document.querySelector(".epWrap .msg")?.textContent }));
  check(box.open && box.text === MINE, "the refused edit stays in the box, word for word", box.msg);
  check(/Put my words in/.test(box.btn || ""), "with a one-tap way to put the words in", box.btn);
  check(refused().some((f) => f.endsWith(".json") && readFileSync(`${srv.state}/refused/${f}`, "utf8").includes(MINE)), "the Pi kept the refused words under state/refused/");
  const drafts = JSON.parse(readFileSync(`${srv.state}/edit-drafts.json`, "utf8"));
  check(Object.values(drafts).some((d) => d.text === MINE), "and as the edit offered back on the next open (edit-drafts.json)");
  await page.click(".epWrap .save");
  check(await until(() => readFileSync(doc.md, "utf8").includes(MINE), 15000), "one tap puts his words into the source");
  check(!readFileSync(doc.md, "utf8").includes("an agent changed meanwhile"), "in place of the changed paragraph, not beside it");
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
