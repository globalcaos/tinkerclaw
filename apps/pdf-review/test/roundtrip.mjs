// End-to-end check: annotate in the real viewer, save, read the comments back.
// node test/roundtrip.mjs [out.pdf]   (needs the server on 127.0.0.1:18820)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");

const OUT = process.argv[2] || "/tmp/pdf-review-roundtrip.pdf";
const URL = "http://127.0.0.1:18820/viewer/web/viewer.html?file=/papers/sample-paper.pdf";

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto(URL);
await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0);
await page.waitForSelector('.page[data-page-number="1"] .textLayer span');

const scrollMode = await page.evaluate(() => PDFViewerApplication.pdfViewer.scrollMode);
console.log("scrollMode", scrollMode, scrollMode === 3 ? "(page by page)" : "(NOT page mode)");

// 1. Select a run of text on page 1 with a real mouse drag, then use the floating Highlight button.
const spans = page.locator('.page[data-page-number="1"] .textLayer span');
const first = await spans.nth(0).boundingBox();
const last = await spans.nth(0).boundingBox();
await page.mouse.move(first.x + 1, first.y + first.height / 2);
await page.mouse.down();
await page.mouse.move(last.x + last.width - 1, last.y + last.height / 2, { steps: 8 });
await page.mouse.up();
console.log("selected:", JSON.stringify(await page.evaluate(() => String(getSelection()))));

const floating = page.locator("button.highlightButton").first();
await floating.waitFor({ timeout: 5000 });
await floating.click();
const editor = page.locator(".highlightEditor").first();
await editor.waitFor({ timeout: 5000 });
console.log("highlight created");

// 2. Attach a comment through the editor's own comment button and dialog.
await editor.click();
const commentBtn = page.locator(".highlightEditor .editToolbar button.comment, .editToolbar button[class*='comment']").first();
await commentBtn.waitFor({ timeout: 5000 });
await commentBtn.click();
await page.locator("#commentManagerTextInput").waitFor({ timeout: 5000 });
await page.fill("#commentManagerTextInput", "Title is too long, cut it to one line.");
await page.click("#commentManagerSaveButton");
console.log("comment saved");

// 3. A free-text note in the margin of page 1.
await page.keyboard.press("Escape");
await page.click("#editorFreeTextButton");
await page.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 3); // FREETEXT
const box = await page.locator('.page[data-page-number="1"]').boundingBox();
await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
await page.waitForFunction(() => document.activeElement?.closest?.(".freeTextEditor"));
await page.waitForTimeout(200);
await page.keyboard.type("Add a figure of the pipeline here.");
await page.mouse.click(box.x + 20, box.y + 20); // a click elsewhere commits; Escape would cancel it
await page.waitForTimeout(300);
console.log("free text editors:", JSON.stringify(await page.locator(".freeTextEditor").allInnerTexts()),
  "storage:", await page.evaluate(() => PDFViewerApplication.pdfDocument.annotationStorage.size));

// 3b. The toolbar Comment button opens the Comments panel; it should list the comment from step 2.
await page.click("#editorCommentButton");
await page.waitForTimeout(500);
console.log("comments panel:", JSON.stringify(await page.locator("#editorCommentsSidebar").innerText()));

// 4. Take the marked-up bytes the viewer would save (the Save buttons are gone since 2026-10-16),
// write them to OUT, then read the comments back.
const bytes = await page.evaluate(async () => Array.from(await PDFViewerApplication.pdfDocument.saveDocument()));
(await import("node:fs")).writeFileSync(OUT, Buffer.from(bytes));
await browser.close();
console.log("saved", OUT);
const listed = execFileSync("python3", [new globalThis.URL("../", import.meta.url).pathname + "pdf-comments.py", OUT], { encoding: "utf8" });
console.log(listed);
const want = ["→ Title is too long, cut it to one line.", "FreeText → Add a figure of the pipeline here."];
const missing = want.filter((w) => !listed.includes(w));
console.log(missing.length ? `FAIL, missing: ${missing.join(" | ")}` : "PASS: both comments read back exactly");
process.exitCode = missing.length ? 1 : 0;
