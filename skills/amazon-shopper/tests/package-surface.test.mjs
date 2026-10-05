// package-surface.test.mjs — what this package is NOT allowed to contain.
//
// The 1.2.1 cut removed whole capabilities rather than disabling them: browser
// cookie capture, logged-in session replay, the browser relay that drove that
// tab, and the non-Amazon scrapers. A capability that is merely gated can be
// un-gated by an env var; a capability that is absent cannot. These tests read
// the shipped files and fail if any of it comes back — including by accident, in
// a later edit that only meant to restore a helper.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every shipped source file (excludes tests and HTML fixtures). */
function sourceFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "tests" ||
      entry === "node_modules" ||
      entry === ".git" ||
      entry === "__pycache__"
    )
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(mjs|js|py)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = sourceFiles();

/**
 * Source with comments removed. These tests must flag CODE that does something,
 * not prose that explains why the code no longer does it — a file documenting a
 * removed hook should not read as if it still had one.
 */
function code(file) {
  const src = readFileSync(file, "utf8");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block */
    .replace(/(^|[^:])\/\/.*$/gm, "$1") // // line (":" guard keeps https:// intact)
    .replace(/^\s*#.*$/gm, ""); // python # line
}

test("the package ships source files to check", () => {
  assert.ok(FILES.length > 10, `expected a real source tree, found ${FILES.length} files`);
});

test("no credential-capture or session-replay module is shipped", () => {
  const banned = [
    "session-capture.mjs",
    "session-store.mjs",
    "session_store.py",
    "amazon_fetch.py",
    "relay-fetch.mjs",
  ];
  const present = FILES.map((f) => relative(ROOT, f));
  for (const b of banned) {
    assert.ok(!present.some((p) => p.endsWith(b)), `${b} must not be in the published package`);
  }
});

test("no non-Amazon store adapter is shipped", () => {
  const present = FILES.map((f) => relative(ROOT, f));
  for (const b of ["MilanunciosAdapter.mjs", "WallapopAdapter.mjs"]) {
    assert.ok(!present.some((p) => p.endsWith(b)), `${b} must not be in the published package`);
  }
});

test("no source file reads amazon.es auth cookies or a stored session", () => {
  // The exact cookie names amazon.es uses for an authenticated session, plus the
  // credential file the removed store wrote.
  const patterns = [/\bat-acbes\b/, /\bsess-at-acbes\b/, /\bx-acbes\b/, /amazon-session\.json/];
  for (const f of FILES) {
    const src = code(f);
    for (const re of patterns) {
      assert.ok(!re.test(src), `${relative(ROOT, f)} references a login credential (${re})`);
    }
  }
});

test("no source file reaches an OS keychain", () => {
  for (const f of FILES) {
    const src = code(f);
    assert.ok(
      !/secret-tool|security\s+add-generic-password|find-generic-password/.test(src),
      `${relative(ROOT, f)} touches the OS keychain; this package stores no secret`,
    );
  }
});

test("no source file evaluates a string as code", () => {
  for (const f of FILES) {
    const src = code(f);
    assert.ok(!/new Function\s*\(/.test(src), `${relative(ROOT, f)} uses new Function()`);
    // `eval(` as a call, not as part of a longer identifier like `evaluate(`.
    assert.ok(!/(^|[^A-Za-z0-9_.$])eval\s*\(/.test(src), `${relative(ROOT, f)} uses eval()`);
    assert.ok(
      !/process\.env\.AMAZON_SHOPPER_FETCH_MODULE/.test(src),
      `${relative(ROOT, f)} restores the module-import env hook`,
    );
  }
});

test("no source file spawns a browser relay or a subagent CLI", () => {
  for (const f of FILES) {
    const src = code(f);
    assert.ok(
      !/OPENCLAW_SPAWN_CLI|openclaw-spawn-subagent/.test(src),
      `${relative(ROOT, f)} dispatches an external subagent; this skill runs self-contained`,
    );
    assert.ok(
      !/127\.0\.0\.1:18792|localhost:18792/.test(src),
      `${relative(ROOT, f)} talks to the browser relay port`,
    );
  }
});

test("no source file spawns python", () => {
  for (const f of FILES) {
    const src = code(f);
    assert.ok(
      !/["']python3?["']/.test(src),
      `${relative(ROOT, f)} spawns python; the fetch path is pure Node`,
    );
  }
});

test("SKILL.md offers no credential capture and no other stores", () => {
  const md = readFileSync(join(ROOT, "SKILL.md"), "utf8");

  // The frontmatter is the machine-read part — what a scanner and a skill loader
  // parse. It must not mention a removed capability at all, in any framing.
  const fm = md.split(/^---$/m)[1] || "";
  assert.ok(fm.length > 200, "frontmatter should have been found");
  for (const gone of [
    "AMAZON_SHOPPER_ENABLE_OTHER_STORES",
    "AMAZON_SHOPPER_ALLOW_SESSION_CAPTURE",
    "session-capture",
    "relay-fetch",
    "amazon_fetch",
    "AMAZON_SHOPPER_APIFY_SEARCH_ACTOR",
  ]) {
    assert.ok(!fm.includes(gone), `frontmatter still mentions ${gone}`);
  }

  // The prose MAY name a removed capability — the "What 1.2.1 removed" table has to
  // say what went, and saying "there is no --session flag" is the opposite of
  // offering one. What must never appear is a RUNNABLE instruction, so the check
  // reads the fenced code blocks: those are the lines a reader copies.
  const commands = [...md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
  assert.ok(commands.includes("amazon-shopper start"), "the CLI examples should have been found");
  for (const gone of [
    "session-capture",
    "relay-fetch",
    "amazon_fetch",
    "session_store",
    "--session",
    "--next-day",
    "AMAZON_SHOPPER_ENABLE_OTHER_STORES",
    "AMAZON_SHOPPER_APIFY_SEARCH_ACTOR",
    "AMAZON_SHOPPER_APIFY_DETAIL_ACTOR",
    "AMAZON_SHOPPER_ALLOW_ANY_LLM_CMD",
    "AMAZON_SHOPPER_CONVERT_CMD",
    "OPENCLAW_SPAWN_CLI",
  ]) {
    assert.ok(!commands.includes(gone), `a copy-pasteable example still uses ${gone}`);
  }
});

test("SKILL.md declares the credentials it CAN touch, by name", () => {
  const md = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  const fm = md.split(/^---$/m)[1] || "";
  // Silence is not a declaration: the two optional API keys are real secrets and
  // must be named in the credentials permission, not left to be discovered.
  const cred = fm.slice(fm.indexOf("credentials:"));
  assert.ok(cred.length > 100, "a credentials permission block must exist");
  for (const key of [
    "AMAZON_SHOPPER_APIFY_TOKEN",
    "AMAZON_SHOPPER_CREATORS_ACCESS_KEY",
    "AMAZON_SHOPPER_CREATORS_SECRET_KEY",
  ]) {
    assert.ok(cred.includes(key), `the credentials permission must name ${key}`);
  }
});

// ── Every environment variable the code reads is declared in the frontmatter ──
// SkillSpector's CREDENTIALS category reads the frontmatter, not the prose: a
// secret documented only in the body counts as undeclared. This keeps the
// declaration honest in BOTH directions — nothing read but undeclared, and
// nothing declared that the code no longer reads.

/** The env names appearing in `metadata.openclaw.env:` of SKILL.md. */
function declaredEnv() {
  const md = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  const fm = md.split(/^---$/m)[1] || "";
  const block = fm.slice(fm.indexOf("\n    env:"));
  const end = block.search(/\n    [a-z_]+:/);
  const envBlock = end > 0 ? block.slice(0, end) : block;
  return new Set([...envBlock.matchAll(/- name:\s*([A-Z_0-9]+)/g)].map((m) => m[1]));
}

/** The env names the shipped code actually reads. */
function readEnv() {
  const names = new Set();
  for (const f of FILES) {
    for (const m of code(f).matchAll(/process\.env\.([A-Z_0-9]+)/g)) names.add(m[1]);
  }
  return names;
}

test("every environment variable the code reads is declared in the frontmatter", () => {
  const declared = declaredEnv();
  assert.ok(declared.size > 5, `expected a real env declaration, parsed ${declared.size}`);
  const undeclared = [...readEnv()].filter((n) => !declared.has(n));
  assert.deepEqual(undeclared, [], `undeclared environment variables: ${undeclared.join(", ")}`);
});

test("no declared environment variable is stale", () => {
  const read = readEnv();
  const stale = [...declaredEnv()].filter((n) => !read.has(n));
  assert.deepEqual(stale, [], `declared but never read: ${stale.join(", ")}`);
});

test("the three API keys are declared sensitive", () => {
  const md = readFileSync(join(ROOT, "SKILL.md"), "utf8");
  for (const key of [
    "AMAZON_SHOPPER_APIFY_TOKEN",
    "AMAZON_SHOPPER_CREATORS_ACCESS_KEY",
    "AMAZON_SHOPPER_CREATORS_SECRET_KEY",
  ]) {
    const entry = md.slice(md.indexOf(`- name: ${key}`));
    assert.match(entry.slice(0, 200), /sensitive: true/, `${key} must be marked sensitive`);
  }
});
