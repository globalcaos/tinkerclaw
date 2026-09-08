#!/usr/bin/env node
// relay-fetch.mjs — read an amazon.es search page THROUGH a shared, logged-in
// browser tab instead of over anonymous HTTP.
//
// Why (2026-08-06, the microSD run): anonymous HTTP is fine for price and title
// but STRUCTURALLY cannot answer "does it arrive tomorrow". Without an account
// and a postcode Amazon returns a pessimistic generic estimate — the same query
// showed "sáb, 8 de ago" over HTTP and "FREE delivery Tomorrow, 7 Aug" in the
// logged-in tab. Any delivery-sensitive question must come through the relay.
//
// WHAT THIS TOUCHES, stated plainly: it attaches to a browser tab that is logged
// into your Amazon account, navigates it, and reads the rendered HTML back. That
// is your live authenticated session. So:
//
//   * It is per-run OPT-IN. Without --yes it refuses and explains itself.
//   * It only ever drives an amazon.es tab, and only to an amazon.es URL.
//   * It executes a FIXED set of operations (navigate, readiness probe, capture
//     the results container in slices). Earlier versions exposed a general
//     "evaluate this JavaScript string in the page" primitive, which is arbitrary
//     code execution inside a logged-in session; there is no such entry point now.
//   * --list shows amazon.es tabs only. It used to print the title and URL of
//     EVERY tab you share, which is an inventory of your browsing that a shopping
//     task has no reason to collect.
//   * Writing captured HTML to a file prints a notice: that page was rendered for
//     your account and can carry your name, address and personalised prices.
//
// Usage:
//   node relay-fetch.mjs --yes --url "https://www.amazon.es/-/en/s?k=micro+sd+1tb" \
//                        --out /tmp/page.html [--settle 4000]
//   node relay-fetch.mjs --list

import fs from "node:fs";
import { assertAmazonPageUrl, UrlNotAllowed } from "./url-guard.mjs";

const RELAY_HTTP = "http://127.0.0.1:18792";
const WS = "ws://127.0.0.1:18792/cdp";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};

async function tabs() {
  const res = await fetch(`${RELAY_HTTP}/json/list`, { signal: AbortSignal.timeout(8000) });
  return res.json();
}

const isAmazonTab = (t) => /^https:\/\/(www\.)?amazon\.es\//i.test(t?.url || "");

/**
 * ONE CDP socket for the whole page capture.
 *
 * The first version spawned a helper once per evaluate — and a chunked capture is
 * a dozen evaluates, so a dozen fresh CDP connects per page. That is the
 * documented way to wedge this relay: it started refusing connections after the
 * second page every time. Hold a single connection and issue every call over it.
 *
 * #eval is PRIVATE on purpose. The only expressions it ever receives are the
 * literals in the named methods below; nothing reaches it from a CLI flag, a
 * listing, or a caller.
 */
class CdpSession {
  #ws = null;
  #id = 0;
  #pending = new Map();
  #sessionId = null;

  async open(targetId) {
    this.#ws = new WebSocket(WS);
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener("open", resolve, { once: true });
      this.#ws.addEventListener("error", () => reject(new Error("cdp connect failed")), {
        once: true,
      });
    });
    this.#ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    });
    const att = await this.#send("Target.attachToTarget", { targetId, flatten: true });
    this.#sessionId = att.sessionId;
  }

  #send(method, params, sessionId) {
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 60000);
    });
  }

  async #eval(expr) {
    const r = await this.#send(
      "Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true },
      this.#sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate threw");
    return r.result?.value;
  }

  // --- the complete action set. Nothing else is exposed. ---

  /** Navigate the tab. The URL is re-validated here, at the last moment before use. */
  async navigate(url) {
    const safe = assertAmazonPageUrl(url);
    await this.#eval(`location.href=${JSON.stringify(safe)}; "nav"`);
  }

  /** Readiness + result count + current location. No caller input. */
  async probe() {
    const raw = await this.#eval(
      `JSON.stringify({ready:document.readyState,n:document.querySelectorAll('[data-component-type="s-search-result"]').length,href:location.href})`,
    );
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  /** Stash the results container and return its length. */
  async stageCapture() {
    const raw = await this.#eval(
      `window.__ljcap=(document.getElementById('search')||document.documentElement).outerHTML; String(window.__ljcap.length)`,
    );
    return Number(typeof raw === "string" ? raw : String(raw));
  }

  /** Read one slice of the staged capture. Offsets are coerced to integers. */
  async captureSlice(offset, length) {
    const off = Math.max(0, Math.trunc(Number(offset) || 0));
    const end = off + Math.max(0, Math.trunc(Number(length) || 0));
    const piece = await this.#eval(`window.__ljcap.slice(${off}, ${end})`);
    return typeof piece === "string" ? piece : String(piece);
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await tabs();
  const amazonTabs = list.filter(isAmazonTab);

  if (argv.includes("--list")) {
    // amazon.es tabs only — the rest of what you have open is not this tool's business.
    console.log(
      JSON.stringify(
        amazonTabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        null,
        2,
      ),
    );
    return;
  }

  const url = flag("url");
  if (!url) {
    console.error("relay-fetch: --url is required (or --list to see shared amazon.es tabs).");
    process.exit(5);
  }

  // Per-run consent. Driving a logged-in tab is not something to do implicitly.
  if (!argv.includes("--yes")) {
    console.error(
      "relay-fetch: this drives your LOGGED-IN amazon.es browser tab — it navigates that tab and\n" +
        "reads the rendered page, which reflects your account, address and personalised prices.\n" +
        "Re-run with --yes to allow it for this run.",
    );
    process.exit(6);
  }

  let safeUrl;
  try {
    safeUrl = assertAmazonPageUrl(url);
  } catch (e) {
    if (!(e instanceof UrlNotAllowed)) throw e;
    console.error(`relay-fetch: ${e.message}`);
    process.exit(5);
  }

  if (!amazonTabs.length) {
    console.error("relay-fetch: no shared amazon.es tab. Share one in the extension, then re-run.");
    process.exit(4);
  }

  const settle = Number(flag("settle", "4500"));
  const cdp = new CdpSession();
  await cdp.open(amazonTabs[0].id);
  await cdp.navigate(safeUrl);

  // Poll for a settled results page rather than sleeping a fixed time.
  let html = "";
  for (let i = 0; i < 20; i++) {
    await sleep(i === 0 ? settle : 1000);
    const p = await cdp.probe();
    if (p.ready === "complete" && p.n > 0) {
      // A whole amazon.es document is ~1.8 MB and a single evaluate() round-trip
      // truncates it around 146 KB — silently, mid-attribute, so the parser just
      // sees zero cards. Stage the RESULTS CONTAINER (the only part the parser
      // needs) in a page variable and pull it back in slices.
      const total = await cdp.stageCapture();
      const CHUNK = 100000;
      const parts = [];
      for (let off = 0; off < total; off += CHUNK) parts.push(await cdp.captureSlice(off, CHUNK));
      html = parts.join("");
      if (html.length !== total) {
        console.error(`relay-fetch: WARNING reassembled ${html.length} of ${total} bytes`);
      }
      console.error(`relay-fetch: ${p.n} cards · ${total} bytes · ${p.href}`);
      break;
    }
  }
  cdp.close();

  if (!html) {
    console.error("relay-fetch: page never produced search results");
    process.exit(1);
  }

  const out = flag("out");
  if (out) {
    console.error(
      `NOTICE: writing a page rendered for your logged-in Amazon account to ${out}. ` +
        "It may contain account-identifying content (name, delivery address, personalised prices). " +
        "Delete it when you are done.",
    );
    fs.writeFileSync(out, html, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, out, bytes: html.length }));
  } else {
    process.stdout.write(html);
  }
}

await main();
