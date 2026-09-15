/**
 * Hivemind seats — shared types and pure helpers.
 *
 * One agent, N operators. The house (soul, recipes, archive, crons, graphs)
 * stays shared. These helpers key the five stores that fork: door, conductor,
 * desk, sessions *list*, tasks.
 *
 * Plan: docs/plans/2026-09-10-hivemind-seats-plan.md
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SeatId = string;
export type OperatorId = string;

export type Seat = {
  seatId: SeatId;
  operatorId: OperatorId;
  displayName: string;
  pairedAtMs?: number;
  deviceId?: string;
};

export type OperatorRecord = {
  deviceId: string;
  operatorId: OperatorId;
  displayName: string;
};

export const GATEWAY_TOKEN_STORAGE_KEY = "tinker.gatewayToken";
export const SEAT_ID_STORAGE_KEY = "tinker.seatId";
export const CONDUCTOR_STORAGE_KEY = "tinker.conductorDisplayName";
export const OPERATOR_ID_STORAGE_KEY = "tinker.operatorId";
export const TINKER_SEAT_HEADER = "x-tinker-seat";
export const TINKER_GATEWAY_COOKIE = "tinker_gateway";
/** Readable (not HttpOnly): the page copies it into sessionStorage so every tab knows its seat. */
export const TINKER_SEAT_COOKIE = "tinker_seat";
export const HIVE_OWNER_OPERATOR_ID = "oscar";

/** Banner: `GOKU (Alice)`. Empty conductor leaves the agent name alone. */
export function formatAgentBanner(agentName: string, conductor?: string | null): string {
  const a = (agentName ?? "").trim();
  const c = (conductor ?? "").trim();
  if (!a) return c;
  return c ? `${a} (${c})` : a;
}

/**
 * Seat ids become directory names. Reject path traversal and anything that is
 * not a short token.
 */
export function sanitizeSeatId(raw: unknown): SeatId | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > 80) return null;
  if (id === "." || id === "..") return null;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  return id;
}

export function seatsRoot(home = os.homedir()): string {
  return path.join(home, ".openclaw", "data", "seats");
}

export function uiStatePathForSeat(seatId: SeatId, home = os.homedir()): string {
  const id = sanitizeSeatId(seatId);
  if (!id) {
    throw new Error("invalid seat id");
  }
  return path.join(seatsRoot(home), id, "tinker-ui-state.json");
}

/** The single-operator desk: the file a seat-less install has always used. */
export function ownerDeskPath(home = os.homedir()): string {
  return path.join(home, ".openclaw", "data", "tinker-ui-state.json");
}

/**
 * FORK 2026-09-10 — the desk for a request that may carry no seat. A seat routes to its
 * own file; no seat routes to the OWNER desk. Whether a seat-less request is instead
 * REFUSED is the server's call (TINKER_REQUIRE_SEAT=1 in a hive), not this helper's: on a
 * laptop with no door nothing assigns a seat, and refusing there is how the desk froze on
 * 2026-09-10 (every browser exit lost the open tabs).
 */
export function uiStatePath(seatId: SeatId | null | undefined, home = os.homedir()): string {
  return seatId ? uiStatePathForSeat(seatId, home) : ownerDeskPath(home);
}

export function operatorsPath(home = os.homedir()): string {
  return path.join(seatsRoot(home), "operators.json");
}

export function loadOperators(home = os.homedir()): OperatorRecord[] {
  const p = operatorsPath(home);
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { operators?: unknown })?.operators;
    if (!Array.isArray(list)) return [];
    return list.filter(isOperatorRecord);
  } catch {
    return [];
  }
}

export function saveOperators(records: OperatorRecord[], home = os.homedir()): void {
  const p = operatorsPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

function isOperatorRecord(v: unknown): v is OperatorRecord {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.deviceId === "string" &&
    typeof o.operatorId === "string" &&
    typeof o.displayName === "string" &&
    o.deviceId.length > 0 &&
    o.operatorId.length > 0 &&
    o.displayName.trim().length > 0
  );
}

export function lookupOperator(
  records: OperatorRecord[],
  deviceId: string | null | undefined,
): OperatorRecord | null {
  if (!deviceId) return null;
  return records.find((r) => r.deviceId === deviceId) ?? null;
}

export type SessionOperatorMeta = {
  operatorId?: string | null;
  seatId?: string | null;
};

/** Panel filter only. Never applied to jsonl reads. */
export function sessionVisibleToOperator(
  meta: SessionOperatorMeta | null | undefined,
  operatorId: string | null | undefined,
  includeHive: boolean,
): boolean {
  if (includeHive || !operatorId) return true;
  const tagged = meta?.operatorId?.trim() || null;
  if (!tagged) {
    return operatorId === HIVE_OWNER_OPERATOR_ID;
  }
  return tagged === operatorId;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}

export function parseCookieHeader(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function gatewayCookie(token: string, secure: boolean): string {
  const parts = [
    `${TINKER_GATEWAY_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/tinker",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function seatCookie(seatId: SeatId, secure: boolean): string {
  const parts = [
    `${TINKER_SEAT_COOKIE}=${encodeURIComponent(seatId)}`,
    "Path=/tinker",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** A name typed at the door: trimmed, single-spaced, printable, at most 40 characters. */
export function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/[\u0000-\u001f\u007f<>"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > 40) return null;
  return name;
}

/**
 * The seat IS the operator: `Alice` -> `alice`. A browser that forgets its site data on exit
 * re-enters the same name and lands on the same desk, instead of a fresh random seat every day.
 */
export function operatorIdFromName(name: string): OperatorId | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return sanitizeSeatId(slug);
}

/** Insert or rename the operator for this name. The seat id doubles as the record's deviceId. */
export function upsertOperator(
  records: OperatorRecord[],
  displayName: string,
): { records: OperatorRecord[]; record: OperatorRecord } | null {
  const name = sanitizeDisplayName(displayName);
  const operatorId = name ? operatorIdFromName(name) : null;
  if (!name || !operatorId) return null;
  const record: OperatorRecord = { deviceId: operatorId, operatorId, displayName: name };
  const rest = records.filter((r) => r.deviceId !== operatorId);
  return { records: [...rest, record], record };
}

export function renderTinkerLoginPage(opts?: { error?: string; next?: string }): string {
  const err = opts?.error
    ? `<p style="color:#e8a07a;font-size:13px;margin:0 0 12px">${escapeHtml(opts.error)}</p>`
    : "";
  const next = escapeHtml(opts?.next ?? "/tinker/");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Tinker — sign in</title>
</head>
<body style="margin:0;min-height:100vh;background:#2b2017;color:#f4ead9;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center">
  <form id="door" method="post" action="/tinker/login" style="background:#1a1610;border:1px solid #5c4733;border-radius:14px;padding:28px 26px;width:min(420px,92vw)">
    <div style="font-size:13px;letter-spacing:.12em;color:#c9a978;margin-bottom:6px">TINKER</div>
    <h1 style="margin:0 0 8px;font-size:22px;color:#e8c79a">Who is at the door?</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.45;color:#d7c4a8">Your name, and the house token. The token is not stored in the URL.</p>
    ${err}
    <input type="hidden" name="next" value="${next}"/>
    <label style="display:block;font-size:12px;color:#c9a978;margin-bottom:12px">Name
      <input id="name" name="name" type="text" autocomplete="name" maxlength="40" required
        style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border-radius:8px;border:1px solid #5c4733;background:#2b2017;color:#f4ead9;font-size:15px"/>
    </label>
    <label style="display:block;font-size:12px;color:#c9a978;margin-bottom:6px">Token
      <input id="token" name="token" type="password" autocomplete="off" spellcheck="false"
        style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border-radius:8px;border:1px solid #5c4733;background:#2b2017;color:#f4ead9;font-size:15px"/>
    </label>
    <button type="submit" style="margin-top:16px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:#8b5a2b;color:#f4ead9;font-weight:700;cursor:pointer">Enter</button>
  </form>
  <script>
    document.getElementById("door").addEventListener("submit", function (e) {
      var token = document.getElementById("token").value;
      try { sessionStorage.setItem(${JSON.stringify(GATEWAY_TOKEN_STORAGE_KEY)}, token); } catch (err) {}
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function resolvePresentedGatewayToken(input: {
  cookieHeader?: string;
  authorization?: string;
}): string | null {
  const bearer = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  return parseCookieHeader(input.cookieHeader, TINKER_GATEWAY_COOKIE);
}
