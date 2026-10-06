# A built page against the live gateway's data, read-only

Built on 2026-10-05 to answer "some tabs appear without history" (bug-log `busy-tab-history-and-eeg`).
The mock gateways under `e2e/` prove a mechanism on invented rows. This harness shows what a build
does with the owner's real tabs: their real `chat.history` replies, archives and anatomy rows.

## Safety

`real-proxy.mjs` forwards only `chat.history` and `sessions.list` to the gateway, plus
`sessions.subscribe` and the live events when `FORWARD_EVENTS=1`. It proxies `GET
/tinker/api/context-anatomy` and answers everything else itself. There is no `/api/ui-state`, so the
page keeps its state in the browser context and the owner's `tinker-ui-state.json` is never written.
Nothing it forwards writes. An archive read can hold the gateway's event loop for seconds, so drive
one page at a time and stop the proxy when done.

## Use

```
vite build --outDir <dist>                      # the build under test (tinker-ui/node_modules/.bin/vite)
FORWARD_EVENTS=1 node real-proxy.mjs --port 18996 --dist <dist> [--dump <dir>]
node drive.mjs --url http://127.0.0.1:18996 [--tabs agent:main:tinker:<id>,...] [--cap 200]
```

Run the same tabs against develop's build as the control: a check that does not fail on the old
build proves nothing. `FORWARD_EVENTS=1` matters for anything a live run gates; on 2026-10-05 the
stock page opened Goku mid-turn with 31 rows and loaded nothing in 70 s of scrolling, while the fix
reached its first turn. `--dump` writes every `chat.history` reply whole, so a unit test can replay
what the page got through the page's own functions (`applyOlderReply`, `planOlderPage`).

## Reading the output

One JSON line per tab: rows and prompts when it opened and at the top, the oldest row on screen, the
archive dividers, whether the loading marker was still up, and the EEG paper's prompt markers and
trunk strokes. The oldest row comes from the proxy, which keys rows exactly as
`history-reconcile.ts historyRowIdentity` does (an import by `__openclaw.externalId`). Keyed by
`__openclaw.id` alone, most rows went unrecognised and three healthy tabs read as broken. Check
`known` against `rows` before trusting `oldest`.
