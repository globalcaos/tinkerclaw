# Surgical UI retirement: production Tinker only

Date: 2026-09-09
Status: PARTIAL — the architect approved 2026-09-10. Vite HMR stopped; ui/ trashed; production Tinker on :18793 with /api/ui-state. Stock dashboard HTML still served by live gateway dist until a dist-swap (not done).
Repository: ~/src/tinkerclaw
Spec derived from the architect's request: remove the development UI and basic OpenClaw UI, carefully; preserve production Tinker. Write the whole plan before doing anything.

## Purpose, evidence, and revision rule

This plan removes two redundant serving surfaces and their exclusive code, not the infrastructure that makes the surviving UI function. It is based on read-only inspection of the current workspace manifests, build scripts, gateway route wiring, Tinker Vite configuration, production server, service definition, and tracked references. The initial census is 390 tracked files under ui/ and 110 src files containing controlUi; these are search populations, NOT deletion counts. Revise the deletion manifest whenever a real consumer is found. A name containing “control-ui” or “dev” is never sufficient evidence of dead code.

Only this Markdown plan is to be written during this planning request. Do not delete, stop, disable, rebuild, deploy, change configuration, update other documents, commit, or push as part of planning.

## 1. Intended end state

- Production Tinker remains the sole supported browser operator UI on this laptop.
- Preserve the current daily-driver address http://127.0.0.1:18793/tinker/ through this cleanup. Moving it onto the native gateway is not required and must not be bundled into retirement.
- Retire the persistent Vite development server on port 18790 and its dev-only launch/support code, rather than merely hiding its link.
- Remove the stock browser dashboard source at ui/, its exclusive build output, serving path, build/install/release hooks, dependencies and tests after extracting any surviving shared responsibilities.
- Keep tinker-ui/ source, production build capability, tests, production server, gateway, WebSocket/RPC interfaces, identity/auth/origin checks, media/canvas/embeds, plugins and persisted user data.
- Editing Tinker source does not reload the production tab. Updating production remains an explicit, tested release operation.
- Stock dashboard absence must not cause startup, doctor, installers or releases to rebuild it or complain that it is missing.

Interpretation: “remove development UI” means remove the dev-serving mode of Tinker, NOT delete Tinker source or Vite as a production compiler. Vite still supplies `vite build` and may be used by other packages. “basic OpenClaw UI” means the stock browser frontend, NOT the terminal TUI, gateway control APIs, or everything with a controlUi identifier.

## 2. Observed file map and ownership boundaries

Paths below are relative to the repository unless absolute.

| Surface                    | Observed entry points                                                                                                                              | Planned treatment                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tinker development service | ~/.config/systemd/user/tinker-ui.service; scripts/tinker-ui-dev.sh                                                                                 | Archive service definition and retire dev launcher during approved deployment                                                                                   |
| Tinker package             | tinker-ui/package.json                                                                                                                             | Remove dev and dev-port preview scripts; preserve build and required compiler dependencies                                                                      |
| Mixed build/dev config     | tinker-ui/vite.config.ts                                                                                                                           | Remove server/HMR/proxy and serve-only plugins only after endpoint parity review; preserve base, build stamp, defines, target es2022, output and build behavior |
| Production server          | scripts/tinker-prod-ui.mjs; ~/.config/systemd/user/tinker-prod-ui.service                                                                          | Preserve; extend only for a demonstrated feature needed from the retired dev server                                                                             |
| Stock frontend             | ui/; pnpm-workspace.yaml; package.json; pnpm-lock.yaml                                                                                             | Delete exclusive frontend after consumer extraction; remove workspace and dedicated scripts; regenerate lockfile normally                                       |
| Stock asset lifecycle      | src/infra/control-ui-assets.ts; src/gateway/server-control-ui-root.ts; scripts/ui.js                                                               | Remove stock-only discovery/auto-build path and callers; do not simply delete imports                                                                           |
| Gateway HTTP               | src/gateway/control-ui.ts; src/gateway/server-http.ts                                                                                              | Separate shared avatar/media/bootstrap responsibilities from stock SPA hosting before deleting stock host                                                       |
| CLI/wizards/update         | src/commands/doctor-ui.ts, doctor-update.ts, configure.wizard.ts; src/infra/update-runner.ts; src/wizard/onboarding.finalize.ts, setup.finalize.ts | Stop rebuilding/offering stock UI; retain gateway management and supported Tinker entry points                                                                  |
| Packaging                  | scripts/openclaw-prepack.ts, release-check.ts, install.sh, package-mac-app.sh; .github/workflows/                                                  | Remove stock-only requirements/artifacts; preserve unrelated platform behavior                                                                                  |
| Auth contracts             | src/gateway/http-auth-utils.ts, auth.ts, origin-check.ts, server/ws-connection/; controlUi config readers                                          | Preserve security semantics; do not infer ownership from naming                                                                                                 |
| Existing Tinker plugin     | extensions/tinkerclaw-tinker/index.ts                                                                                                              | Review existing uncommitted auth change; do not deploy wholesale auth bypass as a cleanup shortcut                                                              |

Read-only findings that matter:

1. The dev Vite configuration has four serve-only functions: tinkerDevConfig, openFilePlugin, kitContentPlugin, uiStatePlugin. They expose /api/open-file, /api/kit-content, /api/save-file and /api/ui-state, as well as auth/proxy behavior. They are more than HMR boilerplate.
2. The current production server explicitly proxies /tinker/api routes; parity for bare /api routes is not established by that fact. UI-state persistence and file/recipe editing need explicit checks before removing dev support.
3. Gateway server-http.ts gates avatar/media handlers alongside the stock UI. Setting controlUi.enabled=false blindly can remove functions that Tinker or other clients still need.
4. Stock ui/ is imported outside itself: src/gateway/reconnect-gating.test.ts imports its gateway helper; src/i18n/registry.test.ts and src/ui-app-settings.agents-files-refresh.test.ts reference stock files; scripts/sync-moonshot-docs.ts and scripts/dev/realtime-talk-live-smoke.ts also consume them. Classify each individually.
5. Root scripts include ui:build, ui:dev, ui:install, UI i18n/type/test commands. build-all.mjs has a separate multi-stage build pipeline: removing a single package script is not a complete lifecycle audit.
6. The repository has numerous unrelated uncommitted changes. No broad reset, clean, stash, or blanket commit is safe.

This is an initial map, not a falsely exhaustive deletion manifest. The first implementation phase must enumerate every consumer before authorizing a file's removal.

## 3. Contracts to freeze before implementation

For the survivor, record baseline behavior and preserve it across every phase:

- Production URL and /tinker/ base path; built hashed asset paths; no Vite/HMR client.
- WebSocket connect/challenge/hello and authenticated RPC behavior. An HTTP 200 is not proof of a working chat.
- Authenticated APIs retain authentication and scope enforcement. Origin rejection and unauthenticated sensitive access remain denied.
- Media/avatars, inline HTML embeds, canvas, attachments and file-opening behavior remain available to their existing authorized consumers.
- Session selection/history, model selection, budget display, tools, recipes, tasks, crons, voice/mute and saved panel/tab state retain their behavior.
- UI-state storage schema and file locations remain unchanged; migrate handlers rather than reset state.
- No changes to Goku, other hosts, WhatsApp archives, memory databases, credentials or training images.

Do not rename shared controlUi configuration keys during this removal. Consult the live schema with gateway config.schema.lookup before any later configuration proposal. Treat compatibility keys as retained infrastructure until their last consumer is removed or deliberately migrated.

Security correction to earlier discussion: serving stock HTML without auth does NOT imply that exposing all Tinker APIs or injecting a gateway secret into unrestricted HTML is equally safe. A conditional `auth: plugin` for the entire prefix does not preserve API protection automatically. This cleanup must neither expand exposure nor deploy that prior change without separate review and negative tests. Do not rewrite Origin headers to bypass checks.

## 4. Ordered execution phases (after approval only)

### A — Baseline and deletion manifest (read-only barrier)

Record git HEAD/status, deployment build provenance, process/service ownership, package scripts, all imports and filesystem reads referencing ui/, dist/control-ui, scripts/ui.js, control-ui assets, Vite serving and port 18790. Include untracked files, CI, Docker, packaging, installer/update paths and local launchers; separate historical fixtures/docs from executable references.

For every candidate record: exact path, consumer list, classification REMOVE / KEEP / EXTRACT FIRST, reason, test coverage and rollback source. Count each class. Do not treat a failed parser or no grep matches as proof: inspect raw inventories. Capture a browser baseline on the consented production tab. No production file writes in this phase.

Gate: no unresolved consumer of a proposed deletion; known existing defects recorded separately from cleanup regressions.

### B — Preserve dev-only functionality before retiring the server

Trace all four serve-only Vite plugins and client callers. For each endpoint, prove equivalent behavior exists in production or migrate the minimal handler into the existing authenticated backend/production-serving architecture. Do not create a second generic server framework. Preserve UI-state validation, atomic persistence and path-access controls.

Write failing tests for each missing parity case first; add the minimal implementation; run tests; drive the feature through production-style isolated serving. Especially test saving/restoring a tab or collapsed panel across reload and file/recipe read/save/open.

Gate: production functionality does not depend on any request reaching 18790 or Vite middleware.

### C — Decouple stock UI from shared backend functions

Extract only necessary shared media/avatar/bootstrap helpers from stock hosting modules. Keep existing URLs and signatures for surviving consumers. Retain or relocate shared test helpers instead of deleting backend coverage because its helper happened to live under ui/.

Inventory runtime, CLI, plugin SDK and cross-platform consumers before removing asset discovery/auto-build. Make stock SPA hosting absent while gateway HTTP/RPC and shared endpoints remain operational. Recommended root behavior: stock dashboard route returns 404; retain the known Tinker bookmark. Do not introduce cross-port redirects as a hidden new dependency.

Gate: isolated gateway starts without a stock UI asset directory; no stock auto-build; shared functionality and auth negative tests pass.

### D — Remove exclusive frontend and dev code

Once B and C pass, remove approved stock ui/ files and exclusive generated artifacts from the new build/package, dev launcher, serve-only config, stock scripts/test projects/i18n tooling, workspace entry, and exclusive dependencies. Keep Vite if Tinker build or another package still uses it. Keep Lit if required by Tinker (currently declared there).

Regenerate dependency lockfile using the repository's package-manager workflow; inspect removed packages rather than manually pruning shared lock nodes. Update CI/install/update/release and desktop/dashboard links so none rebuild or point to retired UIs. Test clean install, not just a workspace whose node_modules masks a missing dependency.

Gate: tracked-reference census reconciles to retained documented shared references or historical fixtures, not dangling executable imports. Fresh build contains no stock dashboard bundle and builds production Tinker successfully.

### E — Documentation and prevention

Update current setup/development/build instructions, dashboard/launch help, packaging expectations and local operating notes only after corresponding behavior is verified. Preserve historical incident records as history. Add regression coverage for stock assets not being auto-built and production edits not triggering HMR. Upstream merges must not silently reintroduce ui/ build requirements or the persistent dev service.

### F — Approved deployment and rollback

Build/test in an isolated worktree or staging copy carrying the explicitly selected relevant changes; a clean HEAD-only worktree may omit essential uncommitted Tinker work. Record exactly which patches form the candidate. Never overwrite the live tinker-ui/dist during verification.

Keep a known-good deployable production UI/gateway bundle, service definitions and relevant configuration backup. Schedule any gateway reload/dist swap with the architect; use supported deployment/restart tooling, not stop/start chained inside the live assistant process.

After candidate production passes browser checks, disable/stop only the identified tinker-ui.service and remove its autostart definition through recoverable archival. Verify port 18790 is closed and no process supervisor relaunches it. Keep tinker-prod-ui.service. Deploy the stock-host removal with the agreed procedure and repeat the checks below. No other host changes.

Rollback trigger: chat cannot connect, sensitive endpoints weaken, shared media breaks, persistence disappears, production address fails, or startup/install auto-builds missing stock UI. Restore previous versioned artifacts/config/service definitions; restart only through the approved procedure. Preserve user state and new messages throughout rollback. Re-enable the old dev service only if needed for recovery, not as the final solution.

## 5. Edit units and sequencing

Use serial barriers A → B → C → D → E → F. Avoid speculative parallel edits in this dirty tree.

- U1 inventory: writes only the eventual deletion manifest and baseline evidence.
- U2 Tinker parity: owns tinker-ui/vite.config.ts, client call sites, production server/backend parity tests. Complicated; isolate and prove before deletion.
- U3 shared gateway separation: owns stock host/shared endpoint modules, callers and gateway tests. Complicated; follows U2 contract audit.
- U4 retirement/integration: owns ui/ deletion, root manifests/lockfile, build/install/release/test orchestration. One owner because these files cross all areas.
- U5 docs and deployment: owns documentation, archived service definitions and approved runtime cutover. No source changes sneaked into deployment.

Exact patch code is deliberately not invented before A's complete consumer manifest. This plan gives the full sequence and acceptance gates, not a pretend deletion diff based on filename searches. This is a scoped deviation from the implementation-plan recipe's complete-code-per-task template: surgery must follow verified dependencies.

## 6. Verification commands and acceptance matrix

Run repository commands from ~/src/tinkerclaw, but build/install/test the candidate in its isolated copy. Current entry points verified in package.json:

```bash
pnpm --dir tinker-ui build
pnpm test:tinker-ui
pnpm test:auth:compat
pnpm test:gateway
pnpm build
```

Expected: production build and Tinker/auth/gateway tests pass; repository build succeeds without stock assets. If baseline tests already fail, record named failures and demonstrate no additional failures; never suppress unrelated red tests silently. Add the new regression tests to surviving test projects, not the removed stock test runner. Run affected installer/release CI jobs using their actual discovered commands after U4; do not substitute a passing unit suite for packaging proof.

Read-only live probes after approved cutover:

```bash
systemctl --user is-active tinker-prod-ui.service
systemctl --user is-enabled tinker-ui.service
ss -tlnp | grep ':18790 '
curl --max-time 5 -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18793/tinker/
curl --max-time 5 -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18789/
```

Expected: production active; dev unit disabled/not found; no 18790 listener; production HTTP 200; native root no stock SPA (recommended 404). Inspect full served HTML and asset responses to confirm built Tinker and no @vite/client. Do not infer rendering from this probe.

Browser acceptance, on an explicitly shared tab or an approved isolated test harness:

| Test                                         | Required result                                               |
| -------------------------------------------- | ------------------------------------------------------------- |
| Open production bookmark                     | Tinker renders; WebSocket connects; history loads             |
| Send one agreed smoke message                | One persisted reply appears, no duplicate                     |
| Reload and choose session                    | Same history and saved UI state                               |
| Model/budget/task/cron/recipe panels         | Expected controls and data, not empty placeholders            |
| Attachment/avatar/embed/canvas               | Visible and functional under existing access rules            |
| File and recipe editing                      | Read/save/open behavior preserved without Vite                |
| Source edit in isolated test checkout        | No HMR reload or WebSocket teardown on production-style tab   |
| Unauthorized API and disallowed Origin tests | Still denied; no widening of accessible paths                 |
| Cold start and clean install/package         | Tinker present; no stock dashboard dependency or regeneration |

Count before/after UI controls where retiring shared inputs could silently remove options. If browser access is unavailable, report visual and interaction checks UNVERIFIED and do not declare deployment complete.

## 7. Risks and alternatives

Highest risk: deleting code labelled Control UI that actually supplies authentication, media, shared helpers or startup behavior. Mitigation: C's extraction barrier and negative tests.

Other material risks: dev middleware owns hidden persistence/editing features (B); unrelated dirty changes enter the release (A/F); cached assets hide broken packaging (D clean build); stale bundles make source claims false (F served provenance); service restarts interrupt the owner's active session (explicit approval); accidental global dependency pruning removes Tinker's compiler (D consumer audit).

Rejected shortcuts: deleting all control-ui-named files; only disabling two services and calling code cleanup done; removing Vite globally; rebuilding the live bundle during planning; combining URL migration/auth redesign with retirement; deleting shared regression coverage simply to make tests green.

## 8. Definition of done and plan review

the architect has approved the interpretation. Both retired surfaces and exclusive code/build plumbing are gone, production Tinker remains at the same bookmark with its functions intact, no dev server returns on startup, clean packaging does not resurrect stock UI, shared APIs retain security, and a tested rollback exists.

Planning self-review: request coverage maps to phases B/D/F (dev retirement), C/D/F (stock retirement), and all phases (preserve production). Ownership is serial to avoid shared-file collisions. Complicated parity/separation precede deletion. Unknown consumer details are explicit discovery gates, not asserted facts. No implementation, deployment or source change was performed as part of authoring this plan.
