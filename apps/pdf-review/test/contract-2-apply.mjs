// Contract 2: an Apply rebuild removes ONLY the marks it applied, the ones in the marked copy
// <name>-marques-oscar-N.pdf taken at Apply, and carries every newer mark onto the rebuilt file: one saved after the
// copy was taken, and one whose save was still on its way when the clean rebuild landed.
//   MODE=desktop|phone node test/contract-2-apply.mjs
import { testServer, makeDoc, rebuild, count, pdfText, launch, context, open, comment, shown, holdSaves, waitingOnDevice, check, finish, until, wait, ROOT, PHONE, copyFileSync, writeFileSync, mkdirSync, rmSync } from "./contract-lib.mjs";
import { existsSync } from "node:fs";

const srv = testServer("c2", 18852 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv);
const name = doc.pdf.split("/").pop();
const flag = `${ROOT}state/applying/${name}.flag`;
const copy = doc.pdf.replace(/\.pdf$/, "-marques-oscar-1.pdf");
rmSync(copy, { force: true });
const browser = await launch();
const errors = [];
try {
  const ctx = await context(browser);
  await ctx.route(/\/api\/origin/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  const page = await open(ctx, doc.url, errors);
  const N1 = "comment the agent applies", N2 = "comment made after the marked copy", N3 = "comment saved during the clean rebuild";
  await comment(page, "Alpha", N1);
  check(await until(() => count(doc.pdf, N1) === 1, 30000), "the first comment is saved");

  // Apply: the button saves and wakes the chat (answered here); the server would write this flag.
  await page.evaluate(() => document.getElementById("redoDocument").click());
  mkdirSync(`${ROOT}state/applying`, { recursive: true });
  writeFileSync(flag, "test");
  await wait(1500);
  copyFileSync(doc.pdf, copy); // the agent's marked copy: what this round applies
  check(count(copy, N1) === 1, "the marked copy holds the comment being applied");

  await comment(page, "Charlie", N2); // he reads on while the agent works
  check(await until(() => count(doc.pdf, N2) === 1, 30000), "a comment made after the copy reaches the file");

  const gate = await holdSaves(page);
  await comment(page, "Delta", N3);
  await until(() => gate.held > 0, 15000);
  rebuild(doc, { from: "Alpha opens", to: "Alpha opens the chapter, now changed as the first comment asked.", keep: false });
  check(!existsSync(flag), "the clean rebuild took the Apply flag away");
  check(count(doc.pdf, N1) === 0, "the applied comment is gone from the rebuild", `found ${count(doc.pdf, N1)}`);
  check(count(doc.pdf, N2) === 1, "the comment made after the copy is carried onto the clean rebuild", `found ${count(doc.pdf, N2)}`);
  gate.release();
  await gate.stop();
  check(await until(() => count(doc.pdf, N3) === 1, 40000), "the comment whose save was on its way reaches the rebuilt file", `found ${count(doc.pdf, N3)}`);
  check(count(doc.pdf, N1) === 0 && count(doc.pdf, N2) === 1, "and the applied one stays gone, the other stays once", `${count(doc.pdf, N1)} / ${count(doc.pdf, N2)}`);
  check(pdfText(doc.pdf).includes("now changed as the first comment asked"), "the rebuild's text is in the file");

  await until(async () => (await waitingOnDevice(page)) === 0 && (await page.evaluate(() => document.querySelector("#viewer").textContent.includes("now changed"))), 40000);
  const onPage = await shown(page);
  check(onPage.includes(N2) && onPage.includes(N3) && !onPage.includes(N1), "the page shows the two newer comments and not the applied one", onPage.replace(/\n/g, " | "));
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  rmSync(flag, { force: true });
  await browser.close();
  await srv.stop();
}
finish();
