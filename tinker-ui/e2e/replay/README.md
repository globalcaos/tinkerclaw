# Replay a real chat turn in a real browser

These scripts find chat divergences: the live page drawing something that a reload would not. They
replay one captured gateway turn into a built tinker-ui in headless Chromium, reload the page, and
compare the two pages bubble by bubble. They were built on 2026-10-03 to find the live answer
duplicates (bug-log `[mixed-coordinates+chat-divergence+early-return-drops-attribute]`) and the prompt
drawn twice (`[chat-divergence+scope-mismatch]`).

## 1. Capture a turn

```
node capture.mjs --session agent:main:tinker:<scratch> --prompt-file prompt.txt --out <capdir>
```

This records every frame of that session's run, a `chat.history` read every 8 s (`--history-every`)
and one after each final, and stops 60 s after the first final (`--settle`; `--timeout` 900 s caps
the whole capture). The turn is real: it runs on
the live gateway and costs a model call, so use a scratch session key. The token comes from
`OPENCLAW_GATEWAY_TOKEN` or the gateway config. `analyze-capture.py <capdir>` shows what came in.

## 2. Turn it into a scenario

```
node convert.mjs --cap <capdir> --out scen.json [--max-gap 3000]
```

`--max-gap` shortens every idle gap, and the timestamps inside the payloads with it, so a two-minute
turn replays in under one. By default the page sends the captured prompt itself and the run is bound
to the page's own key, as the gateway binds it. `show-scenario.py scen.json` prints the timeline.

## 3. Add what the page does

```
node with-actions.mjs scen.json scen-reload.json '[{"do":"reload","after":"delta-20"}]'
```

Actions are anchored to the turn's own frames (`send`, `delta-N`, `final-N`, `tool-N`, `thinking-N`,
`lifecycle-start`, ...): `switch-away`, `switch-back`, `reload`, `drop {ms}` (the mock closes every
socket), `offline {ms}` and `dump`.

## 4. Replay it

```
bash run.sh scen-reload.json <outdir> --dist <a built tinker-ui dist>
```

Build a dist of any commit with `npx vite build --outDir <dir>` in its `tinker-ui`. The default dist is
this checkout's `tinker-ui/dist`, and the default output folder is under `$TMPDIR/tinker-replay`.

## 5. Read the result

`<outdir>/summary.txt` lists the live page's bubbles and the reload's, the bubbles only one of them
has, copies and tails among the live bubbles, and the page's `[dup-prov]` console lines. When both
"only" lists are empty, the live page matches its reload.

**Before you blame a build**, look at when the page's history reads landed. Anything that turns on a
refresh or a switch-back depends on whether its read came before or after the turn's first final, and
the same build gives a different result when that moves. `show-run.py <outdir>` and
`req-window.py <outdir> <from> <to>` print the reads in scenario time. Compare two builds on the same
timing, and run each scenario twice.

`selftest.mjs` checks the mock's protocol emulation without a browser. `env-check.sh` shows where
`ws`, `playwright` and the browser come from; `HARNESS_WORKTREE` points the scripts at another
checkout's modules.
