// Contract 7: ✏️ Write refused or interrupted keeps what he typed.
//   a. refused: he types in a paragraph an agent changes meanwhile; the save is refused (409). His words are shown
//      back with "Put my words in", kept on the Pi, and one tap puts them into the source in that paragraph's place;
//   b. interrupted: the page dies while he types (before the save); on the next open his words come back in the
//      edit box, and one tap (Save) puts them into the source.
//   MODE=desktop|phone node test/contract-7-writer.mjs
import { testServer, makeDoc, launch, context, open, check, finish, until, wait, PHONE, readFileSync, writeFileSync } from "./contract-lib.mjs";
import { readdirSync, utimesSync } from "node:fs";

const srv = testServer("c7", 18857 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv);
const browser = await launch();
const errors = [];
const md = () => readFileSync(doc.md, "utf8");
const wordAt = (page, w) => page.evaluate((word) => {
  for (const sp of document.querySelectorAll("#viewer .textLayer span")) {
    const node = sp.firstChild;
    const i = node?.nodeType === 3 ? node.textContent.indexOf(word) : -1;
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + word.length);
    const b = r.getBoundingClientRect();
    if (b.width) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }
  return null;
}, w);
async function writeIn(page, word, words) {
  if (!(await page.evaluate(() => document.body.classList.contains("writeMode")))) {
    await page.waitForSelector("#editSource:not([hidden])", { state: "attached", timeout: 15000 });
    await page.evaluate(() => document.getElementById("editSource").click());
    await page.waitForFunction(() => document.body.classList.contains("writeMode"));
    await wait(1500);
  }
  const p = await wordAt(page, word);
  if (PHONE) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
  await page.waitForSelector(".wrEd.wrOpen", { timeout: 8000 });
  await page.keyboard.press("End");
  await page.keyboard.type(words, { delay: 20 });
}
try {
  const ctx = await context(browser);
  let page = await open(ctx, doc.url, errors);

  // a. refused
  const MINE = " and his own words";
  await writeIn(page, "Bravo", MINE);
  writeFileSync(doc.md, md().replace(/^Bravo is.*$/m, "Bravo is what an agent wrote here meanwhile."));
  const t = Date.now() / 1000 - 120;
  utimesSync(doc.md, t, t); // only the source moved
  await page.keyboard.press("Escape"); // leaves the paragraph: the save goes out and is refused
  await page.waitForSelector(".wrNote", { timeout: 10000 });
  const note = await page.evaluate(() => ({ text: document.querySelector(".wrNote")?.textContent || "", buttons: [...document.querySelectorAll(".wrNote button")].map((b) => b.textContent) }));
  check(note.text.includes(MINE.trim()), "the refused words are shown back to him", note.text.slice(0, 160));
  check(note.buttons.includes("Put my words in"), "with a one-tap way to put them in", note.buttons.join(", "));
  const kept = readdirSync(`${srv.state}/refused`).some((f) => readFileSync(`${srv.state}/refused/${f}`, "utf8").includes(MINE.trim()));
  check(kept, "the Pi kept them under state/refused/");
  await page.evaluate(() => [...document.querySelectorAll(".wrNote button")].find((b) => b.textContent === "Put my words in").click());
  check(await until(() => md().includes(MINE.trim()), 15000), "one tap puts his words into the source");
  check(!md().includes("an agent wrote here meanwhile"), "in place of the paragraph the agent changed");

  // b. interrupted: the page dies while he types
  const LOST = " typed right before the app died";
  await wait(6000); // the rebuilt page has settled
  await writeIn(page, "Delta", LOST);
  await wait(1500); // the draft is copied to the device and the Pi (0.7 s), the save would come at 4 s
  await page.close({ runBeforeUnload: false });
  check(!md().includes(LOST.trim()), "the page died before the save");
  page = await open(ctx, doc.url, errors);
  const back = await until(() => page.evaluate((w) => (document.querySelector(".epWrap textarea")?.value || "").includes(w), LOST.trim()), 20000);
  check(back, "on the next open his words are back in the edit box");
  if (back) {
    await page.click(".epWrap .save");
    check(await until(() => md().includes(LOST.trim()), 15000), "one tap (Save) puts them into the source");
  }
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
