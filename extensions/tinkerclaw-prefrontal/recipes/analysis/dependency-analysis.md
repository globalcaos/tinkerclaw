---
schema: recipe/1.0
id: dependency-analysis
title: Dependency Analysis
category: analysis
summary: Audit dependencies — inventory, vulnerabilities, risk assessment, upgrade plan
triggers: [dependencies, outdated, upgrade, "supply chain", "dep audit", "package audit"]
effort: standard
tools: [read, grep, glob, exec]
children: []
---

## Goal
Assess the health and risk profile of project dependencies and plan necessary updates.

## When to Use
- Periodic dependency review
- Before major upgrades
- After security advisories
- When investigating build or runtime issues caused by deps

## Steps

### 1. Inventory
**Tools:** exec, read
**Done when:** Complete dependency list with versions and purposes

List all direct and transitive dependencies. Identify which are dev-only vs production. Note native addon dependencies (better-sqlite3, opusscript, @discordjs/opus). Check `pnpm.onlyBuiltDependencies` for completeness.

### 2. Audit
**Tools:** exec
**Done when:** Vulnerability scan results collected

Run `pnpm audit`. Check for outdated packages (`pnpm outdated`). Identify deps that are unmaintained or archived. Check for known compatibility issues with the runtime (ESM vs CJS, native addons in bundlers).

### 3. Risk Assessment
**Tools:** read, grep
**Done when:** Each issue categorized by risk and effort

For each finding:
- **Severity:** Critical (exploitable CVE), High (outdated with known issues), Medium (outdated but stable), Low (cosmetic)
- **Upgrade effort:** Drop-in (patch), Minor (some API changes), Major (breaking changes), Replacement needed
- **Blast radius:** How many files import this dep? Is it deeply integrated?

### 4. Plan
**Done when:** Prioritized upgrade plan with order and rollback

Create upgrade plan ordered by:
1. Critical security fixes (immediate)
2. Breaking changes that block other upgrades
3. Feature upgrades that unblock development
4. Cosmetic updates (batch together)

Include rollback strategy for each major upgrade.

## Constraints
- Don't upgrade everything at once -- prioritize and batch
- Test after each batch of upgrades
- Native addon upgrades require rebuild verification
- Check that upstream fork compatibility is maintained

## Safety Notes
- Native addons (better-sqlite3, bindings) must be externalized in tsdown.config.ts
- After dep changes, verify `pnpm.onlyBuiltDependencies` is complete
- Upstream merges can add/remove deps -- check package.json after merge

## Failures Overcome
- **Upgrade cascade:** Agent upgrades one dep, which requires upgrading 5 others, which breaks the build. Risk assessment step identifies cascade risks before starting.
- **Native addon forgotten:** Agent adds a new native dep but doesn't add it to `onlyBuiltDependencies`. The inventory step now explicitly checks this array.
- **Bundler incompatibility:** Agent upgrades a dep that doesn't work with tsdown's ESM output. Audit step checks module format compatibility.
