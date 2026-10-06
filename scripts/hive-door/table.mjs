/**
 * Hive door — the people table (tokens.json, hashes only, mode 0600).
 *
 * A row is one person: { tokenId, operatorId, displayName, seatId, hash, status, admin, createdAt,
 * rotatedAt?, revokedAt?, deletedAt?, lastLoginAt? }. status is "active" (can log in), "revoked"
 * (token stopped; a regenerated token makes the row active again) or "deleted" (no access; every
 * chat and setting of theirs is kept). Nothing in this module ever removes a row.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

export function newToken() {
  return "gk_" + crypto.randomBytes(24).toString("base64url");
}

export function idOk(s) {
  return typeof s === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(s);
}

/** "Maria José" -> "maria-jose"; never empty. */
export function slugify(name) {
  const s = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "user";
}

export function loadRows(file) {
  try {
    const rows = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function saveRows(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Add a person with a fresh token. Returns { rows, row, token }. */
export function addPerson(rows, { displayName, operatorId, seatId, admin = false, hash }) {
  const name = String(displayName ?? "")
    .trim()
    .slice(0, 60);
  if (!name) throw new Error("a name is required");
  let id = operatorId ?? slugify(name);
  if (!idOk(id)) throw new Error("bad id");
  if (!operatorId) {
    const base = id;
    for (let n = 2; rows.some((r) => r.operatorId === id); n++) id = `${base}-${n}`;
  } else if (rows.some((r) => r.operatorId === id)) {
    throw new Error(`"${id}" already exists`);
  }
  const token = hash ? null : newToken();
  const row = {
    tokenId: "t_" + crypto.randomBytes(4).toString("hex"),
    operatorId: id,
    displayName: name,
    seatId: seatId ?? id,
    hash: hash ?? sha256Hex(token),
    status: "active",
    admin: Boolean(admin),
    createdAt: new Date().toISOString(),
  };
  if (!idOk(row.seatId)) throw new Error("bad seat");
  return { rows: [...rows, row], row, token };
}

export function activeAdmins(rows) {
  return rows.filter((r) => r.status === "active" && r.admin);
}

/** Make sure the seat file names every person, so the page can paint "AGENT (Name)". */
export function seedSeats(seatsFile, rows) {
  let ops = [];
  try {
    ops = JSON.parse(fs.readFileSync(seatsFile, "utf8"));
  } catch {}
  if (!Array.isArray(ops)) ops = [];
  let added = 0;
  for (const r of rows) {
    if (!ops.some((o) => o.deviceId === r.seatId)) {
      ops.push({ deviceId: r.seatId, operatorId: r.operatorId, displayName: r.displayName });
      added += 1;
    }
  }
  if (added) {
    fs.mkdirSync(path.dirname(seatsFile), { recursive: true });
    fs.writeFileSync(seatsFile, JSON.stringify(ops, null, 2) + "\n");
  }
  return { added, total: ops.length };
}
