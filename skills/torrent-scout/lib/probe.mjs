import crypto from "node:crypto";
// probe.mjs — "does this thing answer?", for each kind of thing.
//
// One rule shapes every prober here: ASK THE QUESTION THE PROTOCOL IS FOR.
// A tracker that answers `announce` in 659 ms can time out on `scrape`
// (open.demonii.com does exactly this), so probing with scrape would file a
// working tracker as dead. Liveness is measured with the request a downloader
// actually makes.
//
// Second rule: liveness is measured FROM HERE. A tracker "live" on someone
// else's dashboard may be unreachable from this network, which is why the map
// stores our own probe results rather than importing a third party's verdict.
import dgram from "node:dgram";
import dns from "node:dns/promises";

// BEP 15: the protocol-defined magic connection id, 0x41727101980, as two
// 32-bit halves because JS bitwise ops stop at 32 bits.
const MAGIC_HI = 0x417;
const MAGIC_LO = 0x27101980;

export function parseTrackerUrl(raw) {
  const s = String(raw).trim();
  if (!s || s.startsWith("#")) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(":", "");
  if (!["udp", "http", "https", "ws", "wss"].includes(scheme)) return null;
  const port = u.port
    ? Number(u.port)
    : scheme === "udp"
      ? 80
      : scheme === "https" || scheme === "wss"
        ? 443
        : 80;
  return {
    id: `${scheme}://${u.hostname}:${port}${u.pathname === "/" ? "" : u.pathname}`,
    scheme,
    host: u.hostname,
    port,
    path: u.pathname || "/announce",
    raw: s,
  };
}

/** UDP tracker connect handshake (BEP 15). Alive == it returns our transaction id. */
export function udpConnect(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let sock;
    try {
      sock = dgram.createSocket("udp4");
    } catch (e) {
      return resolve({ ok: false, error: String(e) });
    }
    const tx = crypto.randomBytes(4);
    const req = Buffer.alloc(16);
    req.writeUInt32BE(MAGIC_HI, 0);
    req.writeUInt32BE(MAGIC_LO, 4);
    req.writeUInt32BE(0, 8); // action 0 = connect
    tx.copy(req, 12);
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    sock.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.code || String(e) });
    });
    sock.on("message", (msg) => {
      clearTimeout(timer);
      if (msg.length < 16) return finish({ ok: false, error: `short reply ${msg.length}b` });
      if (msg.readUInt32BE(0) !== 0)
        return finish({ ok: false, error: `action ${msg.readUInt32BE(0)}` });
      if (!msg.subarray(4, 8).equals(tx))
        return finish({ ok: false, error: "transaction mismatch" });
      finish({ ok: true, latencyMs: Date.now() - started, connectionId: msg.subarray(8, 16) });
    });
    sock.send(req, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        finish({ ok: false, error: err.code || String(err) });
      }
    });
  });
}

/** UDP scrape (action 2) — seeders/leechers for up to 74 infohashes at once. */
export function udpScrape(host, port, hashesHex, timeoutMs = 5000) {
  return new Promise(async (resolve) => {
    const conn = await udpConnect(host, port, timeoutMs);
    if (!conn.ok) return resolve({ ok: false, error: conn.error });
    const sock = dgram.createSocket("udp4");
    const tx = crypto.randomBytes(4);
    const hashes = hashesHex.slice(0, 74).map((h) => Buffer.from(h, "hex"));
    const req = Buffer.concat([
      conn.connectionId,
      Buffer.from([0, 0, 0, 2]), // action 2 = scrape
      tx,
      ...hashes,
    ]);
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
    sock.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.code || String(e) });
    });
    sock.on("message", (msg) => {
      clearTimeout(timer);
      if (msg.length < 8 || msg.readUInt32BE(0) !== 2)
        return finish({ ok: false, error: "bad scrape reply" });
      const out = {};
      for (let i = 0; i * 12 + 8 + 12 <= msg.length; i++) {
        const off = 8 + i * 12;
        out[hashesHex[i]] = {
          seeders: msg.readUInt32BE(off),
          completed: msg.readUInt32BE(off + 4),
          leechers: msg.readUInt32BE(off + 8),
        };
      }
      finish({ ok: true, swarms: out });
    });
    sock.send(req, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        finish({ ok: false, error: err.code || String(err) });
      }
    });
  });
}

/** HTTP(S) tracker: a real announce. A bencoded reply — even a failure reason —
 *  proves a tracker is there; an HTML page proves it is something else now. */
export async function httpAnnounce(node, timeoutMs = 6000) {
  const started = Date.now();
  const ih = crypto.randomBytes(20);
  const pid = Buffer.concat([Buffer.from("-TS0001-"), crypto.randomBytes(12)]);
  const esc = (b) =>
    Array.from(b)
      .map((c) =>
        (c >= 0x30 && c <= 0x39) ||
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        "-_.~".includes(String.fromCharCode(c))
          ? String.fromCharCode(c)
          : `%${c.toString(16).padStart(2, "0")}`,
      )
      .join("");
  const path = node.path && node.path !== "/" ? node.path : "/announce";
  const url =
    `${node.scheme}://${node.host}:${node.port}${path}` +
    `?info_hash=${esc(ih)}&peer_id=${esc(pid)}&port=6881` +
    "&uploaded=0&downloaded=0&left=0&compact=1&event=started";
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { "user-agent": "torrent-scout/1.0" },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const bencoded = buf[0] === 0x64; // 'd' — a bencoded dict
    return {
      ok: bencoded,
      latencyMs: Date.now() - started,
      status: res.status,
      error: bencoded ? null : `HTTP ${res.status}, ${buf.length}b non-bencode`,
    };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : e.cause?.code || e.message };
  } finally {
    clearTimeout(t);
  }
}

/** A web surface: is it there, where does it end up, and what is it called? */
export async function httpSite(url, timeoutMs = 12000) {
  const started = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    const body = (await res.text()).slice(0, 200000);
    const title = (body.match(/<title[^>]*>([\s\S]{0,180}?)<\/title>/i)?.[1] || "")
      .trim()
      .replace(/\s+/g, " ");
    // A 200 that is a captcha or a parking page is NOT the site being up; the
    // title is the cheapest way to tell those apart without a browser.
    const blocked = /just a moment|attention required|cloudflare|captcha|are you human/i.test(
      title,
    );
    const parked = /domain (is )?for sale|buy this domain|parked/i.test(
      title + body.slice(0, 2000),
    );
    return {
      ok: res.ok && !blocked && !parked,
      status: res.status,
      finalUrl: res.url,
      title,
      latencyMs: Date.now() - started,
      error: blocked
        ? "challenge/captcha"
        : parked
          ? "parked domain"
          : res.ok
            ? null
            : `HTTP ${res.status}`,
      bodyLen: body.length,
    };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : e.cause?.code || e.message };
  } finally {
    clearTimeout(t);
  }
}

export async function resolveHost(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host];
  const out = [];
  try {
    out.push(...(await dns.resolve4(host)));
  } catch {}
  if (!out.length) {
    try {
      out.push(...(await dns.resolve6(host)));
    } catch {}
  }
  return out;
}

/** Bounded concurrency. Probing 300 trackers 40-at-a-time is the difference
 *  between a 20-second scan and a 20-minute one. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: String(e) };
        }
      }
    }),
  );
  return out;
}
