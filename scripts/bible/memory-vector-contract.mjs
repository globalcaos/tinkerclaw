#!/usr/bin/env node
/**
 * The vector-store contract asserted against the source that implements it.
 *
 * Owner doc: TINKER_UI_DESIGN_BIBLE/memory-layout.md § "Vector store contract".
 * That file EXPLAINS the contract (vec0, shadow tables, dims frozen at CREATE, meta as a
 * CLAIM); this file CHECKS it, per FOUNDATION.md "Three different jobs, three different
 * homes" — the bible's `verify:` entries are one-line pointers here.
 *
 * Usage:
 *   node scripts/bible/memory-vector-contract.mjs                    # every check
 *   node scripts/bible/memory-vector-contract.mjs --check=shape
 *   node scripts/bible/memory-vector-contract.mjs --check=degrade
 *   node scripts/bible/memory-vector-contract.mjs --check=derivations
 *   node scripts/bible/memory-vector-contract.mjs --self-test        # prove each can go RED
 *
 * Every check prints what it SAW. The counted check (`derivations`) is a RATCHET: the cap
 * may fall, never rise. The duplicate LEDGER itself is owned by canonical-derivations.md —
 * this cap only keeps the table in memory-layout.md from going stale.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The FORK copy — the one on the fork.memory.search RPC path, and the one 2026-08-04 fixed. */
const FORK_SYNC_OPS = "src/memory/manager-sync-ops.ts";

/** Trees that own a `const VECTOR_TABLE` derivation today. Both are live call paths. */
const VECTOR_TABLE_ROOTS = ["src/memory", "extensions/memory-core/src/memory"];

/**
 * Measured status quo on 2026-08-04: 7 non-test files declare `const VECTOR_TABLE`.
 * Ratchet, not a target — collapse sites and lower this in the same commit.
 */
const VECTOR_TABLE_CAP = 7;

function walkTs(rel) {
  const abs = path.join(REPO_ROOT, rel);
  const out = [];
  const stack = [abs];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Each check returns {ok, saw, why}. `mutate` produces a source tree override that MUST
 * make the check go red — that is what --self-test exercises.
 */
const CHECKS = {
  shape: {
    title:
      "the vec0 shape is read back from sqlite_master BEFORE the fast path, and again after every CREATE",
    run(src) {
      const t = src[FORK_SYNC_OPS];
      const missing = ["readVectorTableDims", "vectorDimsVerified", "vector_chunks00"].filter(
        (n) => !t.includes(n),
      );
      if (missing.length > 0) {
        return { ok: false, saw: `MISSING in ${FORK_SYNC_OPS}: ${missing.join(", ")}` };
      }
      const readbacks = t.split("readVectorTableDims").length - 1;
      const verifyAt = t.indexOf("if (!this.vectorDimsVerified)");
      const fastPathAt = t.indexOf("if (this.vector.dims === dimensions)");
      const ordered = verifyAt > 0 && fastPathAt > 0 && verifyAt < fastPathAt;
      return {
        ok: readbacks >= 3 && ordered,
        saw:
          `${FORK_SYNC_OPS}: ${readbacks} readVectorTableDims reference(s); ` +
          `vectorDimsVerified gate at char ${verifyAt}, dims-equality fast path at char ${fastPathAt} ` +
          `(gate must come FIRST: ${ordered})`,
      };
    },
    why:
      "persisted meta.vectorDims is a CLAIM, not the truth — measured 2026-08-04, meta said 1024 " +
      "while chunks_vec was declared FLOAT[3072]. If the equality fast path can be taken before " +
      "the schema is read back from sqlite_master, a lying meta short-circuits the whole check and " +
      "the mismatch can never heal: 5,258 chunks, ZERO vectors, forever, at warn level.",
    mutants: [
      (src) => ({
        ...src,
        [FORK_SYNC_OPS]: src[FORK_SYNC_OPS].split("readVectorTableDims").join("someOtherThing"),
      }),
      (src) => ({
        ...src,
        [FORK_SYNC_OPS]: src[FORK_SYNC_OPS]
          .split("if (!this.vectorDimsVerified)")
          .join("if (false)"),
      }),
    ],
  },

  degrade: {
    title:
      "an unfixable dim mismatch DISABLES vector search loudly instead of throwing on every insert",
    run(src) {
      const t = src[FORK_SYNC_OPS];
      const i = t.indexOf("private ensureVectorTable");
      if (i < 0) {
        return { ok: false, saw: `ensureVectorTable not found in ${FORK_SYNC_OPS}` };
      }
      const body = t.slice(i, i + 3200);
      const needs = ["log.error(", "this.vector.available = false"];
      const missing = needs.filter((n) => !body.includes(n));
      return {
        ok: missing.length === 0,
        saw:
          missing.length === 0
            ? `${FORK_SYNC_OPS}: ensureVectorTable at char ${i} contains ${needs.join(" + ")}`
            : `${FORK_SYNC_OPS}: ensureVectorTable MISSING ${missing.join(", ")}`,
      };
    },
    why:
      "a shape the manager cannot fix must degrade HONESTLY — vector search off, keyword search " +
      "still answering, one log.error carrying the remedy. The pre-fix behaviour was the opposite: " +
      "a per-insert throw reported as `memory sync failed (...)` at warn, 198 times in three days, " +
      "while retrieval quietly fell back to keyword-only.",
    mutants: [
      (src) => ({
        ...src,
        [FORK_SYNC_OPS]: src[FORK_SYNC_OPS].split("this.vector.available = false").join("void 0"),
      }),
      (src) => ({
        ...src,
        [FORK_SYNC_OPS]: src[FORK_SYNC_OPS]
          .split("private ensureVectorTable")
          .join("private ensureVecTbl"),
      }),
    ],
  },

  derivations: {
    title: `chunks_vec is derived in at most ${VECTOR_TABLE_CAP} non-test files across the two live trees`,
    run(src) {
      const hits = Object.keys(src)
        .filter((rel) => src[rel].includes("const VECTOR_TABLE"))
        .sort();
      return {
        ok: hits.length <= VECTOR_TABLE_CAP,
        saw: `${hits.length}/${VECTOR_TABLE_CAP} site(s): ${hits.join(", ")}`,
      };
    },
    why:
      "the memory engine exists in TWO live trees (src/memory/ serves fork.memory.search; " +
      "extensions/memory-core/ serves the memory_search tool and the CLI), so a fix to one copy " +
      "leaves the other path unfixed. Add the new site to canonical-derivations.md — which owns " +
      "the duplicate ledger — or collapse it, and update the table in memory-layout.md.",
    mutants: [
      (src) => ({ ...src, "src/memory/__extra__.ts": 'const VECTOR_TABLE = "chunks_vec";\n' }),
    ],
  },
};

function loadSources() {
  const src = {};
  for (const root of VECTOR_TABLE_ROOTS) {
    for (const abs of walkTs(root)) {
      src[path.relative(REPO_ROOT, abs)] = readFileSync(abs, "utf8");
    }
  }
  if (!src[FORK_SYNC_OPS]) {
    console.error(
      `FAIL — ${FORK_SYNC_OPS} not found; the Vector store contract must be re-derived`,
    );
    process.exit(1);
  }
  return src;
}

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--check=")) ?? "").slice("--check=".length);
const src = loadSources();

if (args.includes("--self-test")) {
  console.log(
    "memory-layout.md Vector store contract self-test — each check must go RED when broken",
  );
  let bad = 0;
  for (const [id, check] of Object.entries(CHECKS)) {
    if (!check.run(src).ok) {
      console.log(`  ✗ ${id}: already RED on HEAD — ${check.run(src).saw}`);
      bad += 1;
      continue;
    }
    let n = 0;
    for (const mutate of check.mutants) {
      if (check.run(mutate(src)).ok) {
        console.log(
          `  ✗ ${id}: mutant #${n} did NOT trip the check — it cannot detect its regression`,
        );
        bad += 1;
      }
      n += 1;
    }
    console.log(`  ✓ ${id}: green on HEAD, red under all ${check.mutants.length} mutant(s)`);
  }
  console.log(bad === 0 ? "SELF-TEST PASS" : `SELF-TEST FAIL (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
}

const ids = only ? [only] : Object.keys(CHECKS);
if (only && !CHECKS[only]) {
  console.error(`unknown --check=${only}; known: ${Object.keys(CHECKS).join(", ")}`);
  process.exit(2);
}
let failed = 0;
for (const id of ids) {
  const check = CHECKS[id];
  const r = check.run(src);
  console.log(`${r.ok ? "✓" : "✗"} ${id} — ${check.title}`);
  console.log(`    saw: ${r.saw}`);
  if (!r.ok) {
    console.log(`    → ${check.why}`);
    failed += 1;
  }
}
if (failed > 0) {
  console.error(`FAIL — ${failed} check(s) red`);
  process.exit(1);
}
console.log(`PASS — ${ids.join(", ")}`);
