---
schema: recipe/1.0
id: fork-patch
title: Fork Patch
category: coding
summary: Create or restore a fork-specific patch that survives upstream merges
triggers: [patch, "fork fix", wiring, "apply patch", "fork-specific"]
effort: standard
tools: [read, grep, glob, exec, edit]
children: []
---

## Goal
Create a fork-specific modification that is documented, testable, and automatically restorable after upstream merges.

## When to Use
- Adding fork-specific behavior to upstream files
- Restoring a patch that was wiped by an upstream merge
- Creating a new wiring point for a fork extension
- Modifying upstream behavior for the fork's needs

## Steps

### 1. Identify
**Tools:** read, grep
**Done when:** Exact files and lines identified, upstream intent understood

Read the upstream code being modified. Understand what it does and why. Check if the modification already exists in FORK_PATCHES.md. Verify the change is truly fork-specific (not a bug fix that should go upstream).

### 2. Write Patch
**Tools:** edit
**Done when:** Minimal change applied with FORK: comment

Apply the smallest change needed. Add a `// FORK:` comment explaining why. For import additions, group fork imports separately. For function renames, document old and new names.

### 3. Add to Apply-Fork-Wiring
**Tools:** read, edit
**Done when:** Patch function added to apply-fork-wiring.mjs

Add a new patch function to `scripts/apply-fork-wiring.mjs` that can re-apply this modification automatically. The function should be idempotent (safe to run multiple times). Add it to the TIER1 file list if the file is routinely overwritten by `--theirs`.

### 4. Verify with Guardian
**Tools:** exec
**Done when:** Guardian check passes for the new patch

Add a check to `merge-guardian.sh` that verifies the patch is in place. Run the guardian to confirm it passes. Run the full build to ensure no breakage.

## Constraints
- Every fork patch must have a `// FORK:` comment
- Every fork patch must be in FORK_PATCHES.md
- Every fork patch should have an automated re-apply function
- Every fork patch should have a guardian check
- Patches should be minimal -- don't restructure upstream code

## Safety Notes
- Fork patches in TIER1 files WILL be overwritten by `--theirs` on every merge
- Without apply-fork-wiring automation, patches silently disappear
- Test the patch function by removing the patch and re-applying

## Failures Overcome
- **Undocumented patch:** Fork modification made but not tracked. Next upstream merge silently removed it. FORK_PATCHES.md is now mandatory.
- **Non-idempotent patch function:** Patch function added duplicate imports when run twice. All patch functions must check before applying.
- **Guardian gap:** Patch applied but no guardian check added. Merge removed it months later, no one noticed. Every patch needs a corresponding guardian check.
