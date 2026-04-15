# AGENTS.md - Quick Reference

**Repo**: https://github.com/openclaw/openclaw  
**File refs**: repo-root relative only (e.g., `src/telegram/index.ts:80`).

## Essential Quick Commands

- **Install**: `pnpm install`
- **Dev**: `pnpm dev` or `pnpm openclaw ...`
- **Build**: `pnpm build` (hard gate before pushing main)
- **Type-check**: `pnpm tsgo`
- **Lint/format**: `pnpm check`, `pnpm format:fix`
- **Test**: `pnpm test` (preferred landing bar for main)
- **Test coverage**: `pnpm test:coverage`

## Critical Boundaries (Refactor Triggers)

If you see core code naming specific extensions/providers/channels for extension-owned behavior → refactor toward generic registry/capability/plugin-owned seams instead.

- **Plugin SDK**: `src/plugin-sdk/*` is the public contract; extensions may NOT import `src/**` directly.
- **Channels**: `src/channels/**` is core implementation; plugin authors use SDK instead.
- **Providers**: core owns inference loop; plugins own provider-specific behavior via registration.
- **Config**: prefer schema/zod at external boundaries; do not re-expose removed legacy keys in help/baselines.

## Quick Git / PR Rules

- Commit scope: related changes only; group with `scripts/committer "<msg>" <file...>`.
- PR template: `.github/pull_request_template.md`
- Main safety: no merge commits; rebase before pushing if main advanced.
- Before landing: `pnpm check`, `pnpm test`, `pnpm build` (build is hard gate if output/modules touched).

## Prompt Cache & Determinism

- Module assembly (maps, registries, plugin lists, MCP catalogs) must be deterministic-ordered.
- Do NOT rewrite recent transcript bytes unless invalidating cache is intentional.
- Keep cached prefix stable across turns.

## Test Performance Guardrails

- Avoid `vi.resetModules()` per-test in hot files; use static imports + `beforeAll`.
- Do not partial-mock broad barrels; add a plugin-local `*.runtime.ts` seam instead.
- Prefer explicit mock factories over `importOriginal()`.

## Release / PR Maintenance Skills

- **Release**: `$openclaw-release-maintainer` (`.agents/skills/openclaw-release-maintainer/SKILL.md`)
- **PR landing**: Follow `/landpr` (global Codex prompt at `~/.codex/prompts/landpr.md`)
- **PR triage**: `$openclaw-pr-maintainer` (`.agents/skills/openclaw-pr-maintainer/SKILL.md`)
- **GHSA**: `$openclaw-ghsa-maintainer` (`.agents/skills/openclaw-ghsa-maintainer/SKILL.md`)

- Runtime baseline: Node **22+** (keep Node + Bun paths working).
- Install deps: `pnpm install`
- If deps are missing (for example `node_modules` missing, `vitest not found`, or `command not found`), run the repo’s package-manager install command (prefer lockfile/README-defined PM), then rerun the exact requested command once. Apply this to test/build/lint/typecheck/dev commands; if retry still fails, report the command and first actionable error.
- Pre-commit hooks: `prek install`. The hook runs the repo verification flow, including `pnpm check`.
- `FAST_COMMIT=1` skips the repo-wide `pnpm format` and `pnpm check` inside the pre-commit hook only. Use it when you intentionally want a faster commit path and are running equivalent targeted verification manually. It does not change CI and does not change what `pnpm check` itself does.
- Also supported: `bun install` (keep `pnpm-lock.yaml` + Bun patching in sync when touching deps/patches).
- Prefer Bun for TypeScript execution (scripts, dev, tests): `bun <file.ts>` / `bunx <tool>`.
- Run CLI in dev: `pnpm openclaw ...` (bun) or `pnpm dev`.
- Node remains supported for running built output (`dist/*`) and production installs.
- Mac packaging (dev): `scripts/package-mac-app.sh` defaults to current arch.
- Type-check/build: `pnpm build`
- TypeScript checks: `pnpm tsgo`
- Lint/format: `pnpm check`
- Local agent/dev shells default to host-aware `OPENCLAW_LOCAL_CHECK=1` behavior for `pnpm tsgo` and `pnpm lint`; set `OPENCLAW_LOCAL_CHECK_MODE=throttled` to force the lower-memory profile, `OPENCLAW_LOCAL_CHECK_MODE=full` to keep lock-only behavior, or `OPENCLAW_LOCAL_CHECK=0` in CI/shared runs.
- Format check: `pnpm format` (oxfmt --check)
- Format fix: `pnpm format:fix` (oxfmt --write)
- Terminology:
  - "gate" means a verification command or command set that must be green for the decision you are making.
  - A local dev gate is the fast default loop, usually `pnpm check` plus any scoped test you actually need.
  - A landing gate is the broader bar before pushing `main`, usually `pnpm check`, `pnpm test`, and `pnpm build` when the touched surface can affect build output, packaging, lazy-loading/module boundaries, or published surfaces.
  - A CI gate is whatever the relevant workflow enforces for that lane (for example `check`, `check-additional`, `build-smoke`, or release validation).
- Local dev gate: prefer `pnpm check` for the normal edit loop. It keeps the repo-architecture policy guards out of the default local loop.
- CI architecture gate: `check-additional` enforces architecture and boundary policy guards that are intentionally kept out of the default local loop.
- Formatting gate: the pre-commit hook runs `pnpm format` before `pnpm check`. If you want a formatting-only preflight locally, run `pnpm format` explicitly.
- If you need a fast commit loop, `FAST_COMMIT=1 git commit ...` skips the hook’s repo-wide `pnpm format` and `pnpm check`; use that only when you are deliberately covering the touched surface some other way.
- Tests: `pnpm test` (vitest); coverage: `pnpm test:coverage`
- Generated baseline drift detection uses SHA-256 hash files under `docs/.generated/` (`.sha256` files tracked in git; full JSON baselines are gitignored, generated locally for inspection).
- Config schema drift uses `pnpm config:docs:gen` / `pnpm config:docs:check`.
- Plugin SDK API drift uses `pnpm plugin-sdk:api:gen` / `pnpm plugin-sdk:api:check`.
- If you change config schema/help or the public Plugin SDK surface, run the matching gen command and commit the updated `.sha256` hash file. Keep the two drift-check flows adjacent in scripts/workflows/docs guidance rather than inventing a third pattern.
- For narrowly scoped changes, prefer narrowly scoped tests that directly validate the touched behavior. If no meaningful scoped test exists, say so explicitly and use the next most direct validation available.
- Verification modes for work on `main`:
  - Default mode: `main` is relatively stable. Count pre-commit hook coverage when it already verified the current tree, avoid rerunning the exact same checks just for ceremony, and prefer keeping CI/main green before landing.
  - Fast-commit mode: `main` is moving fast and you intentionally optimize for shorter commit loops. Prefer explicit local verification close to the final landing point, and it is acceptable to use `--no-verify` for intermediate or catch-up commits after equivalent checks have already run locally.
- Preferred landing bar for pushes to `main`: in Default mode, favor `pnpm check` and `pnpm test` near the final rebase/push point when feasible. In fast-commit mode, verify the touched surface locally near landing without insisting every intermediate commit replay the full hook.
- Scoped tests prove the change itself. `pnpm test` remains the default `main` landing bar; scoped tests do not replace full-suite gates by default.
- Hard gate: if the change can affect build output, packaging, lazy-loading/module boundaries, or published surfaces, `pnpm build` MUST be run and MUST pass before pushing `main`.
- Default rule: do not land changes with failing format, lint, type, build, or required test checks when those failures are caused by the change or plausibly related to the touched surface. Fast-commit mode changes how verification is sequenced; it does not lower the requirement to validate and clean up the touched surface before final landing.
- For narrowly scoped changes, if unrelated failures already exist on latest `origin/main`, state that clearly, report the scoped tests you ran, and ask before broadening scope into unrelated fixes or landing despite those failures.
- Do not use scoped tests as permission to ignore plausibly related failures.

- **Version bumps**: `package.json`, `apps/android/build.gradle.kts`, `apps/ios/Info.plist`, `apps/macos/Info.plist`, `docs/install/updating.md`
- **Real devices first**: check connected iOS/Android before simulator/emulator.
- **Mobile pairing**: `ws://` allowed for RFC 1918/link-local/mDNS; `wss://` required for Tailscale/public.
- **macOS gateway**: runs as menubar app only; restart via app or `scripts/restart-mac.sh`.
- **macOS logs**: use `scripts/clawlog.sh` for unified log query.

## Multi-Agent Safety

- **Never** create/apply/drop `git stash` (other agents may be working).
- **Never** create/remove `git worktree` or switch branches unless explicitly requested.
- **Keep unrelated WIP untouched**; commit only your changes.
- **Auto-resolve formatting-only diffs** without asking.

## Full Reference

Detailed guidance: `bank/reference/agents-upstream-full.md` (architecture, boundaries, testing, security, platform, collaboration).
