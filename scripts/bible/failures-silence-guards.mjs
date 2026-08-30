#!/usr/bin/env node
/**
 * S6–S9 — source guards for the four silence-class faults found and fixed on 2026-08-04.
 *
 * Owner doc: TINKER_UI_DESIGN_BIBLE/failures.md § "Faults that surface as silence".
 * That file EXPLAINS the class; this file CHECKS that the guards each fix installed are
 * still in the source they were added to (FOUNDATION.md, "Three different jobs, three
 * different homes" — a `verify:` block is a pointer, not an embedded program).
 *
 * These are REGRESSION assertions, not liveness probes: they catch someone removing a
 * fix, not a fresh recurrence on a live box. The live checks belong in probes.md and
 * scripts/post-deploy-smoke.mjs.
 *
 * Usage:
 *   node scripts/bible/failures-silence-guards.mjs             # every guard
 *   node scripts/bible/failures-silence-guards.mjs --check=S7  # one guard
 *   node scripts/bible/failures-silence-guards.mjs --list      # what each guard asserts
 *   node scripts/bible/failures-silence-guards.mjs --self-test # prove each guard can go RED
 *
 * Every check PRINTS WHAT IT SAW — the same contract as scripts/post-deploy-smoke.mjs.
 * A guard that cannot read its file FAILS; it never passes on absence of evidence.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Each guard is a list of RULES over one file. A rule is either:
 *   { needs: [...] }                       — substrings that must be present
 *   { from, span, needs: [...] }           — substrings that must be present in the region
 *                                            starting at `from` (the anchor must exist too)
 *   { needle, atLeast }                    — an occurrence count floor
 * `why` is the message a human reads when the rule goes red: it must say what BREAKS,
 * not merely what is missing.
 */
const GUARDS = [
  {
    id: "S6",
    title:
      "the vec0 table's shape is READ BACK from sqlite_master, never assumed from persisted meta",
    fix: "bc16efe811c, corrected by b5d18a37b46",
    rules: [
      {
        file: "src/memory/manager-sync-ops.ts",
        needs: ["readVectorTableDims", "vectorDimsVerified", "vector_chunks00"],
        why:
          "the verify-the-shape guards are gone. ensureVectorTable goes back to recording a " +
          "dimension it never confirmed, a failed DROP leaves the old FLOAT[N] table alive behind " +
          "its vec0 shadow tables, and every insert throws forever under a log.warn. Measured " +
          "pre-fix on the live index: 5,258 chunks and ZERO vectors.",
      },
      {
        file: "src/memory/manager-sync-ops.ts",
        from: "private ensureVectorTable",
        span: 3200,
        needs: ["log.error(", "this.vector.available = false"],
        why:
          "the honest-degrade arm is gone — a shape the manager cannot fix must DISABLE vector " +
          "search loudly (keyword search keeps working), not throw on every insert at warn level.",
      },
    ],
  },
  {
    id: "S7",
    title: "a failed task-flow registration stays distinguishable from a healthy not-eligible",
    fix: "14b904b815c",
    rules: [
      {
        file: "src/tasks/task-executor.ts",
        needs: ["getSingleTaskFlowRegistrationHealth"],
        why:
          "the registration-health surface is gone — a failed ensureSingleTaskFlow again returns " +
          "a record byte-identical to the not-eligible result, which is how 93 failures went " +
          "unread for four months.",
      },
      {
        file: "src/tasks/task-flow-registry.store.sqlite.ts",
        needs: ["FLOW_RUNS_COLUMNS", "rebuildLegacyFlowRunsTable"],
        why:
          "FLOW_RUNS_COLUMNS is the single column source of truth (fresh-install DDL, rebuild " +
          "target and rebuild INSERT list); rebuildLegacyFlowRunsTable is what drops the legacy " +
          "owner_session_key TEXT NOT NULL. Without them every pre-existing database kills every " +
          "detached-run insert on SQLITE_CONSTRAINT_NOTNULL while fresh installs and the whole " +
          "test suite stay green.",
      },
    ],
  },
  {
    id: "S8",
    title:
      "every registered fork.* RPC is classified, and a scope denial is distinguishable from a healthy no-op",
    fix: "6ffba48adb2",
    rules: [
      {
        file: "src/gateway/method-scopes.ts",
        needle: '"fork.',
        atLeast: 19,
        why:
          "fork.* methods fell out of METHOD_SCOPE_GROUPS. Unclassified is a two-sided trap: the " +
          "client asks for [] while the server falls back to ADMIN_SCOPE, so every least-privilege " +
          "backend caller is refused `missing scope: operator.admin` ~1 ms in at warn level — and " +
          "the Overseer reads as having run and had nothing to say.",
      },
      {
        file: "src/gateway/method-scopes.ts",
        needs: ["export function isOperatorScopeDenial"],
        why: "the denial classifier is gone; nothing downstream can tell a refusal from a decline.",
      },
      {
        file: "src/fork/overseer-runtime.ts",
        needs: ["isOperatorScopeDenial"],
        why:
          "the Overseer no longer distinguishes a refusal — it folds back into the generic " +
          'reason:"spawn-error" warn.',
      },
      {
        file: "src/fork/idle-goals.ts",
        needs: ["scope-denied", "isIdleGoalFailure"],
        why:
          "the dedicated scope-denied reason (and the failure-vs-decline split) is gone from the " +
          "idle-goal loop, so a dead cycle reads as a quiet one again.",
      },
    ],
  },
  {
    id: "S9",
    title:
      "a conversation hook refused at registration reaches the JOURNAL, not only pushDiagnostic",
    fix: "63a9c346194",
    rules: [
      {
        file: "src/plugins/registry.ts",
        needs: ["conversation hook DROPPED"],
        why:
          "the refusal is back to pushDiagnostic() only — an array surfaced over an RPC nobody " +
          "polls. A whole subsystem can be switched off by a config default while a three-day " +
          "journal grep returns nothing and ENGRAM ingests nothing.",
      },
      {
        file: "src/plugins/registry.ts",
        needs: ["allowConversationAccess"],
        why: "the conversation-hook gate moved — re-derive S9 against its new home.",
      },
    ],
  },
];

function readSource(rel) {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** @returns {{ok: boolean, saw: string}} */
function evalRule(rule, text) {
  if (typeof rule.atLeast === "number") {
    const n = text.split(rule.needle).length - 1;
    return {
      ok: n >= rule.atLeast,
      saw: `${n} occurrence(s) of ${JSON.stringify(rule.needle)} (need >= ${rule.atLeast})`,
    };
  }
  let hay = text;
  if (rule.from) {
    const i = text.indexOf(rule.from);
    if (i < 0) {
      return { ok: false, saw: `anchor ${JSON.stringify(rule.from)} NOT FOUND` };
    }
    hay = text.slice(i, i + (rule.span ?? 2000));
  }
  const missing = rule.needs.filter((n) => !hay.includes(n));
  const scope = rule.from
    ? `within ${rule.span ?? 2000} chars of ${JSON.stringify(rule.from)}`
    : "in file";
  return {
    ok: missing.length === 0,
    saw:
      missing.length === 0
        ? `all ${rule.needs.length} token(s) present ${scope}: ${rule.needs.join(", ")}`
        : `MISSING ${scope}: ${missing.join(", ")}`,
  };
}

function runGuard(guard) {
  let failed = 0;
  console.log(`${guard.id} — ${guard.title}  [fix ${guard.fix}]`);
  for (const rule of guard.rules) {
    let text;
    try {
      text = readSource(rule.file);
    } catch (err) {
      // A guard that cannot read its file FAILS. "I saw nothing" is never a pass — that is
      // the exact conflation this optic's silence section exists to name.
      failed += 1;
      console.log(`  ✗ ${rule.file}: cannot read — ${String(err)}`);
      continue;
    }
    const r = evalRule(rule, text);
    if (!r.ok) failed += 1;
    console.log(`  ${r.ok ? "✓" : "✗"} ${rule.file}: ${r.saw}`);
    if (!r.ok) console.log(`      → ${rule.why}`);
  }
  return failed;
}

/**
 * Prove each guard can go RED. For every rule, mutate an in-memory copy of the real file
 * so the thing the rule guards is gone, and assert the rule fails on it — while the
 * unmutated file passes. A guard whose regex has rotted into matching nothing (or into
 * matching everything) fails here instead of silently passing forever.
 */
function selfTest() {
  let bad = 0;
  for (const guard of GUARDS) {
    for (const rule of guard.rules) {
      let text;
      try {
        text = readSource(rule.file);
      } catch (err) {
        console.log(`  ✗ ${guard.id} ${rule.file}: cannot read — ${String(err)}`);
        bad += 1;
        continue;
      }
      if (!evalRule(rule, text).ok) {
        console.log(
          `  ✗ ${guard.id} ${rule.file}: rule is RED on the real file (see --check=${guard.id})`,
        );
        bad += 1;
        continue;
      }
      const victims = rule.needs ?? [rule.needle];
      for (const victim of victims) {
        const broken = text.split(victim).join("");
        if (evalRule(rule, broken).ok) {
          console.log(
            `  ✗ ${guard.id} ${rule.file}: removing ${JSON.stringify(victim)} did NOT trip the rule ` +
              `— this guard cannot detect its own regression`,
          );
          bad += 1;
        }
      }
      console.log(
        `  ✓ ${guard.id} ${rule.file}: green on HEAD, red with each of ${victims.length} token(s) removed`,
      );
    }
  }
  return bad;
}

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--check=")) ?? "").slice("--check=".length);

if (args.includes("--list")) {
  for (const g of GUARDS) {
    console.log(`${g.id}  ${g.title}`);
    for (const r of g.rules) console.log(`      ${r.file}`);
  }
  process.exit(0);
}

if (args.includes("--self-test")) {
  console.log("failures.md S6–S9 self-test — each guard must go RED when its token is removed");
  const bad = selfTest();
  console.log(bad === 0 ? "SELF-TEST PASS" : `SELF-TEST FAIL (${bad})`);
  process.exit(bad === 0 ? 0 : 1);
}

const selected = only ? GUARDS.filter((g) => g.id === only) : GUARDS;
if (only && selected.length === 0) {
  console.error(`unknown --check=${only}; known: ${GUARDS.map((g) => g.id).join(", ")}`);
  process.exit(2);
}
let failures = 0;
for (const g of selected) failures += runGuard(g);
if (failures > 0) {
  console.error(`FAIL — ${failures} rule(s) red`);
  process.exit(1);
}
console.log(`PASS — ${selected.map((g) => g.id).join(", ")}`);
