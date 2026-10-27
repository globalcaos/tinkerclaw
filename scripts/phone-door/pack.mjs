#!/usr/bin/env node
/**
 * Jarvis content pack: build, sign and publish the zip the phone app loads with no APK install.
 *
 * WHAT IT IS FOR (plan 2026-10-23 "phone app self-update", layer 2; the architect 17:45 "Build it"): voice
 * numbers, small scripts and other content change on the phone the way the page does, with no
 * Play Protect prompt. The pack source is the factory pack the APK carries
 * (apps/android/app/src/thirdParty/assets/pack); publish zips it, stamps manifest.json with a version,
 * signs the zip bytes with ed25519 and writes <door dir>/app/pack-<version>.zip plus pack.json, which
 * the door serves at /door/app/pack.json. The app (jarvis/JarvisPackStore.kt) checks size, sha256 and
 * the signature against the public key baked into the APK before it unpacks anything.
 * HOW IT WAS DERIVED: the APK's own publish (apps/android/scripts/jarvis-pi-publish.sh: versionCode =
 * minutes since 2026-01-01, latest.json beside the file, rename into place) and the door's file rules.
 * WHAT WOULD CHANGE IT: a second signer machine (copy the key dir), or packs per device.
 *
 *   node pack.mjs keygen                 # once: ~/.config/jarvis-pack/{private.pem (600), public.b64}
 *   node pack.mjs publish [--src DIR]    # prints the pack.json it wrote
 *   node pack.mjs verify <zip> <pack.json>
 *
 * Env: JARVIS_PACK_KEY_DIR (default ~/.config/jarvis-pack), PHONE_DOOR_DIR (default
 * ~/.openclaw/data/phone-door). The private key never leaves the key dir and is never in git.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SRC = path.resolve(HERE, "../../apps/android/app/src/thirdParty/assets/pack");
export const PACK_RE = /^pack-\d{1,12}\.zip$/;
const ENTRY_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const EPOCH_MS = Date.parse("2026-01-01T00:00:00Z");

export function keyDir() {
  return process.env.JARVIS_PACK_KEY_DIR || path.join(os.homedir(), ".config", "jarvis-pack");
}

export function doorDir() {
  return process.env.PHONE_DOOR_DIR || path.join(os.homedir(), ".openclaw", "data", "phone-door");
}

/** The same rule the app applies to zip entries (packEntryOk in JarvisPackStore.kt). */
export function entryNameOk(name) {
  const parts = name.split("/");
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => ENTRY_PART_RE.test(p));
}

/** Files under dir, as sorted relative names, so the same tree always gives the same zip. */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (d.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

/** A plain zip (deflate, no data descriptors, fixed 1980-01-01 timestamps) of [{name, data}]. */
export function zipFiles(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(33, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

/** The pack zip for `src`, its manifest stamped with `version`. */
export function buildPack(src, { version, publishedAt }) {
  const names = listFiles(src);
  if (!names.includes("manifest.json")) {
    throw new Error(`${src} has no manifest.json`);
  }
  for (const n of names) {
    if (!entryNameOk(n)) {
      throw new Error(`file name the app would refuse: ${n}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
  if (!names.includes(manifest.main ?? "main.js")) {
    throw new Error(`main script ${manifest.main ?? "main.js"} is missing`);
  }
  const files = {};
  const entries = [];
  for (const n of names) {
    if (n === "manifest.json") {
      continue;
    }
    const data = fs.readFileSync(path.join(src, n));
    files[n] = crypto.createHash("sha256").update(data).digest("hex");
    entries.push({ name: n, data });
  }
  const stamped = { ...manifest, version, publishedAt, files };
  entries.unshift({
    name: "manifest.json",
    data: Buffer.from(`${JSON.stringify(stamped, null, 2)}\n`),
  });
  return { zip: zipFiles(entries), manifest: stamped };
}

export function signPack(zip, privatePem) {
  return crypto.sign(null, zip, crypto.createPrivateKey(privatePem)).toString("base64");
}

/** publicB64 = the raw 32-byte key, base64, as baked into the APK. */
export function verifyPack(zip, sigB64, publicB64) {
  const raw = Buffer.from(publicB64.trim(), "base64");
  if (raw.length !== 32) {
    return false;
  }
  const key = crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
  try {
    return crypto.verify(null, zip, key, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

export function keygen(dir = keyDir()) {
  const priv = path.join(dir, "private.pem");
  if (fs.existsSync(priv)) {
    throw new Error(`${priv} exists; refusing to replace the key the installed app trusts`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(priv, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  fs.chmodSync(priv, 0o600);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  fs.writeFileSync(path.join(dir, "public.b64"), `${raw.toString("base64")}\n`, { mode: 0o644 });
  return raw.toString("base64");
}

function readPointer(appDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, "pack.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Builds, signs and publishes; returns the pack.json written. Versions only ever grow. */
export function publish({
  src = DEFAULT_SRC,
  door = doorDir(),
  keys = keyDir(),
  now = Date.now(),
} = {}) {
  const privPath = path.join(keys, "private.pem");
  const mode = fs.statSync(privPath).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${privPath} is readable by others (mode ${mode.toString(8)}); chmod 600 it`);
  }
  const privatePem = fs.readFileSync(privPath, "utf8");
  const publicB64 = fs.readFileSync(path.join(keys, "public.b64"), "utf8").trim();
  const appDir = path.join(door, "app");
  fs.mkdirSync(appDir, { recursive: true });
  const prev = readPointer(appDir);
  const version = Math.max(Math.floor((now - EPOCH_MS) / 60_000), (prev?.version ?? 0) + 1);
  const publishedAt = new Date(now).toISOString();
  const { zip, manifest } = buildPack(src, { version, publishedAt });
  const sig = signPack(zip, privatePem);
  if (!verifyPack(zip, sig, publicB64)) {
    throw new Error("the signature does not verify with public.b64; the key pair is broken");
  }
  const file = `pack-${version}.zip`;
  fs.writeFileSync(path.join(appDir, `${file}.part`), zip);
  fs.renameSync(path.join(appDir, `${file}.part`), path.join(appDir, file));
  const pointer = {
    version,
    file,
    sha256: crypto.createHash("sha256").update(zip).digest("hex"),
    size: zip.length,
    sig,
    publishedAt,
    files: Object.keys(manifest.files),
  };
  fs.writeFileSync(path.join(appDir, "pack.json.new"), `${JSON.stringify(pointer)}\n`);
  fs.renameSync(path.join(appDir, "pack.json.new"), path.join(appDir, "pack.json"));
  return pointer;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "keygen") {
    console.log(`public key (baked into the next APK): ${keygen()}`);
    return 0;
  }
  if (cmd === "publish") {
    const i = rest.indexOf("--src");
    const src = i >= 0 ? path.resolve(rest[i + 1]) : DEFAULT_SRC;
    console.log(JSON.stringify(publish({ src })));
    return 0;
  }
  if (cmd === "verify") {
    const [zipPath, pointerPath] = rest;
    const zip = fs.readFileSync(zipPath);
    const p = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    const pub = fs.readFileSync(path.join(keyDir(), "public.b64"), "utf8");
    const ok =
      verifyPack(zip, p.sig, pub) &&
      crypto.createHash("sha256").update(zip).digest("hex") === p.sha256 &&
      zip.length === p.size;
    console.log(ok ? "ok" : "BAD");
    return ok ? 0 : 1;
  }
  console.error("usage: pack.mjs keygen | publish [--src DIR] | verify <zip> <pack.json>");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`pack: ${err.message}`);
    process.exitCode = 1;
  }
}
