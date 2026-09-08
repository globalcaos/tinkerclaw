import crypto from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns/promises";
const PROTOCOL_ID = 0x41727101980n;
function rr(sock, h, p, buf, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    sock.once("message", (m) => {
      clearTimeout(t);
      res(m);
    });
    sock.send(buf, p, h);
  });
}
const url = new URL(process.argv[2]);
const ih = Buffer.from(process.argv[3], "hex");
const { address } = await dns.lookup(url.hostname, { family: 4 });
const s = dgram.createSocket("udp4");
const tx = crypto.randomBytes(4);
const c = Buffer.alloc(16);
c.writeBigUInt64BE(PROTOCOL_ID, 0);
c.writeUInt32BE(0, 8);
tx.copy(c, 12);
const r1 = await rr(s, address, Number(url.port), c, 5000);
const cid = r1.subarray(8, 16);
const tx2 = crypto.randomBytes(4);
const sc = Buffer.alloc(36);
cid.copy(sc, 0);
sc.writeUInt32BE(2, 8);
tx2.copy(sc, 12);
ih.copy(sc, 16);
const r2 = await rr(s, address, Number(url.port), sc, 5000);
console.log(
  "ip",
  address,
  "action",
  r2.readUInt32BE(0),
  "txid_match",
  r2.subarray(4, 8).equals(tx2),
  "len",
  r2.length,
);
if (r2.readUInt32BE(0) === 2)
  console.log(
    "seeders",
    r2.readInt32BE(8),
    "completed",
    r2.readInt32BE(12),
    "leechers",
    r2.readInt32BE(16),
  );
else console.log("error:", r2.subarray(8).toString());
s.close();
