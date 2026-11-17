// Contract 6: the laptop and the phone mark the same chapter at the same time. Neither overwrites the other: every
// mark of both ends in the file exactly once, and each device ends up showing both sets.
//   node test/contract-6-two-devices.mjs     (one run: a laptop page and a phone page together)
import { testServer, makeDoc, count, launch, context, open, comment, shown, holdSaves, waitingOnDevice, check, finish, until, wait } from "./contract-lib.mjs";

const srv = testServer("c6", 18856);
await srv.start();
const doc = makeDoc(srv);
const browser = await launch();
const errors = [];
const L1 = "laptop mark one", P1 = "phone mark one", L2 = "laptop mark two", P2 = "phone mark two";
try {
  const laptop = await open(await context(browser, "desktop"), doc.url, errors);
  const phone = await open(await context(browser, "phone"), doc.url, errors);

  // at the same moment, each from the version both loaded
  await Promise.all([comment(laptop, "Alpha", L1), comment(phone, "Charlie", P1)]);
  for (const n of [L1, P1]) check(await until(() => count(doc.pdf, n) === 1, 40000), `"${n}" is in the file once`, `found ${count(doc.pdf, n)}`);

  // the phone's next save is slow (mobile data); the laptop saves meanwhile
  const gate = await holdSaves(phone);
  await comment(phone, "Echo", P2);
  await until(() => gate.held > 0, 15000);
  await comment(laptop, "Delta", L2);
  check(await until(() => count(doc.pdf, L2) === 1, 30000), "the laptop's mark lands while the phone's save is on its way");
  gate.release();
  await gate.stop();
  check(await until(() => count(doc.pdf, P2) === 1, 40000), "the phone's slow save lands too", `found ${count(doc.pdf, P2)}`);
  const all = [L1, P1, L2, P2];
  check(all.every((n) => count(doc.pdf, n) === 1), "every mark of both devices is in the file exactly once", all.map((n) => count(doc.pdf, n)).join(" "));

  for (const [name, page] of [["laptop", laptop], ["phone", phone]]) {
    const ok = await until(async () => (await waitingOnDevice(page)) === 0 && all.every((n) => n), 30000) &&
      await until(async () => { const s = await shown(page); return all.every((n) => s.includes(n)); }, 40000);
    check(ok, `the ${name} ends up showing both sets`, (await shown(page)).replace(/\n/g, " | "));
  }
  check(all.every((n) => count(doc.pdf, n) === 1), "and still once each after both pages settled", all.map((n) => count(doc.pdf, n)).join(" "));
  check(!errors.length, "no page errors", errors.join(" | "));
} catch (err) {
  check(false, "the test ran", String(err.stack || err));
} finally {
  await browser.close();
  await srv.stop();
}
finish();
