// Print the read-aloud list of some pages, as the viewer builds it: page each sentence is printed on,
// TAIL (end of a sentence joined from the page before), →pN (joined with its end on page N), pause.
// node test/reading-list.mjs <path under papers/> <page> [page …]   (needs server.py on :18820)
import { createRequire } from "node:module";
const require = createRequire(new globalThis.URL("../../../package.json", import.meta.url));
const { chromium } = require("playwright");
const [file, ...pages] = process.argv.slice(2);
const b = await chromium.launch();
const pg = await b.newPage();
pg.on("pageerror", (e) => console.error("[pageerror]", e.message));
await pg.goto(`http://127.0.0.1:18820/viewer/web/viewer.html?file=/papers/${file}`);
await pg.waitForFunction(() => window.pdfReader && PDFViewerApplication.pdfDocument);
for (const p of pages) {
  console.log(`--- list of page ${p}`);
  for (const s of await pg.evaluate((p) => window.pdfReader.sentences(Number(p)), p)) {
    const t = s.text.length > 110 ? `${s.text.slice(0, 50)} … ${s.text.slice(-50)}` : s.text;
    console.log(`p${s.page}${s.tail ? " TAIL" : "     "}${s.cont ? ` →p${s.cont.page}` : "    "} ${(s.pause || "").padEnd(4)} | ${t}`);
  }
}
await b.close();
