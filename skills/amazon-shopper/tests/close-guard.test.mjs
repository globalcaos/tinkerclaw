import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// The `close` subcommand DELETES files, and its only input is a task id that
// gets interpolated into a path. These tests pin the guard: an id may not escape
// the temp dir, a symlink is never followed, and a file this tool did not create
// is never removed — while a genuine task database still is.
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOPPER = join(HERE, "..", "scripts", "shopper.mjs");
const SQLITE_MAGIC = "SQLite format 3\0";

function close(taskId, sandbox) {
  const r = spawnSync("node", ["--experimental-sqlite", SHOPPER, "close", taskId], {
    env: { ...process.env, AMAZON_SHOPPER_TMPDIR: sandbox },
    encoding: "utf8",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ashop-close-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sandbox = join(dir, "sandbox");
  mkdirSync(sandbox);
  writeFileSync(join(dir, "victim.db"), "important data");
  return { dir, sandbox };
}

test("a traversing task id is refused before any path is touched", (t) => {
  const { dir, sandbox } = fixture(t);
  const victim = join(dir, "victim.db");
  const r = close("../../victim", sandbox);
  assert.notEqual(r.code, 0, "must exit non-zero");
  assert.match(r.stderr, /invalid task id/);
  assert.ok(existsSync(victim), "a file outside the temp dir must survive");
});

test("a symlink standing in for the task database is never followed", (t) => {
  const { dir, sandbox } = fixture(t);
  const victim = join(dir, "victim.db");
  symlinkSync(victim, join(sandbox, "amazon-shopper-aaaaaaaaaaaa.db"));
  const r = close("aaaaaaaaaaaa", sandbox);
  assert.match(r.stdout, /refused: symlink/);
  assert.ok(existsSync(victim), "the symlink target must survive");
});

test("a file this tool did not create is not deleted", (t) => {
  const { sandbox } = fixture(t);
  const decoy = join(sandbox, "amazon-shopper-bbbbbbbbbbbb.db");
  writeFileSync(decoy, "not a database");
  const r = close("bbbbbbbbbbbb", sandbox);
  assert.match(r.stdout, /not a SQLite file created by this tool/);
  assert.ok(existsSync(decoy), "a non-SQLite file must survive");
});

test("a genuine task database is still deleted", (t) => {
  const { sandbox } = fixture(t);
  const db = join(sandbox, "amazon-shopper-cccccccccccc.db");
  writeFileSync(db, SQLITE_MAGIC, "latin1");
  const r = close("cccccccccccc", sandbox);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"closed":true/);
  assert.ok(!existsSync(db), "the real task database must be removed");
});
