// An Apply round locks the comments it takes (the architect 2026-11-15 18:07). As the laptop and as the phone:
//   L1 after ✎ Apply comments every comment on the page shows the Apply button's robot on its icon: one saved in the
//      file before the page opened, one made on the page
//   L2 a locked comment cannot change: a tap on its marking opens no tools (a note says why); its card opens without
//      Edit and Delete, and its Edit opens no box; delete (bar, key), colour, the comment box, delete comment, ↶ all
//      refuse; the saved file still holds both notes
//   L3 a comment made after the press is not locked: plain icon, its tools open; the box's Apply is greyed meanwhile
//   L4 when the rebuilt PDF arrives the lock and the robot go: plain icons, a tap opens the tools, Apply is enabled
//   L5 the comment box's Apply sits between Cancel and Done: it saves the comment typed (the file holds it when the
//      chat is woken) and starts the round; that comment is locked with the others
//   L6 a wake that fails releases the lock at once
// Its own server and document (contract-lib.mjs), never the live viewer; the wake (/api/redo) is answered here.
//   MODE=desktop|phone node test/apply-lock.mjs   (Pi: PW_CHROMIUM=/usr/bin/chromium; CONTRACT_DIR, PORT_OFFSET as for the contract)
import { testServer, makeDoc, rebuild, count, comments, launch, context, open, comment, shown, check, finish, until, wait, PHONE } from "./contract-lib.mjs";

const srv = testServer("apply-lock", 18890 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv, "lock");
const N1 = "note saved before the page opened", N2 = "note made on the page", N3 = "note made during the round", N4 = "note sent with the box's Apply";
const browser = await launch();
const errors = [];
try {
  const ctx = await context(browser);
  await ctx.route(/\/api\/origin/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  let page = await open(ctx, doc.url, errors);
  // The wake: counted, the file read at that moment, and failed on demand (L6).
  const wakes = [];
  let fail = false;
  await page.route(/\/api\/redo/, (r) => {
    wakes.push(comments(doc.pdf));
    return fail ? r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"test failure"}' })
      : r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  const ready = () => page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer?.pagesCount > 0 && document.querySelector(".textLayer span"), null, { timeout: 60000 });

  await comment(page, "Alpha", N1);
  check(await until(() => count(doc.pdf, N1) === 1, 30000), "the first note is saved");
  await page.reload();
  await ready();
  await wait(2500);
  await comment(page, "Charlie", N2);
  check(await until(() => count(doc.pdf, N2) === 1, 30000), "the second note is saved");

  const box = (w) => page.evaluate((w) => {
    for (const sp of document.querySelectorAll("#viewer .textLayer span")) {
      const t = sp.firstChild, i = t?.nodeType === 3 ? t.textContent.indexOf(w) : -1;
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, w);
  // The comment icon nearest a word's line: whether it shows the robot, and where to press it.
  const icon = async (w) => {
    const p = await box(w);
    return page.evaluate((y) => {
      const vis = [...document.querySelectorAll("#viewer .annotationCommentButton")].filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "none");
      const near = vis.map((e) => ({ e, r: e.getBoundingClientRect() })).sort((a, b) => Math.abs(a.r.bottom - y) - Math.abs(b.r.bottom - y))[0];
      if (!near) return null;
      return { robot: getComputedStyle(near.e, "::before").backgroundImage, x: near.r.left + near.r.width / 2, y: near.r.top + near.r.height / 2 };
    }, p.y);
  };
  const robotUrl = await page.evaluate(() => getComputedStyle(document.getElementById("redoDocument"), "::before").backgroundImage);
  const isRobot = (i) => !!i && i.robot === robotUrl;
  const state = () => page.evaluate(() => {
    const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0;
    const bar = document.getElementById("selBar"), card = [...document.querySelectorAll(".commentPopup")].find(vis);
    const redo = document.getElementById("redoDocument");
    return {
      tools: vis(bar) && bar.classList.contains("forHighlight"), dialog: !!document.getElementById("commentManagerDialog")?.open,
      card: card ? card.textContent : null, cardButtons: card ? vis(card.querySelector(".commentPopupButtons")) : null,
      note: vis(document.getElementById("applyLockNote")), locked: document.querySelectorAll("#viewer .applyLocked").length,
      applying: redo.disabled, label: redo.textContent,
    };
  });
  const press = async (p) => { if (PHONE) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y); };
  const closeAll = async () => {
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => document.getElementById("selClear")?.click());
    await page.mouse.click(5, 300).catch(() => {});
    await wait(600);
  };

  // ---- L1 ---------------------------------------------------------------------------------------------------
  await page.evaluate(() => document.getElementById("redoDocument").click());
  check(await until(async () => wakes.length === 1 && (await state()).applying, 30000), "Apply woke the chat once and is thinking", `${wakes.length} wakes`);
  await wait(800);
  check(robotUrl.includes("tb-apply.svg"), "the toolbar's Apply icon is the robot", robotUrl);
  check(isRobot(await icon("Alpha")), "L1 the saved note's icon shows the robot", JSON.stringify(await icon("Alpha")));
  check(isRobot(await icon("Charlie")), "L1 the note made on the page shows the robot", JSON.stringify(await icon("Charlie")));

  // ---- L2 ---------------------------------------------------------------------------------------------------
  for (const w of ["Alpha", "Charlie"]) {
    await press(await box(w));
    await wait(1000);
    const s = await state();
    check(!s.tools && !s.dialog && s.note, `L2 a ${PHONE ? "tap" : "click"} on the locked marking (${w}) opens no tools and says why`, JSON.stringify(s));
    await closeAll();
  }
  for (const w of ["Alpha", "Charlie"]) {
    await press(await icon(w));
    await wait(1000);
    let s = await state();
    check(!!s.card && s.cardButtons === false && !s.dialog, `L2 the locked note's card (${w}) opens to be read, without Edit and Delete`, JSON.stringify(s));
    await page.evaluate(() => document.querySelector(".commentPopup .commentPopupEdit")?.click());
    await wait(600);
    s = await state();
    check(!s.dialog, `L2 its Edit opens no comment box (${w})`, JSON.stringify(s));
    await page.evaluate(() => document.querySelector(".commentPopup .commentPopupDelete")?.click());
    await wait(600);
    await closeAll();
  }
  // pdf.js's own paths, on the editor of the note made on the page, with its Highlight tool on (as pdf.js edits)
  const forced = await page.evaluate(async (note) => {
    const app = PDFViewerApplication, um = app.pdfViewer._layerProperties.annotationEditorUIManager;
    const find = () => { for (let p = 0; p < app.pdfViewer.pagesCount; p++) for (const ed of um.getEditors(p)) if (ed.comment?.text === note) return ed; return null; };
    const ed = find();
    if (!ed) return { found: false };
    const color = String(ed.color);
    app.eventBus.dispatch("switchannotationeditormode", { source: app, mode: 9, editId: ed.uid });
    for (let i = 0; i < 40 && um.firstSelectedEditor !== ed; i++) await new Promise((r) => setTimeout(r, 25));
    const selected = um.firstSelectedEditor === ed;
    um.delete();
    ed.updateParams(31, "#FF4F5F");
    um.editComment(ed);
    um.deleteComment(ed, ed.comment);
    um.undo();
    return { found: true, selected, color, ed: ed.id };
  }, N2);
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+z");
  await wait(600);
  const after = await page.evaluate(({ note, id }) => {
    const app = PDFViewerApplication, um = app.pdfViewer._layerProperties.annotationEditorUIManager, ed = um.getEditor(id);
    const out = { alive: !!ed && ed.div?.isConnected, text: ed?.comment?.text, color: String(ed?.color), dialog: !!document.getElementById("commentManagerDialog").open,
      bar: [...(ed?.div?.querySelectorAll(".editToolbar") ?? [])].some((t) => getComputedStyle(t).display !== "none") };
    app.eventBus.dispatch("switchannotationeditormode", { source: app, mode: 0 });
    return out;
  }, { note: N2, id: forced.ed });
  check(forced.found && forced.selected, "L2 the locked marking is selected with pdf.js's Highlight tool", JSON.stringify(forced));
  check(after.alive && after.text === N2 && after.color === forced.color && !after.dialog && !after.bar,
    "L2 delete, Delete key, colour, comment box, delete comment, ↶ and Ctrl+Z all refused; no colour or delete bar", JSON.stringify(after));
  await wait(4000);
  check(count(doc.pdf, N1) === 1 && count(doc.pdf, N2) === 1, "L2 the saved file still holds both notes", `${count(doc.pdf, N1)} / ${count(doc.pdf, N2)}`);
  const onPage = await shown(page);
  check(onPage.includes(N1) && onPage.includes(N2), "L2 the page still shows both notes", onPage.replace(/\n/g, " | "));

  // ---- L3 ---------------------------------------------------------------------------------------------------
  await comment(page, "Delta", N3, { close: false });
  const greyed = await page.evaluate(() => { const b = document.getElementById("commentManagerApplyButton"); return !!b && !b.hidden && b.disabled; });
  check(greyed, "L3 the comment box's Apply is greyed while a round runs");
  await page.click("#commentManagerSaveButton");
  await wait(800);
  check(!isRobot(await icon("Delta")), "L3 a note made during the round keeps its plain icon", JSON.stringify(await icon("Delta")));
  await press(await box("Delta"));
  await wait(1000);
  check((await state()).tools, "L3 its tools open", JSON.stringify(await state()));
  await closeAll();
  check(await until(() => count(doc.pdf, N3) === 1, 30000), "L3 it is saved");

  // ---- L4 ---------------------------------------------------------------------------------------------------
  check((await state()).locked > 0, "L4 still locked before the rebuild", JSON.stringify(await state()));
  rebuild(doc, { from: "Echo closes", to: "Echo closes the page, rebuilt by the round." });
  check(await until(async () => {
    const s = await state();
    return !s.applying && s.locked === 0 && (await page.evaluate(() => document.querySelector("#viewer").textContent.includes("rebuilt by the round")));
  }, 60000), "L4 the rebuilt PDF arrives and the round ends", JSON.stringify(await state()));
  await wait(1500);
  for (const w of ["Alpha", "Charlie"]) check(!isRobot(await icon(w)), `L4 ${w}'s icon is plain again`, JSON.stringify(await icon(w)));
  await press(await box("Alpha"));
  await wait(1000);
  check((await state()).tools, "L4 a tap on a note that was locked opens its tools", JSON.stringify(await state()));
  await closeAll();

  // ---- L5 ---------------------------------------------------------------------------------------------------
  await comment(page, "Bravo", N4, { close: false });
  const order = await page.evaluate(() => [...document.querySelector("#commentManagerDialog .dialogButtonsGroup").children]
    .filter((b) => !b.hidden && getComputedStyle(b).display !== "none").map((b) => b.id));
  check(JSON.stringify(order) === JSON.stringify(["commentManagerCancelButton", "commentManagerApplyButton", "commentManagerSaveButton"]),
    "L5 the box shows Cancel, Apply, Done", JSON.stringify(order));
  const inBox = await page.evaluate(() => { const r = document.getElementById("commentManagerApplyButton").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width > 0; });
  check(inBox, "L5 Apply is on screen");
  if (PHONE) await page.tap("#commentManagerApplyButton"); else await page.click("#commentManagerApplyButton");
  check(await until(async () => wakes.length === 2 && (await state()).applying, 40000), "L5 the box's Apply woke the chat and is thinking", `${wakes.length} wakes`);
  check(!(await state()).dialog, "L5 the box closed");
  check((wakes[1] ?? "").includes(N4), "L5 the file held the new note when the chat was woken");
  await wait(1000);
  check(isRobot(await icon("Bravo")) && isRobot(await icon("Alpha")), "L5 the new note is locked with the others",
    JSON.stringify([await icon("Bravo"), await icon("Alpha")]));
  rebuild(doc, { from: "Echo closes", to: "Echo closes the page, rebuilt a second time." });
  check(await until(async () => {
    const s = await state();
    return !s.applying && s.locked === 0 && (await page.evaluate(() => document.querySelector("#viewer").textContent.includes("rebuilt a second time")));
  }, 60000), "L5 the second round ends with its rebuild", JSON.stringify(await state()));

  // ---- L6 ---------------------------------------------------------------------------------------------------
  await wait(1500);
  fail = true;
  await page.evaluate(() => document.getElementById("redoDocument").click());
  check(await until(() => wakes.length === 3, 30000), "L6 the third wake was tried");
  await wait(1000);
  const s6 = await state();
  check(s6.locked === 0 && !isRobot(await icon("Alpha")) && !s6.applying, "L6 a failed wake leaves nothing locked", JSON.stringify(s6));
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
