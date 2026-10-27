import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, delimiter } from "node:path";
import test from "node:test";
import { resolveTrustedBin, walkTrusted } from "../scripts/resolve-bin.mjs";

// Fixtures must live somewhere whose whole directory chain is itself trusted,
// otherwise every candidate is (correctly) refused. /tmp is world-writable, so
// try the home directory first and skip when no trusted base exists.
function trustedBase(t) {
  for (const base of [homedir(), tmpdir()]) {
    let root;
    try {
      root = mkdtempSync(join(base, ".ashop-bin-test-"));
    } catch {
      continue;
    }
    chmodSync(root, 0o700);
    if (probeDir(root)) {
      t.after(() => rmSync(root, { recursive: true, force: true }));
      return root;
    }
    rmSync(root, { recursive: true, force: true });
  }
  t.skip("no directory with a fully trusted chain is available for fixtures");
  return null;
}

function probeDir(root) {
  const p = fakeBin(join(root, "probe"), "probe");
  const ok = resolveTrustedBin("probe", { pathEnv: join(root, "probe") }) === p;
  rmSync(join(root, "probe"), { recursive: true, force: true });
  return ok;
}

function fakeBin(dir, name, mode = 0o755) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, mode);
  return p;
}

test("resolves a bare name to an absolute path from an absolute PATH entry", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  const good = fakeBin(join(root, "good"), "claude");
  assert.equal(resolveTrustedBin("claude", { pathEnv: join(root, "good") }), good);
});

test("refuses a name with a path separator", () => {
  assert.throws(
    () => resolveTrustedBin("/tmp/x/claude", { pathEnv: "/usr/bin" }),
    /bare program name/,
  );
  assert.throws(() => resolveTrustedBin("../claude", { pathEnv: "/usr/bin" }), /bare program name/);
});

test("skips empty, '.' and relative PATH entries", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  fakeBin(root, "claude");
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  assert.equal(
    resolveTrustedBin("claude", { pathEnv: ["", ".", "./", "sub"].join(delimiter) }),
    null,
  );
});

test("skips a world-writable directory and a group/world-writable binary, falling through to a trusted one", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  const openDir = join(root, "open");
  fakeBin(openDir, "magick");
  chmodSync(openDir, 0o777);
  fakeBin(join(root, "loose"), "magick", 0o777);
  const good = fakeBin(join(root, "good"), "magick");
  const pathEnv = [openDir, join(root, "loose"), join(root, "good")].join(delimiter);
  assert.equal(resolveTrustedBin("magick", { pathEnv }), good);
});

test("skips a non-executable file", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  fakeBin(root, "gemini", 0o644);
  assert.equal(resolveTrustedBin("gemini", { pathEnv: root }), null);
});

test("refuses a symlink in a trusted PATH entry whose real file sits in a world-writable directory", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  const evil = join(root, "evil");
  fakeBin(evil, "claude", 0o755);
  chmodSync(evil, 0o777);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { mode: 0o755 });
  symlinkSync(join(evil, "claude"), join(binDir, "claude"));
  const refused = [];
  assert.equal(
    resolveTrustedBin("claude", { pathEnv: binDir, onRefuse: (c, why) => refused.push(why) }),
    null,
  );
  assert.match(refused.join("\n"), /evil: directory writable by others/);
});

test("refuses a real file reached through a world-writable ANCESTOR directory", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  const open = join(root, "open");
  mkdirSync(open, { mode: 0o755 });
  fakeBin(join(open, "inner"), "claude");
  chmodSync(open, 0o777);
  assert.equal(resolveTrustedBin("claude", { pathEnv: join(open, "inner") }), null);
});

test("refuses a relative-symlink chain that hops through a world-writable directory", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  const real = fakeBin(join(root, "real"), "claude");
  const hop = join(root, "hop");
  mkdirSync(hop, { mode: 0o755 });
  symlinkSync(real, join(hop, "claude"));
  chmodSync(hop, 0o777);
  const binDir = join(root, "bin");
  mkdirSync(binDir, { mode: 0o755 });
  symlinkSync(join("..", "hop", "claude"), join(binDir, "claude"));
  assert.equal(resolveTrustedBin("claude", { pathEnv: binDir }), null);
});

test("accepts a symlink whose whole chain is trusted, and returns the checked PATH candidate", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  const real = fakeBin(join(root, "versions", "1.0"), "claude.exe");
  const binDir = join(root, "bin");
  mkdirSync(binDir, { mode: 0o755 });
  symlinkSync(join("..", "versions", "1.0", "claude.exe"), join(binDir, "claude"));
  assert.equal(resolveTrustedBin("claude", { pathEnv: binDir }), join(binDir, "claude"));
  assert.equal(walkTrusted(join(binDir, "claude")).path, real);
});

test("refuses a PATH entry that is itself a symlink to a world-writable directory", (t) => {
  const root = trustedBase(t);
  if (!root) return;
  const open = join(root, "open");
  fakeBin(open, "gemini");
  chmodSync(open, 0o777);
  symlinkSync(open, join(root, "entry"));
  assert.equal(resolveTrustedBin("gemini", { pathEnv: join(root, "entry") }), null);
});
