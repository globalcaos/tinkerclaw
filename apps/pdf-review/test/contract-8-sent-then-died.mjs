// Contract 8 (2026-11-18): a page whose first marks reached the Pi, then made one more and died before that one was
// sent. The first send removed the journal's copy of the version the marks were made on (the base), and the page never
// stored it again, so the last record could not be sent: on the next open the journal crashed before any save, and
// every Apply of that file was held, "until your marks reach the Pi" (ch09, 2026-11-18 05:56 to 06:17).
// Three cases, each in its own browser (its own journal):
//   kept       the record as this viewer writes it now: it reaches the Pi on the next open;
//   repaired   a record already written without its base (by an older viewer): rebuilt from the file the page opens;
//   rebuilt    the same, but the file was rebuilt meanwhile, so the base can never come back: the record must not
//              hold Apply, and its marks go to the Pi anyway (carried, or kept under state/refused/).
//   MODE=desktop|phone node test/contract-8-sent-then-died.mjs
import { readdirSync } from "node:fs";
import { testServer, makeDoc, count, launch, context, open, comment, waitingOnDevice, check, finish, until, wait, rebuild, readFileSync } from "./contract-lib.mjs";
import { PHONE } from "./contract-lib.mjs";

const srv = testServer("c8", 18858 + (PHONE ? 100 : 0));
await srv.start();
const browser = await launch();

// What a viewer before 2026-11-18 could leave on the device: a record whose base is gone.
const dropBases = () => new Promise((resolve, reject) => {
  const r = indexedDB.open("pdfreview-journal");
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const d = r.result, tx = d.transaction("bases", "readwrite");
    tx.objectStore("bases").clear();
    tx.oncomplete = () => { d.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
});

/** Every file the server kept under state/refused/ that holds `note`. */
const refusedWith = (note) => {
  try {
    return readdirSync(`${srv.state}/refused`).filter((f) => f.endsWith(".bin") && readFileSync(`${srv.state}/refused/${f}`).includes(note)).length;
  } catch { return 0; }
};

async function sentThenDied(name, { oldViewer = false, rebuilt = false } = {}) {
  const A = `${name}: first mark, reached the Pi`, B = `${name}: second mark, the page died first`;
  const doc = makeDoc(srv, name);
  const ctx = await context(browser);
  const errors = [];
  const watch = (page) => page.on("console", (m) => { if (m.type() === "error" && /\[(journal|save|redo)\]/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  let redos = 0;
  ctx.on("request", (r) => { if (/\/api\/redo/.test(r.url())) redos++; });
  try {
    let page = await open(ctx, doc.url, errors);
    watch(page);
    await comment(page, "Alpha", A);
    check(await until(() => count(doc.pdf, A) === 1, 30000), `${name}: the first mark reaches the Pi`);
    check(await until(async () => (await waitingOnDevice(page)) === 0, 20000), `${name}: and leaves the device`);

    const cut = (route) => route.abort("internetdisconnected");
    await ctx.route(/\/api\/save/, cut);
    await comment(page, "Charlie", B);
    await wait(2500);
    check((await waitingOnDevice(page)) >= 1, `${name}: the second mark waits on the device`);
    if (oldViewer) await page.evaluate(dropBases);
    await page.close({ runBeforeUnload: false });
    await ctx.unroute(/\/api\/save/, cut);
    if (rebuilt) rebuild(doc, { to: "Bravo is rewritten by the agent while the phone was away, so the old version is gone." });

    page = await open(ctx, doc.url, errors);
    watch(page);
    if (rebuilt) {
      const there = await until(() => count(doc.pdf, B) === 1 || refusedWith(B) > 0, 40000);
      check(there, `${name}: the second mark is on the Pi, carried or kept under state/refused/`, `in file ${count(doc.pdf, B)}, refused ${refusedWith(B)}`);
    } else {
      check(await until(() => count(doc.pdf, B) === 1, 40000), `${name}: the second mark reaches the Pi once`, `found ${count(doc.pdf, B)}`);
      check(count(doc.pdf, A) === 1, `${name}: the first mark is there once`, `found ${count(doc.pdf, A)}`);
    }
    check(await until(async () => (await waitingOnDevice(page)) === 0, 30000), `${name}: nothing left waiting on the device`);

    const before = redos;
    await page.evaluate(() => document.getElementById("redoDocument").click());
    check(await until(() => redos > before, 30000), `${name}: Apply wakes the chat`, `redo requests ${redos - before}`);
    check(!errors.length, `${name}: no journal, save or page errors`, errors.join(" | "));
  } finally {
    await ctx.close();
  }
}

try {
  await sentThenDied("kept");
  await sentThenDied("repaired", { oldViewer: true });
  await sentThenDied("rebuilt", { oldViewer: true, rebuilt: true });
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
