#!/usr/bin/env node
// swarm-check.mjs — ask the TRACKERS how many seeders there really are.
//
// Indexer seeder counts are CLAIMS, often stale and sometimes invented.
// Measured 2026-09-06: a listing advertising 20 seeders had 2. Every other
// candidate for the same title also advertised numbers it did not have.
// Swarm health is the one ranking input a user can be actively misled about,
// and it is the one that decides whether a download finishes at all — so it is
// worth one UDP round-trip to replace the claim with a measurement.
//
// Uses the BEP-15 UDP scrape: connect handshake, then scrape. No announce, so
// we do not join the swarm and no peer sees us.
//
// Usage: node scripts/swarm-check.mjs [n|all] [--json]

import crypto from "node:crypto";
import dgram from "node:dgram";
import { loadSearch, saveSearch } from "../lib/config.mjs";

const TRACKERS = [
  ["tracker.opentrackr.org", 1337],
  ["open.stealth.si", 80],
  ["tracker.torrent.eu.org", 451],
];
const PROTOCOL_ID = 0x41727101980n;

function udpScrape(host, port, infoHash, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        try {
          sock.close();
        } catch {}
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const txId = crypto.randomBytes(4);
    const connReq = Buffer.alloc(16);
    connReq.writeBigUInt64BE(PROTOCOL_ID, 0);
    connReq.writeUInt32BE(0, 8);
    txId.copy(connReq, 12);

    sock.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    sock.on("message", (msg) => {
      if (msg.length >= 16 && msg.readUInt32BE(0) === 0) {
        const connId = msg.subarray(8, 16);
        const tx2 = crypto.randomBytes(4);
        const scrapeReq = Buffer.concat([
          connId,
          Buffer.from([0, 0, 0, 2]),
          tx2,
          Buffer.from(infoHash, "hex"),
        ]);
        sock.send(scrapeReq, port, host);
      } else if (msg.length >= 20 && msg.readUInt32BE(0) === 2) {
        clearTimeout(timer);
        finish({
          seeders: msg.readUInt32BE(8),
          completed: msg.readUInt32BE(12),
          leechers: msg.readUInt32BE(16),
        });
      }
    });
    sock.send(connReq, port, host, (e) => {
      if (e) {
        clearTimeout(timer);
        finish(null);
      }
    });
  });
}

/** Best (highest) reading across trackers — a tracker that has never seen the
 *  torrent legitimately reports zero, so the max is the honest aggregate. */
export async function measureSwarm(infoHash) {
  const results = await Promise.all(TRACKERS.map(([h, p]) => udpScrape(h, p, infoHash)));
  const ok = results.filter(Boolean);
  if (!ok.length) return null;
  return ok.reduce((a, b) => (b.seeders > a.seeders ? b : a));
}

const magnetHash = (m) => (m ? (m.match(/btih:([a-fA-F0-9]{40})/) || [])[1] : null);

/**
 * Some indexers expose neither a magnet nor a working .torrent proxy — only a
 * link to their own listing page, which does carry the magnet. Reading that
 * page is a plain HTTPS GET of a URL the indexer itself handed us; it is not a
 * hardcoded site, so this stays generic across indexers.
 */
async function hashFromPage(pageUrl, timeoutMs = 25000) {
  if (!pageUrl) return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(pageUrl, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return (html.match(/btih:([a-fA-F0-9]{40})/i) || [])[1]?.toLowerCase() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const which = args.find((a) => !a.startsWith("--")) || "all";
  const state = loadSearch();
  if (!state) {
    console.error("No search state. Run search.mjs first.");
    process.exit(2);
  }

  const targets = which === "all" ? state.kept : [state.kept[Number(which) - 1]].filter(Boolean);
  const out = [];
  for (const c of targets) {
    let ih = (c.infoHash || magnetHash(c.magnet) || "").toLowerCase();
    const idx = state.kept.indexOf(c) + 1;
    if (!ih) {
      ih = (await hashFromPage(c.pageUrl)) || "";
      if (ih) {
        c.infoHash = ih;
        c.magnet = c.magnet || `magnet:?xt=urn:btih:${ih}&dn=${encodeURIComponent(c.title)}`;
      }
    }
    if (!ih) {
      out.push({
        n: idx,
        title: c.title,
        claimed: c.seeders,
        real: null,
        note: "no infohash anywhere — cannot verify",
      });
      continue;
    }
    const m = await measureSwarm(ih);
    if (m) {
      c.measuredSeeders = m.seeders;
      c.measuredLeechers = m.leechers;
    }
    out.push({
      n: idx,
      title: c.title,
      claimed: c.seeders,
      real: m ? m.seeders : null,
      leechers: m ? m.leechers : null,
    });
  }
  saveSearch(state);

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`\n  #  claimed   real  leech   title`);
  for (const r of out) {
    const mark = r.real === null ? " ?" : r.real === 0 ? " DEAD" : r.real < 5 ? " thin" : "";
    console.log(
      `  ${String(r.n).padStart(2)}  ${String(r.claimed ?? "—").padStart(7)}  ${String(r.real ?? "—").padStart(5)}  ${String(r.leechers ?? "—").padStart(5)}   ${r.title.slice(0, 46)}${mark}`,
    );
  }
  const lied = out.filter((r) => r.real !== null && r.claimed != null && r.claimed > r.real * 2);
  if (lied.length)
    console.log(
      `\n  ${lied.length} listing(s) advertise more than twice the seeders they have. Rank on the measured column.`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
