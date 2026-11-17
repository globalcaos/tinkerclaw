// Side-key dictation lands at the cursor of an open Edit paragraph box, and only a box takes it.
// node test/dictate-edit.mjs   (server on 127.0.0.1:18820; on the Pi: PW_CHROMIUM=/usr/bin/chromium)
// Nothing is saved: the box is a stand-in of the popup's textarea, removed before the page closes.
import { createRequire } from "node:module";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const page = await (await browser.newContext({ viewport: { width: 411, height: 820 }, isMobile: true, hasTouch: true })).newPage();
await page.goto(`http://127.0.0.1:${process.env.PDF_REVIEW_PORT || 18820}/viewer/web/viewer.html`);
for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__pdfDictate)); i++) await page.waitForTimeout(100);
const r = await page.evaluate(() => {
  const closed = window.__pdfDictate("nobody");
  const ta = document.createElement("textarea");
  ta.className = "epText";
  ta.value = "one three";
  document.body.append(ta);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = 4;
  const took = window.__pdfDictate("two");
  const out = { closed, took, value: ta.value, caret: ta.selectionStart };
  ta.remove();
  return out;
});
await browser.close();
console.log(r);
const ok = r.closed === false && r.took === true && r.value === "one two three" && r.caret === 8;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
