// whatsmeow-selftest.mjs — is the whatsmeow binary still accepted by WhatsApp?
//
// Uses a THROWAWAY store in a temp dir, never the live credentials, and never
// pairs anything. On a fresh store the correct sequence is
//     init -> getQRChannel -> connect
// (getQRChannel MUST precede connect or no QR is ever emitted — a probe that
// skips it sees silence and looks like a timeout).
//
//   QR RECEIVED        -> WhatsApp accepts this build; any outage is elsewhere
//   err-client-outdated-> WhatsApp rejects the build. Relinking CANNOT fix it.
//                         Run scripts/build-whatsmeow-node.sh.
//
// Usage: node scripts/whatsmeow-selftest.mjs [--binary /path/to/whatsmeow-node]
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const argIdx = process.argv.indexOf("--binary");
const BIN =
  (argIdx > -1 ? process.argv[argIdx + 1] : undefined) ??
  process.env.OPENCLAW_WHATSMEOW_BINARY ??
  (() => {
    const require = createRequire(import.meta.url);
    return require.resolve(
      `@whatsmeow-node/${process.platform}-${process.arch}/bin/whatsmeow-node`,
    );
  })();

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "whatsmeow-selftest-"));
const t0 = Date.now();
const log = (...a) => console.log(String(Date.now() - t0).padStart(6) + "ms", ...a);

log("binary:", BIN);
log("throwaway store:", STORE);

const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
let verdict = null;

const onLine = (line) => {
  let o = null;
  try {
    o = JSON.parse(line);
  } catch {
    log("RAW:", line.slice(0, 300));
    return;
  }
  // A QR payload is a pairing secret — report only that it arrived.
  if (o?.event === "qr") {
    verdict = verdict ?? "OK";
    log("EVENT qr  <QR RECEIVED — WhatsApp ACCEPTED this client>");
    return;
  }
  if (o?.event === "qr:error" || o?.event === "stream_error") {
    const inner = o?.data?.event ?? JSON.stringify(o?.data ?? {});
    if (String(inner).includes("outdated")) verdict = verdict ?? "OUTDATED";
    else verdict = verdict ?? "ERROR:" + inner;
    log("EVENT", o.event, String(inner).slice(0, 200));
    return;
  }
  log(JSON.stringify(o).slice(0, 300));
};

createInterface({ input: proc.stdout }).on("line", onLine);
createInterface({ input: proc.stderr }).on("line", onLine);

const send = (id, cmd, args) => proc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(600);
send("1", "init", { store: "file:" + path.join(STORE, "whatsmeow.db") });
await sleep(2000);
send("2", "getQRChannel", {});
await sleep(1200);
send("3", "connect", {});

for (let i = 0; i < 40 && !verdict; i++) await sleep(1000);

proc.kill();
fs.rmSync(STORE, { recursive: true, force: true });

console.log();
if (verdict === "OK") {
  console.log("PASS — WhatsApp issued a QR. This whatsmeow build is accepted.");
  process.exit(0);
}
if (verdict === "OUTDATED") {
  console.log("FAIL — err-client-outdated. WhatsApp rejects this build as too old.");
  console.log("       Relinking cannot fix this. Run scripts/build-whatsmeow-node.sh.");
  process.exit(1);
}
console.log("FAIL — no QR and no diagnostic event" + (verdict ? " (" + verdict + ")" : "") + ".");
process.exit(1);
