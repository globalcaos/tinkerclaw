// Contract 4: no network, then network again; the pdf-review server restarting in the middle of a save. The marks
// stay on the device (and on the page) and reach the Pi by themselves once it answers, each exactly once.
//   MODE=desktop|phone node test/contract-4-network.mjs
import { testServer, makeDoc, count, launch, context, open, comment, shown, holdSaves, waitingOnDevice, check, finish, until, wait, PHONE } from "./contract-lib.mjs";

const srv = testServer("c4", 18854 + (PHONE ? 100 : 0));
await srv.start();
const doc = makeDoc(srv);
const browser = await launch();
const errors = [];
const N1 = "mark made with no network", N2 = "second mark with no network", N3 = "mark whose save met a server restart";
try {
  const ctx = await context(browser);
  const page = await open(ctx, doc.url, errors);

  // no network at all
  await ctx.setOffline(true);
  await comment(page, "Alpha", N1);
  await comment(page, "Charlie", N2);
  await wait(4000);
  check((await waitingOnDevice(page)) >= 1 && count(doc.pdf, N1) === 0, "with no network the marks wait on the device");
  check((await shown(page)).includes(N2), "and the page shows them");
  await ctx.setOffline(false);
  for (const n of [N1, N2]) check(await until(() => count(doc.pdf, n) === 1, 45000), `"${n}" reaches the Pi once the network is back`, `found ${count(doc.pdf, n)}`);

  // the server restarts while a save is on its way
  const gate = await holdSaves(page);
  await comment(page, "Delta", N3);
  await until(() => gate.held > 0, 15000);
  await srv.stop();
  gate.release(); // the held PUT now meets a closed port
  await gate.stop();
  await wait(3000);
  check(count(doc.pdf, N3) === 0 && (await waitingOnDevice(page)) >= 1, "while the server is down the mark waits on the device");
  await srv.start();
  check(await until(() => count(doc.pdf, N3) === 1, 45000), "after the restart the mark reaches the Pi once", `found ${count(doc.pdf, N3)}`);
  check([N1, N2].every((n) => count(doc.pdf, n) === 1), "the earlier marks are still there once");
  await until(async () => (await waitingOnDevice(page)) === 0, 20000);
  check((await waitingOnDevice(page)) === 0, "nothing left waiting on the device");
  const onPage = await shown(page);
  check([N1, N2, N3].every((n) => onPage.includes(n)), "the page shows every mark", onPage.replace(/\n/g, " | "));
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
