#!/usr/bin/env node
/**
 * topology.md D3 — the two-repo diagram and the workspace-symlink section — made executable.
 *
 * The INVARIANT lives in TINKER_UI_DESIGN_BIBLE/topology.md and is the authority.
 *
 *   --check=boundary       the FILESYSTEM cut D3 draws is intact. Code flows INTO the workspace by
 *                          symlink, so exactly one copy of it exists and that copy lives in the
 *                          public fork; private material flows out only by a deliberate copy.
 *                          `workspace/skills` and `workspace/memory` are REAL directories, never
 *                          symlinks — that is precisely so a `git add` in the fork can never sweep
 *                          up a private skill. `workspace/src` IS a symlink. The fork's origin is
 *                          GitHub, the workspace's is GitLab, and at least one top-level workspace
 *                          symlink still points into the fork.
 *   --check=derived-count  no frozen symlink COUNT creeps back into the prose, and both derive
 *                          commands survive. An earlier revision hard-coded the total as 164; the
 *                          real figure was 109 and the sentence was wrong four ways at once.
 *                          Anything countable is derived at check time, never written down.
 *
 * SCOPE, deliberately narrow: this is the STRUCTURAL half of the boundary only. It never inspects
 * file CONTENT. The POLICY half — what may cross — is owned by pii-boundary.md and its leak grep,
 * and the two must not be confused: green here means the valve still has the right shape, not that
 * nothing private has been written on the public side.
 *
 * FOUNDATION.md §"Three different jobs, three different homes" is why this encoding lives in
 * scripts/bible/. When this script and topology.md disagree, topology.md is right.
 *
 * Usage:
 *   node scripts/bible/topology-d3-two-repos.mjs                       # both checks
 *   node scripts/bible/topology-d3-two-repos.mjs --check=boundary
 *   node scripts/bible/topology-d3-two-repos.mjs --check=derived-count
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspace = path.join(os.homedir(), ".openclaw", "workspace");

const problems = [];
const notes = [];

function lstat(target) {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

function checkRemote(dir, expectedHost, side) {
  let url;
  try {
    url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    problems.push(
      `cannot read the origin remote of ${dir} (${String(err?.message ?? err).split("\n")[0]}) — ` +
        `D3's ${side} side is unverifiable`,
    );
    return;
  }
  if (!url.includes(expectedHost)) {
    problems.push(
      `${dir} origin is ${url}, not ${expectedHost} — D3's ${side} side is stale, and the two repos may ` +
        "no longer be the two repos this optic describes",
    );
  }
}

function checkBoundary() {
  for (const name of ["skills", "memory"]) {
    const st = lstat(path.join(workspace, name));
    if (!st) {
      problems.push(
        `workspace/${name} is missing — D3's private-state box has no counterpart on disk`,
      );
    } else if (st.isSymbolicLink()) {
      problems.push(
        `workspace/${name} became a symlink — the STRUCTURAL half of the PII boundary drawn in D3 is broken: ` +
          "private material would now sit one `git add` away from the public fork. See pii-boundary.md.",
      );
    } else if (!st.isDirectory()) {
      problems.push(`workspace/${name} is no longer a directory — D3 is stale`);
    }
  }

  const srcStat = lstat(path.join(workspace, "src"));
  if (!srcStat) {
    problems.push("workspace/src is missing — D3's symlink box has no counterpart on disk");
  } else if (!srcStat.isSymbolicLink()) {
    problems.push(
      "workspace/src is no longer a symlink into the fork — a SECOND copy of the code now exists, " +
        "which is exactly what D3's one-way valve is drawn to prevent",
    );
  }

  checkRemote(repoRoot, "github.com", "public");
  checkRemote(workspace, "gitlab.com", "private");

  let intoFork = 0;
  try {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      let target = "";
      try {
        target = readlinkSync(path.join(workspace, entry.name));
      } catch {
        continue;
      }
      if (target.includes("tinkerclaw")) intoFork += 1;
    }
  } catch (err) {
    problems.push(`cannot list ${workspace} (${String(err)}) — D3 is unverifiable on this machine`);
    return;
  }
  if (intoFork === 0) {
    problems.push(
      "no top-level workspace symlink points into the fork — D3's WLINK -> FCODE edge is stale",
    );
  } else {
    notes.push(`workspace -> fork symlinks = ${intoFork} (derived here, never frozen in prose)`);
  }
}

function checkDerivedCount() {
  const docPath = path.join(repoRoot, "TINKER_UI_DESIGN_BIBLE", "topology.md");
  let doc;
  try {
    doc = readFileSync(docPath, "utf8");
  } catch (err) {
    problems.push(
      `cannot read ${docPath} (${String(err)}) — the derived-count rule is unverifiable`,
    );
    return;
  }

  if (/There (are|were) \d+ such symlinks/.test(doc)) {
    problems.push(
      "a frozen symlink count came back into topology.md — countable things are derived at check time, " +
        "not written down. The last frozen figure was wrong in four different ways at once.",
    );
  }

  const RECIPES = [
    {
      cmd: "find ~/.openclaw/workspace -maxdepth 1 -type l | wc -l",
      why: "without it the next editor has nothing to run and will just freeze a number again",
    },
    {
      cmd: "find ~/.openclaw/workspace -maxdepth 1 -xtype l | wc -l",
      why: "without it the 'expect dangling links' note is unfalsifiable",
    },
  ];
  for (const recipe of RECIPES) {
    if (!doc.includes(recipe.cmd)) {
      problems.push(
        `the derive command \`${recipe.cmd}\` was removed from topology.md's workspace-symlink section — ${recipe.why}`,
      );
    }
  }
  notes.push("symlink count is derived, not frozen; both derive commands still present");
}

const which = (process.argv.find((a) => a.startsWith("--check=")) ?? "").slice(8);
if (which && which !== "boundary" && which !== "derived-count") {
  console.error(`unknown --check=${which} (expected: boundary | derived-count, or omit for both)`);
  process.exit(2);
}

if (which !== "derived-count") checkBoundary();
if (which !== "boundary") checkDerivedCount();

if (problems.length) {
  console.error("topology.md D3 no longer matches the filesystem it draws:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`D3: ${notes.join("; ")}.`);
