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
//                         Rebuild ONLY if upstream whatsmeow has moved — the script
//                         compares the embedded and latest versions and says so.
//
// Usage: node scripts/whatsmeow-selftest.mjs [--binary /path/to/whatsmeow-node]
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * Resolve the binary the GATEWAY actually runs, not merely the bundled one.
 *
 * 2026-09-03: running this with no argument tested node_modules (whatsmeow
 * 2026-03-22) and reported err-client-outdated, while the deployed binary passed
 * fine. The wrong-binary answer looked exactly like a real outage. The override
 * lives in a systemd drop-in, so it is NOT in an interactive shell's environment
 * — read it from there before falling back to the vendored copy.
 */
function gatewayConfiguredBinary() {
  try {
    const dir = `${process.env.HOME}/.config/systemd/user/openclaw-gateway.service.d`;
    for (const f of fs.readdirSync(dir)) {
      const m = fs
        .readFileSync(`${dir}/${f}`, "utf-8")
        .match(/^Environment=OPENCLAW_WHATSMEOW_BINARY=(.+)$/m);
      if (m && fs.existsSync(m[1].trim())) return m[1].trim();
    }
  } catch {
    /* not systemd-managed here */
  }
  return null;
}

const argIdx = process.argv.indexOf("--binary");
const EXPLICIT = argIdx > -1 ? process.argv[argIdx + 1] : process.env.OPENCLAW_WHATSMEOW_BINARY;
const CONFIGURED = gatewayConfiguredBinary();
const BIN =
  EXPLICIT ??
  CONFIGURED ??
  (() => {
    const require = createRequire(import.meta.url);
    return require.resolve(
      `@whatsmeow-node/${process.platform}-${process.arch}/bin/whatsmeow-node`,
    );
  })();

/** whatsmeow module version baked into a built binary, or null. */
async function currentWhatsmeowVersion(binPath) {
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("strings", ["-n", "8", binPath], {
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf-8",
    });
    const m = out.match(/go\.mau\.fi\/whatsmeow@(v[0-9.]+-[0-9]{14}-[a-f0-9]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Newest published whatsmeow pseudo-version, or null when offline. */
async function latestWhatsmeowVersion() {
  try {
    const ctl = AbortSignal.timeout(15000);
    const r = await fetch("https://proxy.golang.org/go.mau.fi/whatsmeow/@latest", { signal: ctl });
    if (!r.ok) return null;
    return (await r.json())?.Version ?? null;
  } catch {
    return null;
  }
}

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "whatsmeow-selftest-"));
const t0 = Date.now();
const log = (...a) => console.log(String(Date.now() - t0).padStart(6) + "ms", ...a);

log("binary:", BIN);
if (!EXPLICIT && CONFIGURED && CONFIGURED === BIN) {
  log("  (from the gateway's systemd drop-in — this is what actually runs)");
} else if (!EXPLICIT && !CONFIGURED) {
  log("  WARNING: testing the VENDORED node_modules binary. If the gateway runs an");
  log("  override, this result says nothing about the live channel.");
}
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
  console.log("       Relinking cannot fix this: WhatsApp refuses to issue a QR at all.");
  // A rebuild only helps if upstream whatsmeow has actually moved. On 2026-09-03 this
  // check would have saved a pointless rebuild: the binary already carried the newest
  // upstream commit, so `build-whatsmeow-node.sh` would have produced an identical file.
  const embedded = await currentWhatsmeowVersion(BIN);
  const latest = await latestWhatsmeowVersion();
  console.log("       binary whatsmeow : " + (embedded ?? "unknown"));
  console.log("       latest upstream  : " + (latest ?? "unknown (offline?)"));
  if (embedded && latest && embedded === latest) {
    console.log("       => REBUILDING WILL NOT HELP — you are already on the newest upstream.");
    console.log("          Wait for go.mau.fi/whatsmeow to ship support, then rerun this.");
    console.log("          An ALREADY-PAIRED session keeps working; only re-pairing fails.");
  } else if (embedded && latest) {
    console.log("       => a newer whatsmeow exists: run scripts/build-whatsmeow-node.sh");
  } else {
    console.log("       => could not compare versions; check upstream before rebuilding.");
  }
  process.exit(1);
}
console.log("FAIL — no QR and no diagnostic event" + (verdict ? " (" + verdict + ")" : "") + ".");
process.exit(1);
