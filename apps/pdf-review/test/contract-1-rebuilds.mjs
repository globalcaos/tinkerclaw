// Contract 1: a rebuild that lands while he types, while a save is on its way, or two rebuilds in a row, loses no
// mark. Each mark must end in the file on disk exactly once, the rebuilt text must stay, and the page must show both.
//   MODE=desktop|phone node test/contract-1-rebuilds.mjs   (Pi: PW_CHROMIUM=/usr/bin/chromium; own server on 18851)
import { testServer, makeDoc, rebuild, count, pdfText, launch, context, open, comment, shown, holdSaves, waitingOnDevice, check, finish, until, wait, PHONE } from "./contract-lib.mjs";

const srv = testServer("c1", 18851 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv);
const browser = await launch();
const errors = [];
try {
  const ctx = await context(browser);
  const page = await open(ctx, doc.url, errors);

  // a. typing: the comment box is open and the note half written when the rebuild lands
  await comment(page, "Alpha", "note typed across a rebuild", { close: false });
  await wait(1500);
  rebuild(doc, { to: "Bravo is rewritten by the first rebuild, while the box is open." });
  await page.type("#commentManagerTextInput", " and finished after it", { delay: 15 });
  await page.click("#commentManagerSaveButton");
  const A = "note typed across a rebuild and finished after it";
  await until(() => count(doc.pdf, A) === 1, 30000);
  check(count(doc.pdf, A) === 1, "a note typed while a rebuild landed is in the file once", `found ${count(doc.pdf, A)}`);
  check(pdfText(doc.pdf).includes("rewritten by the first rebuild"), "the rebuild's text is still in the file");

  // b. a save on its way when the rebuild lands
  const gate = await holdSaves(page);
  await comment(page, "Charlie", "note whose save was in flight");
  await until(() => gate.held > 0, 15000);
  rebuild(doc, { from: "Bravo is", to: "Bravo is rewritten again, by the second rebuild." });
  gate.release();
  await gate.stop();
  const B = "note whose save was in flight";
  await until(() => count(doc.pdf, B) === 1, 40000);
  check(count(doc.pdf, B) === 1, "a note whose save was on its way across a rebuild is in the file once", `found ${count(doc.pdf, B)}`);
  check(count(doc.pdf, A) === 1, "the first note is still there once", `found ${count(doc.pdf, A)}`);

  // c. two rebuilds in a row while a save waits
  const gate2 = await holdSaves(page);
  await comment(page, "Delta", "note across two rebuilds in a row");
  await until(() => gate2.held > 0, 15000);
  rebuild(doc, { from: "Bravo is", to: "Bravo is rewritten a third time." });
  await wait(1200);
  rebuild(doc, { from: "Bravo is", to: "Bravo is rewritten a fourth time, the last." });
  gate2.release();
  await gate2.stop();
  const C = "note across two rebuilds in a row";
  await until(() => count(doc.pdf, C) === 1, 40000);
  check(count(doc.pdf, C) === 1, "a note saved across two rebuilds in a row is in the file once", `found ${count(doc.pdf, C)}`);
  check(pdfText(doc.pdf).includes("rewritten a fourth time"), "the last rebuild's text is in the file");
  check([A, B].every((n) => count(doc.pdf, n) === 1), "no earlier note doubled or lost");

  // the page ends on the newest file, showing every note, with nothing left waiting on the device
  await until(async () => (await waitingOnDevice(page)) === 0 && (await page.evaluate(() => document.querySelector("#viewer").textContent.includes("fourth time"))), 40000);
  const onPage = await shown(page);
  check([A, B, C].every((n) => onPage.includes(n)), "the page shows all three notes", onPage.replace(/\n/g, " | ").slice(0, 200));
  check(await page.evaluate(() => document.querySelector("#viewer").textContent.includes("fourth time")), "the page shows the newest rebuild");
  check((await waitingOnDevice(page)) === 0, "nothing left waiting on the device");
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
