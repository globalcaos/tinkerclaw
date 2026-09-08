#!/usr/bin/env node
// session-capture.mjs — harvest amazon.es session cookies ONCE from a shared,
// logged-in Chrome tab, so every later request can be made directly over HTTPS
// instead of by driving the browser.
//
// To be unambiguous, because the earlier wording here said "plain HTTP" and read
// as if credentials travelled unencrypted: they never do. scripts/amazon_fetch.py
// refuses any URL that is not HTTPS and not amazon.es, before the request is
// built, so these cookies cannot be sent over a plaintext transport or to another
// host — including via a redirect.
//
// The browser is used for AUTHENTICATION, never for fetching. One capture (~2 s)
// buys hours of requests that are ~30x faster than driving the tab, and it stops
// the skill from hijacking your browser every time it wants a price.
//
// Why it is needed at all: amazon.es will not promise next-day delivery, show the
// right price, or apply the account's delivery address to an anonymous request
// (2026-08-06). The cookies carry the account AND the postcode, which is where the
// delivery promise comes from. For plain price/stock/title, the anonymous path is
// enough and NO capture is needed — see SKILL.md.
//
// SECURITY: `at-acbes` / `sess-at-acbes` / `x-acbes` are login credentials — for
// read purposes they are as good as the password. So:
//   * Reading them out of your browser is OPT-IN (--yes), never a side effect.
//   * They are stored in the OS keychain, with a WARNED 0600 file fallback.
//   * Cookie VALUES are never printed; only names and counts.
//   * `--logout` clears them from both stores and prints Amazon's revoke URL.
//
// Usage:
//   node session-capture.mjs --yes [--port 18792] [--json]
//   node session-capture.mjs --logout        (alias: --revoke)

import { saveSession, clearSession, REVOKE_URL, FILE_PATH } from "./session-store.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i < 0 ? d : argv[i + 1];
};
const PORT = flag("port", "18792");
const JSON_OUT = argv.includes("--json");

// ---------------------------------------------------------------- off switch
if (argv.includes("--logout") || argv.includes("--revoke")) {
  const cleared = clearSession();
  const out = {
    ok: true,
    logged_out: true,
    cleared_from: cleared,
    revoke_url: REVOKE_URL,
  };
  console.log(JSON_OUT ? JSON.stringify(out) : JSON.stringify(out, null, 2));
  console.error(
    cleared.length
      ? `Local session cleared from: ${cleared.join(", ")}.`
      : "No stored session found — nothing to clear.",
  );
  console.error(
    "This only removes the copy on THIS machine. To invalidate the token on Amazon's " +
      `side, sign out of all devices / change your password at:\n  ${REVOKE_URL}`,
  );
  process.exit(0);
}

// -------------------------------------------------------------- opt-in gate
// Reading auth cookies out of a live browser profile is a credential read. It
// happens only when you ask for it explicitly, in this run.
if (!argv.includes("--yes") && process.env.AMAZON_SHOPPER_ALLOW_SESSION_CAPTURE !== "1") {
  console.error(
    "REFUSED: capturing amazon.es session cookies reads LOGIN CREDENTIALS out of your\n" +
      "browser and stores them on this machine. It is opt-in. Re-run with --yes (or set\n" +
      "AMAZON_SHOPPER_ALLOW_SESSION_CAPTURE=1) if that is what you want.\n\n" +
      "You probably do NOT need it: price, stock, title and images work anonymously.\n" +
      "A session is only required for delivery promises and account-specific pricing.\n" +
      "Undo at any time with: node scripts/session-capture.mjs --logout",
  );
  process.exit(1);
}

// Cookies that make the session *authenticated* rather than merely tracked.
// Without one of these the replay is just an anonymous request with extra steps.
const AUTH = ["at-acbes", "sess-at-acbes", "x-acbes"];
// Cookies that carry identity/locale/location; kept for a faithful replay.
const WANTED =
  /^(session-id|session-id-time|session-token|ubid-acbes|at-acbes|sess-at-acbes|x-acbes|lc-acbes|i18n-prefs|sp-cdn|csm-hit|av-timezone)/;

function cdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error("CDP timeout"));
    }, 20000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("CDP connect failed"));
    });
    ws.addEventListener("message", (ev) => {
      const d = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
      if (d.id !== 1) return;
      clearTimeout(t);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      d.error ? reject(new Error(JSON.stringify(d.error))) : resolve(d.result);
    });
  });
}

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(8000) })
  .then((r) => r.json())
  .catch(() => null);

if (!res) {
  console.error("RELAY_DOWN: the browser relay is not answering on 127.0.0.1:" + PORT);
  process.exit(2);
}
const tab = res.find((t) => t.type === "page" && /amazon\.es/i.test(t.url || ""));
if (!tab) {
  console.error("NO_AMAZON_TAB: open amazon.es (logged in) and share that tab, then re-run.");
  process.exit(3);
}

const { cookies = [] } = await cdp(tab.webSocketDebuggerUrl, "Network.getAllCookies");
const amazon = cookies.filter(
  (c) =>
    /amazon\.es$/.test((c.domain || "").replace(/^\./, "")) || /amazon\.es/.test(c.domain || ""),
);
const keep = amazon.filter((c) => WANTED.test(c.name));

const haveAuth = keep.filter((c) => AUTH.includes(c.name)).map((c) => c.name);
if (!haveAuth.length) {
  console.error(
    "NOT_LOGGED_IN: the tab has amazon.es cookies but none of " +
      AUTH.join("/") +
      ". Sign in on that tab, then re-run.",
  );
  process.exit(4);
}

const payload = {
  captured_at: new Date().toISOString(),
  source_url: tab.url,
  cookies: keep.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expires: c.expires,
  })),
};

const stored = saveSession(payload);

// Names and counts only — never a value.
const soonest = keep
  .map((c) => c.expires)
  .filter((e) => e && e > 0)
  .sort((a, b) => a - b)[0];
const out = {
  ok: true,
  stored_in: stored,
  file: stored === "file" ? FILE_PATH : null,
  cookies: keep.length,
  auth_cookies: haveAuth,
  names: keep.map((c) => c.name),
  earliest_expiry: soonest ? new Date(soonest * 1000).toISOString() : null,
  logout_hint: "node scripts/session-capture.mjs --logout",
  revoke_url: REVOKE_URL,
};
console.log(JSON_OUT ? JSON.stringify(out) : JSON.stringify(out, null, 2));
