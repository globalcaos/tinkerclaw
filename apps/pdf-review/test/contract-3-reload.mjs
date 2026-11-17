// Contract 3: a page reload (what a viewer code update amounts to on the device), the tab or app killed, the phone
// locked: every mark stays on the device and visible, and reaches the Pi once it answers. The saves are refused at
// the network level the whole time, so nothing can hide in the Pi.
//   MODE=desktop|phone node test/contract-3-reload.mjs
import { testServer, makeDoc, count, launch, context, open, comment, shown, waitingOnDevice, check, finish, until, wait } from "./contract-lib.mjs";
import { PHONE } from "./contract-lib.mjs";

const srv = testServer("c3", 18853 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv);
const browser = await launch();
const errors = [];
const N1 = "mark kept across a reload", N2 = "mark made on the reopened page", N3 = "mark made right before the phone locked", N4 = "words typed in a box when the app died";
try {
  const ctx = await context(browser);
  const cut = (route) => route.abort("internetdisconnected"); // the Pi cannot be reached for saves
  await ctx.route(/\/api\/save/, cut);
  let page = await open(ctx, doc.url, errors);
  await comment(page, "Alpha", N1);
  await wait(9500);
  check((await waitingOnDevice(page)) >= 1, "the mark is kept on the device");
  const note = await page.evaluate(() => { const b = document.getElementById("saveState"); return b && !b.hidden ? b.textContent : ""; });
  check(/waiting|Kept/i.test(note), "he can see that marks are waiting", note);

  // a reload (a viewer code update ends the same way)
  await page.reload();
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span"), null, { timeout: 60000 });
  check(await until(async () => (await shown(page)).includes(N1), 20000), "after the reload the page shows the kept mark");
  check(count(doc.pdf, N1) === 0, "and it is not on the Pi yet (the saves are cut)");

  // a mark on the reopened page, then the tab or app killed without any warning
  await comment(page, "Charlie", N2);
  await wait(1500);
  // the phone locked right after a mark (the 250 ms journal delay has not run): visibilitychange writes it
  await comment(page, "Delta", N3);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await wait(1200);
  // and words in an open comment box, never closed
  await comment(page, "Echo", N4, { close: false });
  await wait(1500);
  await page.close({ runBeforeUnload: false });

  // the app comes back, and the Pi answers again
  await ctx.unroute(/\/api\/save/, cut);
  page = await open(ctx, doc.url, errors);
  for (const n of [N1, N2, N3]) check(await until(() => count(doc.pdf, n) === 1, 40000), `"${n}" reaches the Pi once`, `found ${count(doc.pdf, n)}`);
  const n4 = await until(async () => count(doc.pdf, N4) === 1 || (await page.evaluate((t) => document.getElementById("draftRescue")?.textContent.includes(t), N4)), 30000);
  check(n4, "the words of the box that was never closed are on the Pi or offered back", `in file ${count(doc.pdf, N4)}`);
  await until(async () => (await waitingOnDevice(page)) === 0, 30000);
  const onPage = await shown(page);
  check([N1, N2, N3].every((n) => onPage.includes(n)), "the page shows every mark", onPage.replace(/\n/g, " | "));
  check((await waitingOnDevice(page)) === 0, "nothing left waiting on the device");
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
