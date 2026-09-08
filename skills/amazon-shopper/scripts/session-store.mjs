// session-store.mjs — where the amazon.es session cookies live, and how to get rid of them.
//
// The captured cookies (at-acbes / sess-at-acbes / x-acbes) are login credentials:
// for read purposes they are as good as the account password. So they go into the
// OS keychain by default, and only fall back to a file when no keychain exists —
// loudly, never silently.
//
//   1. Linux  — libsecret via `secret-tool` (value passed on STDIN, never in argv).
//   2. macOS  — Keychain via `security`.
//   3. Fallback — a 0600 JSON file, WITH A WARNING printed every run.
//
// Off switch: `node scripts/session-capture.mjs --logout` clears BOTH stores.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SERVICE = "amazon-shopper";
export const ACCOUNT = "amazon-session";
export const LABEL = "amazon-shopper amazon.es session cookies";
export const FILE_PATH = path.join(
  process.env.HOME || "",
  ".openclaw",
  "credentials",
  "amazon-session.json",
);

// Amazon's own server-side revoke: change the password / sign out of all devices.
// Clearing the local copy stops THIS machine; only Amazon can invalidate the token.
export const REVOKE_URL = "https://www.amazon.es/gp/css/account/info/view.html";

function haveBin(bin) {
  const r = spawnSync(bin, ["--help"], { stdio: "ignore" });
  return !(r.error && r.error.code === "ENOENT");
}

function backend() {
  if (process.env.AMAZON_SHOPPER_SESSION_FILE_ONLY === "1") return "file";
  if (process.platform === "darwin" && haveBin("security")) return "macos";
  if (haveBin("secret-tool")) return "libsecret";
  return "file";
}

let warned = false;
function warnFile() {
  if (warned) return;
  warned = true;
  process.stderr.write(
    "WARNING: no OS keychain found (neither `secret-tool` nor macOS `security`), so your " +
      "amazon.es session cookies are stored in a plain file at " +
      FILE_PATH +
      " with mode 0600. " +
      "Any process running as this user can read them. Install libsecret-tools " +
      "(Debian/Ubuntu: `apt install libsecret-tools`) to use the keychain instead. " +
      "Remove them at any time with `node scripts/session-capture.mjs --logout`.\n",
  );
}

/** Persist the session. Returns the backend actually used. */
export function saveSession(obj) {
  const json = JSON.stringify(obj, null, 1);
  const b = backend();
  if (b === "libsecret") {
    const r = spawnSync(
      "secret-tool",
      ["store", `--label=${LABEL}`, "service", SERVICE, "account", ACCOUNT],
      { input: json },
    );
    if (r.status === 0) return "keychain:libsecret";
  } else if (b === "macos") {
    // `-w` with NO value makes `security` read the secret from stdin instead of
    // taking it from argv, which is world-readable via `ps` for the life of the
    // call. Fixed 1.2.0 — mirrors session_store.py.
    const r = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      {
        input: json + "\n",
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    if (r.status === 0) return "keychain:macos";
  }
  warnFile();
  fs.mkdirSync(path.dirname(FILE_PATH), { recursive: true });
  fs.writeFileSync(FILE_PATH, json, { mode: 0o600 });
  fs.chmodSync(FILE_PATH, 0o600);
  return "file";
}

/** Read the session back. Returns {data, from} or null when nothing is stored. */
export function loadSession() {
  const b = backend();
  if (b === "libsecret") {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], {
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      return { data: JSON.parse(r.stdout), from: "keychain:libsecret" };
    }
  } else if (b === "macos") {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], {
      encoding: "utf8",
    });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      return { data: JSON.parse(r.stdout), from: "keychain:macos" };
    }
  }
  if (fs.existsSync(FILE_PATH)) {
    warnFile();
    return { data: JSON.parse(fs.readFileSync(FILE_PATH, "utf8")), from: "file" };
  }
  return null;
}

/** Delete the session from BOTH stores. Returns the list of places actually cleared. */
export function clearSession() {
  const cleared = [];
  if (haveBin("secret-tool")) {
    const found = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], {
      encoding: "utf8",
    });
    if (found.status === 0 && found.stdout && found.stdout.trim()) {
      if (
        spawnSync("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT], {
          stdio: "ignore",
        }).status === 0
      ) {
        cleared.push("keychain:libsecret");
      }
    }
  }
  if (process.platform === "darwin" && haveBin("security")) {
    if (
      spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], {
        stdio: "ignore",
      }).status === 0
    ) {
      cleared.push("keychain:macos");
    }
  }
  for (const p of [FILE_PATH, FILE_PATH.replace(/\.json$/, ".tmp")]) {
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      cleared.push(p === FILE_PATH ? "file" : "file:tmp");
    }
  }
  return cleared;
}
