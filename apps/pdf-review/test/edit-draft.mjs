// An unsaved paragraph edit survives a page that dies with the box open (an app or gateway restart).
// As a phone: open the Edit paragraph box, type, kill the page (no beforeunload), reopen: the viewer must
// offer the text back as "Paragraph edit not saved". Cancel must leave nothing behind.
// node test/edit-draft.mjs   (server on 127.0.0.1:18820; on the Pi: PW_CHROMIUM=/usr/bin/chromium)
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const URL_ = fixtureUrl();
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 411, height: 820 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const open = async () => {
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && !!window.__pdfEditPopup, null, { timeout: 30000 });
  return page;
};
const TEXT = "A paragraph edit that was never saved.";
let page = await open();
await page.evaluate(() => window.__pdfEditPopup({ index: 0, text: "old text" }, "/papers/open/jarvistest/t.pdf"));
await page.fill(".epText", TEXT);
await page.waitForTimeout(300);
await page.close({ runBeforeUnload: false });
page = await open();
await page.waitForSelector("#draftRescue", { timeout: 8000 }).catch(() => {});
const offered = await page.evaluate(() => {
  const b = document.getElementById("draftRescue");
  return b ? { title: b.firstChild.textContent, text: b.querySelector("textarea").value } : null;
});
// Cancel clears it: open the box again, type, cancel, reload: nothing is offered.
await page.evaluate(() => { document.getElementById("draftRescue")?.querySelectorAll("button")[1].click(); });
await page.evaluate(() => window.__pdfEditPopup({ index: 0, text: "old text" }, "/papers/open/jarvistest/t.pdf"));
await page.fill(".epText", "typed then cancelled");
await page.click(".epWrap .cancel");
await page.close({ runBeforeUnload: false });
page = await open();
await page.waitForTimeout(1500);
const afterCancel = await page.evaluate(() => !!document.getElementById("draftRescue"));
await browser.close();
console.log({ offered, afterCancel });
const ok = offered?.text === TEXT && /Paragraph edit not saved/.test(offered.title) && afterCancel === false;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
