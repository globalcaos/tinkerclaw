#!/usr/bin/env node
/**
 * Manage the hive door's people table (tokens.json, mode 0600). Admins can do the same
 * from the page (right rail, USERS panel); this is the terminal way and the bootstrap.
 *
 *   door-tokens.mjs list
 *   door-tokens.mjs add <operatorId> <displayName> [--seat <seatId>] [--admin]   new token, shown ONCE
 *   door-tokens.mjs import-gateway <operatorId> <displayName> [--seat <seatId>] [--admin]
 *                             register the CURRENT gateway token as that person's token (not printed)
 *   door-tokens.mjs rotate <operatorId|tokenId>    new token; the old one stops working
 *   door-tokens.mjs revoke <operatorId|tokenId>    token stops working; rotate makes them active again
 *   door-tokens.mjs delete <operatorId|tokenId>    no access; every chat and setting of theirs is kept
 *   door-tokens.mjs admin <operatorId|tokenId> on|off
 *   door-tokens.mjs seed-seats                     make sure the seat file names every person
 *   door-tokens.mjs remember <operatorId>          read that person's CURRENT token on stdin and keep it so admins
 *                             can copy it from the page; refused unless it matches the stored hash
 *
 * Env: DOOR_STATE_DIR (default ~/.openclaw/data/door). Nothing here ever removes a row.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeAdmins,
  addPerson,
  loadRows,
  newToken,
  saveRows,
  seedSeats,
  sha256Hex,
  rememberToken,
} from "./table.mjs";

const home = os.homedir();
const stateDir = process.env.DOOR_STATE_DIR ?? path.join(home, ".openclaw", "data", "door");
const tableFile = path.join(stateDir, "tokens.json");
const seatsFile = path.join(home, ".openclaw", "data", "seats", "operators.json");
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const [cmd, ...args] = process.argv.slice(2);
const rows = loadRows(tableFile);
const find = (idOrToken) => rows.find((r) => r.operatorId === idOrToken || r.tokenId === idOrToken);
const must = (r) => {
  if (!r) {
    console.error("no such person");
    process.exit(1);
  }
  return r;
};
const guardLastAdmin = (r) => {
  if (r.admin && r.status === "active" && activeAdmins(rows).length <= 1) {
    console.error("refused: the last admin cannot lose admin rights or access");
    process.exit(1);
  }
};

switch (cmd) {
  case "list":
    for (const r of rows)
      console.log(
        `${r.tokenId}  ${String(r.status).padEnd(7)} ${r.admin ? "admin" : "     "} ${r.operatorId.padEnd(12)} seat=${r.seatId}  ${r.displayName}  ${r.createdAt ?? ""}`,
      );
    if (!rows.length) console.log("(empty)");
    break;
  case "add": {
    const [operatorId, displayName] = args;
    const {
      rows: next,
      row,
      token,
    } = addPerson(rows, {
      operatorId,
      displayName,
      seatId: flag(args, "--seat"),
      admin: args.includes("--admin"),
    });
    saveRows(tableFile, next);
    console.log(
      `tokenId: ${row.tokenId}\nperson : ${row.displayName} (${row.operatorId})${row.admin ? " admin" : ""}\ntoken  : ${token}\n(shown once; only its hash is stored)`,
    );
    break;
  }
  case "import-gateway": {
    const [operatorId, displayName] = args;
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
    const t = cfg?.gateway?.auth?.token;
    if (!t) throw new Error("no gateway.auth.token in openclaw.json");
    const hash = sha256Hex(t);
    if (rows.some((r) => r.hash === hash && r.status === "active"))
      throw new Error("that token is already registered");
    const { rows: next, row } = addPerson(rows, {
      operatorId,
      displayName,
      seatId: flag(args, "--seat"),
      admin: args.includes("--admin"),
      hash,
    });
    row.token = t;
    saveRows(tableFile, next);
    console.log(
      `registered the current gateway token for ${displayName} as ${row.tokenId} (value not printed)`,
    );
    break;
  }
  case "rotate": {
    const r = must(find(args[0]));
    const token = newToken();
    r.hash = sha256Hex(token);
    r.token = token;
    r.status = "active";
    r.rotatedAt = new Date().toISOString();
    delete r.revokedAt;
    delete r.deletedAt;
    saveRows(tableFile, rows);
    console.log(
      `tokenId: ${r.tokenId}\nperson : ${r.displayName}\ntoken  : ${token}\n(shown once; the old token no longer works)`,
    );
    break;
  }
  case "revoke":
  case "delete": {
    const r = must(find(args[0]));
    guardLastAdmin(r);
    r.status = cmd === "revoke" ? "revoked" : "deleted";
    r[cmd === "revoke" ? "revokedAt" : "deletedAt"] = new Date().toISOString();
    saveRows(tableFile, rows);
    console.log(
      `${cmd === "revoke" ? "revoked" : "access deleted for"} ${r.displayName} (${r.tokenId}); their chats are kept`,
    );
    break;
  }
  case "admin": {
    const r = must(find(args[0]));
    const on = args[1] === "on";
    if (!on) guardLastAdmin(r);
    r.admin = on;
    saveRows(tableFile, rows);
    console.log(`${r.displayName}: admin ${on ? "on" : "off"}`);
    break;
  }
  case "remember": {
    const token = fs.readFileSync(0, "utf8").trim();
    const r = rememberToken(rows, args[0], token);
    saveRows(tableFile, rows);
    console.log(`kept the current token for ${r.displayName} (${r.tokenId}); value not printed`);
    break;
  }
  case "seed-seats": {
    const { added, total } = seedSeats(seatsFile, rows);
    console.log(`seats: ${added} added, ${total} total`);
    break;
  }
  default:
    console.error(
      "usage: door-tokens.mjs list | add <id> <Name> [--seat id] [--admin] | import-gateway <id> <Name> [--seat id] [--admin] | rotate|revoke|delete <id> | admin <id> on|off | seed-seats",
    );
    process.exit(2);
}
