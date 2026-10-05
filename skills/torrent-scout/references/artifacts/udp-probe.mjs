import crypto from "node:crypto";
// BEP 15 UDP tracker liveness probe + DNS resolution map.
// Usage: node udp-probe.mjs <file-with-tracker-urls>
import dgram from "node:dgram";
import dns from "node:dns/promises";
import fs from "node:fs";

const PROTOCOL_ID = 0x41727101980n; // magic connect constant, BEP 15
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_SCRAPE = 2;
const ACTION_ERROR = 3;

function connectRequest(txid) {
  const b = Buffer.alloc(16);
  b.writeBigUInt64BE(PROTOCOL_ID, 0);
  b.writeUInt32BE(ACTION_CONNECT, 8);
  txid.copy(b, 12);
  return b;
}

function announceRequest(connId, txid, infoHash, peerId) {
  const b = Buffer.alloc(98);
  connId.copy(b, 0); // 0  connection_id  (int64)
  b.writeUInt32BE(ACTION_ANNOUNCE, 8); // 8  action = 1
  txid.copy(b, 12); // 12 transaction_id
  infoHash.copy(b, 16); // 16 info_hash (20)
  peerId.copy(b, 36); // 36 peer_id   (20)
  b.writeBigUInt64BE(0n, 56); // 56 downloaded
  b.writeBigUInt64BE(0n, 64); // 64 left
  b.writeBigUInt64BE(0n, 72); // 72 uploaded
  b.writeUInt32BE(2, 80); // 80 event = 2 (started)
  b.writeUInt32BE(0, 84); // 84 IP = 0 -> use packet source
  b.writeUInt32BE(crypto.randomInt(2 ** 31), 88); // 88 key
  b.writeInt32BE(-1, 92); // 92 num_want = -1 (default)
  b.writeUInt16BE(6881, 96); // 96 port
  return b;
}

function scrapeRequest(connId, txid, infoHash) {
  const b = Buffer.alloc(36);
  connId.copy(b, 0);
  b.writeUInt32BE(ACTION_SCRAPE, 8);
  txid.copy(b, 12);
  infoHash.copy(b, 16);
  return b;
}

function sendRecv(sock, host, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.removeListener("message", onMsg);
      reject(new Error("timeout"));
    }, timeoutMs);
    const onMsg = (msg) => {
      clearTimeout(t);
      sock.removeListener("message", onMsg);
      resolve(msg);
    };
    sock.on("message", onMsg);
    sock.send(payload, port, host, (err) => {
      if (err) {
        clearTimeout(t);
        reject(err);
      }
    });
  });
}

export async function probe(url, { timeoutMs = 4000 } = {}) {
  const u = new URL(url);
  const host = u.hostname,
    port = Number(u.port);
  const t0 = Date.now();
  let ips = [];
  try {
    const recs = await dns.lookup(host, { all: true });
    ips = recs.map((r) => r.address);
  } catch (e) {
    return {
      url,
      host,
      port,
      ok: false,
      stage: "dns",
      error: e.code || e.message,
      ips: [],
      ms: Date.now() - t0,
    };
  }
  if (!ips.length)
    return {
      url,
      host,
      port,
      ok: false,
      stage: "dns",
      error: "NODATA",
      ips: [],
      ms: Date.now() - t0,
    };

  const v4 = ips.find((a) => !a.includes(":")) || ips[0];
  const sock = dgram.createSocket(v4.includes(":") ? "udp6" : "udp4");
  try {
    const txid1 = crypto.randomBytes(4);
    const resp = await sendRecv(sock, v4, port, connectRequest(txid1), timeoutMs);
    if (resp.length < 16) throw new Error(`short connect resp ${resp.length}`);
    const action = resp.readUInt32BE(0);
    if (!resp.subarray(4, 8).equals(txid1)) throw new Error("txid mismatch");
    if (action === ACTION_ERROR)
      throw new Error("tracker error: " + resp.subarray(8).toString("utf8"));
    if (action !== ACTION_CONNECT) throw new Error("unexpected action " + action);
    const connId = resp.subarray(8, 16);

    const txid2 = crypto.randomBytes(4);
    const infoHash = crypto.randomBytes(20);
    const peerId = Buffer.from("-qB4390-" + crypto.randomBytes(6).toString("hex"), "ascii");
    const ar = await sendRecv(
      sock,
      v4,
      port,
      announceRequest(connId, txid2, infoHash, peerId),
      timeoutMs,
    );
    if (ar.length < 8) throw new Error(`short announce resp ${ar.length}`);
    const a2 = ar.readUInt32BE(0);
    if (!ar.subarray(4, 8).equals(txid2)) throw new Error("announce txid mismatch");
    if (a2 === ACTION_ERROR) throw new Error("announce error: " + ar.subarray(8).toString("utf8"));
    if (a2 !== ACTION_ANNOUNCE || ar.length < 20)
      throw new Error("bad announce resp action=" + a2 + " len=" + ar.length);
    const out = {
      url,
      host,
      port,
      ok: true,
      stage: "announce",
      ips,
      ip: v4,
      interval: ar.readInt32BE(8),
      leechers: ar.readInt32BE(12),
      seeders: ar.readInt32BE(16),
      peers: Math.max(0, (ar.length - 20) / 6),
      ms: Date.now() - t0,
    };
    return out;
  } catch (e) {
    return {
      url,
      host,
      port,
      ok: false,
      stage: "udp",
      error: e.message,
      ips,
      ip: v4,
      ms: Date.now() - t0,
    };
  } finally {
    try {
      sock.close();
    } catch {}
  }
}

const file = process.argv[2];
if (file) {
  const urls = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("udp://"));
  const CONC = 24;
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (i < urls.length) {
        const n = i++;
        results[n] = await probe(urls[n]);
      }
    }),
  );
  console.log(JSON.stringify(results, null, 0));
}
