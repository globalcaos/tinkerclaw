---
schema: "kit/1.0"
slug: "drive-tinker-ui-control"
title: "Drive a Tinker UI control headless and LOOK at it (drag, hover, snap, overlay)"
summary: "Prove an interactive Tinker UI change the way the owner will meet it: serve the build on a private port, block every write to the live UI state, open the surface through its window hook, drive the gesture with Playwright from an UNCOVERED point, dump classes/opacity/text at each step, screenshot mid-gesture and look at the crop — then build the live bundle, grep what :18793 SERVES, and drive it again there."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "verify"
tags:
  [
    "tinker ui",
    "verify ui",
    "drag",
    "hover",
    "snap",
    "playwright",
    "headless",
    "screenshot",
    "drive the interaction",
    "render and look",
    "is it live",
    "served bundle",
  ]
testedHarnesses: ["Claude Code", "OpenClaw"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
    - [5]
    - [6]
---

# Drive a Tinker UI control headless and LOOK at it

> A control that only exists DURING a gesture (a drag readout, a hover row, a snap) cannot be
> verified by a test that renders markup, nor by a screenshot of the resting page. Drive the
> gesture, hold it, and look.

## Goal

Turn "the code for X is written" into "X appears where the owner looks, in the state he will
see it" — for any Tinker UI surface whose behaviour depends on pointer interaction.

**Why this exists (2026-09-23, SMARTNESS × COST plan waypoints).** Every unit test was green
and the first real press did nothing: the circle's centre was covered by a model-name label,
so the press never reached the draggable group. The first mid-drag screenshot then showed the
row's tags colliding with the drag readout — invisible to every string assertion. And the
previous change on the same chart had been merged but never BUILT, so the live page had been
serving the old bundle for four hours while the chat said "shipped". Three distinct failures,
each caught only by driving and looking.

## Inputs

- `{{worktree}}` — the worktree holding the change (never the shared checkout).
- `{{surface_hook}}` — how the surface opens, e.g. `window.__tzOpenSmartCost()`; find it with
  `grep -n "window.__tz" tinker-ui/src/app.ts`.
- `{{target_selector}}` — the element to grab / hover (e.g. `.sc-dotpos[data-util-drag][data-model="…"][data-effort="…"]`).
- `{{private_port}}` — any free loopback port that is NOT the live one (the live one is in TOOLS.md).

## Steps

### 0. Build the change and serve it privately

```bash
cd {{worktree}}/tinker-ui && npx vite build
cd {{worktree}} && TINKER_PROD_PORT={{private_port}} node scripts/tinker-prod-ui.mjs   # background
```

The worktree's OWN copy of `scripts/tinker-prod-ui.mjs` serves the worktree's `tinker-ui/dist`
(its DIST is relative to the script's repo root) against the real gateway. Nothing live changes.

### 1. Drive with writes BLOCKED

Playwright is in the repo (`node_modules/playwright-core`); launch the system Chrome. **Fulfil
every non-GET `/api/*` locally** — the UI-state file WINS the boot hydrate, and a headless page
that mirrors its (empty or stale) tab list back would overwrite the owner's real tabs.

```js
import { chromium } from "<repo>/node_modules/playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1800, height: 1150 } });
await page.route("**/api/**", (r) =>
  r.request().method() === "GET"
    ? r.continue()
    : r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
);
await page.goto(`http://127.0.0.1:${PORT}/tinker/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.__tzOpenSmartCost === "function"); // {{surface_hook}}
await page.evaluate(() => window.__tzOpenSmartCost());
await page.waitForSelector(TARGET);
```

### 2. Grab from an UNCOVERED point

A label, ring or sibling mark can sit over the target's centre; a press there lands on the
cover, exactly as it would for a human, and the gesture silently never starts. Probe a few
points inside the target and keep the first where the target is on top:

```js
const ok = (x, y) => document.elementFromPoint(x, y)?.closest?.(TARGET_GROUP) === target;
```

If NO point qualifies, that is itself a finding (the control is unreachable) — report it.

### 3. Hold the gesture and dump state at every step

`page.mouse.down()`, then `page.mouse.move(x, y, { steps: 8 })` to each point of interest —
for a snap, park a few px OFF the mark so the pull is what lands it. At each step read, from
the page: the readout text, `classList` flags, and `getComputedStyle(el).opacity` of the
active and of an inactive peer. Screenshot WHILE the button is held; `mouse.up()` last, then
read the resting state again (did it return home, did the readout reset?).

**Measure the channel the eye reads, not the class.** A `.sc-hl` class being present is
not "lit": on 2026-09-23 a hovered model carried `.sc-hl` on all 36 of its elements while
its path stayed at `stroke-opacity 0.34` — undimmed, never brightened. Read the computed
property that carries brightness (`strokeOpacity`, `fillOpacity`, `strokeWidth`), and read
the SAME property on a non-target peer, before and during the state.

**Headless frames are throttled — do not read a transition's midpoint as a delay.** In a
headless page a 0.22 s opacity transition read 0.19 at 500 ms. To check a _rule_, read the
computed `transition` / `transitionDelay` (a stagger delay shows up there as `1.05s`), or
inject `* { transition: none !important }` and read the end state; to check a _look_, wait
≥ 1.5 s or screenshot (which forces frames).

### 4. LOOK at the crops

Crop around the target (PIL) and open the PNG. String state proves wiring; only the picture
proves legibility — overlaps, collisions, contrast. Fix what the picture shows, rebuild, re-drive.

### 5. Typecheck what vite will not

`tinker-ui` has no tsconfig and `vite build` does not typecheck. Write an ad-hoc tsconfig
(`moduleResolution: Bundler`, `lib: [ES2023, DOM]`, `noEmit`, `types: ["vite/client"]`,
`files: [changed files]`) inside `tinker-ui/`, run `node scripts/run-tsgo.mjs -p <it>`, and
count errors ONLY on the line numbers `git diff -U0 develop` ADDED. `app.ts` carries hundreds
of pre-existing errors; the added-lines count is the gate.

### 6. Merge, BUILD, prove it is SERVED, drive it live

Merged is not live. After the merge into `develop`:

```bash
cd <shared checkout> && git status --short -- tinker-ui/src   # must be empty, or peers' WIP ships
cd tinker-ui && npx vite build
js=$(curl -s http://127.0.0.1:<live>/tinker/ | grep -o 'assets/index-[^"]*\.js' | head -1)
curl -s "http://127.0.0.1:<live>/tinker/$js" | grep -c "<a string only the new code has>"
```

Then re-run step 1–3 against the LIVE port (writes still blocked). Same numbers as the private
run = the owner's page behaves as verified. The owner still needs a tab reload to pick it up.

### 7. Tear down by ownership, not by pattern

Stop the private server by the PID that owns the port — `ss -ltnpH 'sport = :{{private_port}}'`
— after confirming `/proc/<pid>/environ` carries `TINKER_PROD_PORT={{private_port}}`. A
`pgrep -f` on the script path also matches the wrapper shell that launched it (and
`pkill -f` can match your own shell).

## Constraints

- Never drive the live port without the `/api/*` write block.
- Never claim appearance from markup or test output — a gesture-only state needs step 3–4.
- Never report "shipped" for a UI change until step 6's served-bundle grep returns > 0.

## Failures Overcome

- **Press landed on a label** (2026-09-23): `dragging:false` after `mouse.down()` on the
  circle centre; `elementsFromPoint` showed `text.sc-label` on top. Fixed by step 2.
- **Collision visible only in the picture** (2026-09-23): upward-stacked row tags sat under
  the drag readout; every assertion was green. Fixed by mirroring the active row's tags below
  during the drag — found by step 4.
- **Merged but never built** (2026-09-23): the plan-waypoint change merged 16:07; the live
  bundle stayed at 15:09 until a build at 20:32. Step 6 is the gate.
- **Hollow typecheck** (2026-09-23): `tsgo -p` with no config naming `tinker-ui/src` "passed"
  with zero errors because it checked nothing. Step 5's ad-hoc config is the fix — a check that
  cannot fail is not a check.
- **Class present, eye unmoved** (2026-09-23 #3): hover put `.sc-hl` on every element of
  the model and the test of "whole model lights up" would have passed on class counts; the
  computed stroke-opacity showed the path never brightened. Step 3's measure-the-channel.
- **A stagger delay on the wrong element** (2026-09-23 #3): the per-model glide stagger sat
  as an inline `transition-delay` on constellation LINES, which do not glide — so it
  delayed only the hover highlight, by up to ~1.1 s. Found by reading computed
  `transitionDelay`, not by timing the fade.
- **pgrep matched the wrapper** (2026-09-23): the ownership guard refused the kill because the
  matched PID's cwd was not the worktree. Step 7.
