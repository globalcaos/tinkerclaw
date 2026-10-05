---
name: conversation-loop
description: Hold a human-supervised, turn-by-turn dialogue with another agent in OpenClaw/TinkerClaw. Includes an evidence-first protocol for critique, option discovery, and bounded advocacy. Human initiation is an oversight requirement, not a provider-permission exemption; verify the target's model, authentication, and permitted use before driving it.
metadata:
  openclaw:
    emoji: 💬
    requires:
      bins: [node]
    env:
      - name: OPENCLAW_GATEWAY_URL
        required: false
        description: "Gateway base URL; default http://127.0.0.1:18789 (ws:// derived)."
      - name: OPENCLAW_GATEWAY_TOKEN
        required: false
        description: "Gateway operator token; falls back to gateway.auth.token in ~/.openclaw/openclaw.json."
---

# conversation-loop

_Renamed from `converse` on 2026-09-23 (the architect). The per-turn primitive keeps its file name, `scripts/converse.mjs`._

One reusable script, `scripts/converse.mjs`, that speaks a single turn INTO a gateway
session and reads the target agent's reply back. Build multi-turn AI↔AI loops by
calling it once per turn and composing your next turn from the reply.

## How the gateway makes this possible

Two RPC methods (the same path the Overseer uses to nudge Jarvis):

- **`sessions.send { key, message, idempotencyKey }`** — inject a message into a session
  as input. The agent bound to that session processes it and answers. The script prefixes
  every turn with the **`⟦AGENT:<label>⟧`** sentinel so the Tinker UI paints it as a blue
  agent bubble (see *Rendering* below). The ack carries the started **`runId`**.
- **`sessions.patch { key, model }`** — set the model the target tab runs on, without
  touching its history. This is how you put the other side on a specific model before the
  dialogue starts. There is no `sessions.setModel`, and saying `/model <id>` as a message
  is not a substitute (verified 2026-09-22 on the SharePoint tab).
- **`chat` events** — every delta/final/error/aborted event carries `{runId, sessionKey,
  state, message?}`. The reply to THIS turn is the terminal event whose `runId` matches
  the acked one. (`chat.history { sessionKey, limit }` still exists for `--read-only`.)

The script connects over the gateway WS (`connect.challenge` → `connect` with the
operator token), registers the event listener, sends, keeps the acked `runId`, and
finishes on the matching terminal event.

## Usage

```bash
# say one turn as MARCUS into a session, print the reply
node ~/.openclaw/workspace/skills/conversation-loop/scripts/converse.mjs \
  --session "agent:main:tinker:<tabId>" \
  --as MARCUS \
  --say "Your argument here..." \
  --wait 200 --json

# long turn from a file; echo deltas to stderr while waiting
node .../converse.mjs --session "<key>" --as AGENT --say-file ./turn.md --wait 600 --stream --json

# just read the newest assistant text without saying anything
node .../converse.mjs --session "<key>" --read-only --json

# after a timeout: reissue the SAME logical turn — the gateway returns the cached run
node .../converse.mjs --session "<key>" --say-file ./turn.md --idempotency-key <key-from-output>
```

Output (`--json`):
- success: `{"reply": "<text>", "runId", "idempotencyKey", "waitedMs", "stopReason"?, "emptyFinal"?: true}`
- run error: `{"error", "runId", "errorKind"?, "reason"?, "retryAfter"?, "partial"?}`
- timeout: `{"error": "timeout waiting for reply", "runId", "idempotencyKey", "unverifiedNewest": "<text|null>"}` —
  `unverifiedNewest` is a history read, NOT the correlated reply; treat it as a hint and
  reconcile with `--idempotency-key`.
- no `runId` in the ack (older gateway): `{"reply", "correlation": "history-fallback"}`.

## Rendering — blue bubble, titled with the driving tab's name

The UI only recognises three sentinels, all matched in `renderUserBubbleWithPromptToggle`
in `~/src/tinkerclaw/tinker-ui/src/app.ts`:

| prefix | badge | bubble |
|---|---|---|
| `⟦OVERSEER⟧` | 🔭 Overseer | blue `.msg.user.msg-agent` |
| `⟦AGENT⟧` | 🤖 Agent | blue `.msg.user.msg-agent` |
| `⟦AGENT:<label>⟧` | `<label>` (🤖 prepended unless the label already opens with an emoji) | blue `.msg.user.msg-agent` |

The blue is `#0a84ff` — `.msg.user.msg-agent` in `~/src/tinkerclaw/tinker-ui/src/styles/base.css`,
the house colour for "a machine wrote this, not the human". The bubble stays right-anchored
because it is still a user-role message; only the paint changes.

**Anything else renders as an ordinary green user bubble with the sentinel showing as
literal text.** Until 2026-09-23 this script emitted `⟦MARCUS⟧`, which matched nothing —
the skill claimed a generic `⟦NAME⟧` sentinel worked, and it never did. `--as` now feeds
the label slot: `--as MARCUS` → `⟦AGENT:MARCUS⟧` → badge "🤖 MARCUS".

With no `--as`, the label is resolved from the DRIVING side: `TC_SESSION_KEY` → that
session's `cookiePhrase` in `sessions.list` (a Tinker tab name such as "📿 Loop"). So the
human watching the target tab sees WHICH tab is steering it, not merely that something is.

## Master ↔ slave: let the slave WAKE the master (2026-09-23)

Polling (below) works but spends the master's whole turn watching a spinner, and a turn
that waits 15 minutes is a turn that can die holding the loop. The event-driven shape
instead: the master fires a turn and ENDS; when the slave finishes, a detached watcher
injects a wake-up prompt into the master's own tab, which starts a fresh master turn.

`scripts/wake-on-finish.mjs` is that watcher. It MUST be launched as a systemd user unit —
a subprocess started from inside an agent turn (even with `nohup`/`setsid`) is reaped when
that turn ends, which is exactly when this one needs to still be alive.

```bash
SLAVE=agent:main:tinker:muccguv1
S=~/.openclaw/workspace/skills/conversation-loop/scripts
rm -f /tmp/converse-wake.ready
# 1. arm the watcher (detached, outlives this turn)
systemd-run --user --unit=converse-wake --collect \
  node $S/wake-on-finish.mjs --watch "$SLAVE" --wake "$TC_SESSION_KEY" \
    --ready-file /tmp/converse-wake.ready --brief --timeout 3600
# 2. it must be LISTENING before the turn is sent, or a fast run is missed
for i in $(seq 1 40); do [ -s /tmp/converse-wake.ready ] && break; sleep 0.25; done
# 3. fire the turn and let go of it
node $S/converse.mjs --session "$SLAVE" --say-file /tmp/turn7.md --no-wait --json
# 4. END THE TURN. The wake-up arrives as a new prompt in the master's tab.
```

- **Payload.** By default the wake prompt carries the slave's ENTIRE final message, so the
  master reads the reply as its own next input. `--brief` sends only `turn finished,
  continue` — use it when the master must NOT read the slave's answer and is meant to
  judge the artifact instead. `--message` overrides the short line.
- **What the human sees.** The wake-up lands in the master's tab as a blue agent bubble
  badged with the SLAVE's tab name (`⟦AGENT:🖼️ SharePoint⟧`), so it is obvious which
  agent woke whom and that the prompt was not typed by the human.
- **"Finished" means the gateway says so, not the first `final`.** An agent run emits a
  `final` chat event for every assistant message segment (text before a tool call, more tools,
  then the next text). The first version woke on the first one and fired 12 s into a 10-minute
  Grok run (2026-09-23 06:24). The watcher now wakes only when `sessions.list` reports the
  slave as no longer `running`, having seen it running since arming. Terminal events only
  record the latest reply text and trigger an early check, and a 10 s poll covers any missed
  event.
- **Failure is loud.** On `--timeout` (default 3600 s) the watcher wakes the master anyway
  with a timeout note. A watcher that dies silently is worse than one that never armed.
- **One-shot by design.** It exits after one wake. Each round must re-arm, so an abandoned
  loop stops by itself instead of running unattended forever. Still agree a round budget
  and a stop condition with the human, and restate the stop condition in every turn.
- **Kill switch:** `systemctl --user stop converse-wake.service`. Check it with
  `systemctl --user status converse-wake.service`.

## Driving a long build/repair loop (mechanism verified 2026-09-22/23)

The pptx reconstruction run: a Claude tab drove a Grok tab through six fixes to a 53-slide
deck. What actually made it work, beyond the transport:

1. **Pin the far side's model first** — `openclaw gateway call sessions.patch --params
   '{"key":"agent:main:tinker:<id>","model":"xai/grok-4.6"}'`.
2. **Write each turn to a file, send with `--say-file`.** `/tmp/<topic>/turnN.md` keeps the
   turn reviewable, re-sendable under the same `--idempotency-key`, and free of shell quoting.
3. **`--wait` does NOT cover a real agent run** (fallback when no watcher is armed). These turns ran 5–15 minutes; converse
   times out long before that, and a timeout is NOT a delivery failure. Do not resend.
   Confirm with `chat.history limit 3` that the injected turn is there, then WAIT on the
   far side's own state instead:

   ```bash
   # foreground, tool timeout <= 600000ms, repeat the SAME call as often as needed
   for i in $(seq 1 100); do
     S=$(openclaw gateway call sessions.list --timeout 60000 2>/dev/null | python3 -c "
   import json,sys
   raw=sys.stdin.read(); raw=raw[raw.index('{'):]
   for s in json.loads(raw)['sessions']:
       if s.get('key')=='agent:main:tinker:<id>': print(s.get('status'))")
     [ "$S" != "running" ] && { echo 'RUN DONE'; break; }; sleep 10
   done
   ```

   When the turn produces a FILE, watch its mtime in the same loop (`stat -c %Y`) — a
   rewritten artifact is the real signal; `status` can still read `running` while the agent
   writes its summary.
4. **One defect per turn, with the verdict on the last one first.** Every turn opened with
   an explicit accept ("FIX #2 is accepted — title mismatches went 30 → 0, do not touch
   titles again") backed by a re-measured count, then exactly ONE new defect with its
   evidence (slide numbers, sizes, the source line that should have been used). Telling the
   far side not to ask questions and to rebuild to the same path keeps the loop closed.
5. **Audit the artifact yourself between turns.** The accept/reject verdict must come from
   re-opening the output, never from the other agent's report of its own work.

## Choosing a target session

- A **real chat tab** (`agent:main:main`, or a Tinker-UI tab `agent:main:tinker:<id>`)
  is chat-history-backed and works with this skill — the reply lands in `chat.history`
  and, for a UI tab, is watchable live.
- A **spawned subagent** (`fork.subagents.spawn`) runs headless: its transcript does
  NOT populate `chat.history` on the child key, so it is NOT a valid target here. For a
  watchable debate, create a dedicated Tinker-UI tab and inject into its key.
- Two tabs can share a title. Verify the key you inject into is the tab the human is
  watching before concluding "it did not render".

## Running a MARCUS-vs-PURIST style loop

1. Create (or pick) a dedicated tab; note its `agent:main:tinker:<id>` key.
2. `--say` your side's opening turn as `MARCUS`; read the tab agent's reply (it plays PURIST).
3. Compose the next turn from that reply; `--say` again. Repeat, bounded.
4. When a side raises a concrete, fixable objection about the code, describe and test
   the proposed remedy. Implement only within the user's authorized scope. A changed
   build is a new case: record its version and recheck the affected claims. Never
   change production, spending, or safeguards merely to win a debate.

## Guardrails

- **Human-supervised only.** Agree a round/time budget and stop conditions with the
  user. Do not wire this skill into cron/heartbeat/unattended loops. The target may
  use API billing or a subscription: check rather than assume. A human trigger does
  not make automated access manual or establish provider permission. Verify the
  relevant permission and its scope; a disclaimer is not authorization.
- Never switch to paid API usage, submit proposals, disclose private material, or
  promise company spend merely because the dialogue recommends it. Obtain the
  required user authorization and budget first.
- Never inject a debate into someone's real working tab (e.g. `agent:main:main`); it
  pollutes their session. Use a dedicated tab.

## Evidence-first dialogue protocol

**Purpose:** improve the user's decision, not produce a winner or a satisfying story.
**Basis:** the 2026-09-18–20 tinker-bridge inquiry exposed missed exceptions, rhetorical
certainty, repeated concessions, and summaries stronger than their sources.
**Revision trigger:** measured improvements or failures on later tasks; these gates
are working hypotheses, not proof that multi-agent dialogue outperforms one agent.

### 1. Define the decision before assigning roles

State the user's objective, constraints, decision owner, current artifact/version,
options (including doing nothing), time/round budget, and unacceptable downside.
Separate personal preferences from factual claims. Ask for missing private facts;
do not invent spend, company authority, audience demand, or tolerance of account loss.

Default sequence: independent assessment → cooperative option discovery → bounded
critique → synthesis → independent check. Courtroom advocacy is optional and only
for a narrow, explicit proposition. Never require a winner when evidence is insufficient.

### 2. Establish the record and check exceptions

Label inputs as OBSERVED, USER-STIPULATED, REPORTED, INFERRED, PROPOSED, or UNKNOWN.
A reconstructed chronology is not a raw transcript; agreement is not verification.
For decisive sources, record the exact passage, surrounding scope/preamble,
jurisdiction/version/date, and exceptions. Seek the strongest contrary primary
source before declaring an issue closed. Terms, explicit permissions in official
product guidance, actual implementation, and applicable law answer different questions.
Do not discard guidance when the contract expressly delegates permission to it.

Keep distinct: technical capability, observed billing, contractual permission,
legal enforceability, publication/distribution rights, operational enforcement risk,
and business value. Passing one test does not pass the others.

### 3. Use a claim ledger, not a scoreboard

For each decisive claim record: evidence, status/confidence, strongest objection,
what would change the conclusion, and which decision depends on it. Record concessions
with their scope and reason. Reopen only for new evidence, a changed premise/version,
or an identified reasoning error; preserve the prior entry and explain the delta.
A concession is not a fact. Two agents agreeing is not two independent sources.

### 4. Make each turn earn its cost

Each turn must add evidence, expose a specific inference error, narrow uncertainty,
or propose a materially different option. Restate the objective when the question
or artifact changes, not as a ritual every N messages. If no new information appears,
stop, investigate, or adjourn to a named evidence-gathering task. A cheap authorized
experiment is preferable to repeated analogies. Human requests do not exempt tests
from access, safety, or spending constraints.

Advocates must distinguish their strongest defensible argument from their own
assessment. No strategic misquotation, invented motive, unsupported probability,
or instruction to resist a warranted concession. Collaborative critics may agree;
forced disagreement produces noise just as forced agreement does. The rule:
**agreement needs evidence; disagreement needs a specific error or alternative;
neither earns credit by itself.**

### 5. Separate discovery from permission to act

Generate non-adversarial routes early: permission requests, sanctioned interfaces,
alternative architectures/providers, staged releases, and no-release options.
Compare them against the real objective and opportunity cost. A proposed control
is not an implemented/enforceable control. In particular, editable local code does
not establish ecosystem-wide caps, and automatic API fallback needs explicit budget
consent. Commercial interest is not immunity; an NDA is neither guaranteed nor a
substitute for checking ownership and disclosure authority.

### 6. Close on a decision, preserving uncertainty

Stop advocacy when recommendations converge or the budget expires. Then perform
one independent check of decisive premises and caveats, preferably without the
opponent's verdict. Report separately: established facts, interpretations, disputed
points, prudential recommendation, risks, and the next authorized action. Name the
remaining evidence that could change the decision. Do not translate a conditional
recommendation into a legal clearance or promised outcome.

Check the final summary against the transcript: no dropped conditions, invented
consensus, hypothetical build presented as deployed, or 'low risk' becoming 'no risk'.
Mark superseded advice visibly rather than leaving contradictory instructions active.
Provide a concise reasoning/evidence summary, not private chain-of-thought.

## Transport — reply correlation (repaired 2026-09-20)

Until 2026-09-20 the script polled `chat.history(limit: 30)` and waited for the array
to GROW. Once a session already held 30 messages that condition could never be met, so
every long dialogue "timed out" although the reply had landed. The repair correlates
by the gateway's own identity: one stable `idempotencyKey` per logical turn, the acked
`runId` retained, listener registered BEFORE sending (events can precede the ack and
are buffered), acceptance only on the terminal `final` | `error` | `aborted` event whose
`runId` matches, `inject-user-*` echoes ignored, identical/empty finals allowed.

Known remaining gaps (make them regression tests before relying on them):
- The deployed gateway must return `runId` in the `sessions.send` ack; otherwise the
  script degrades to `correlation: "history-fallback"` (timestamp-based, unverified).
- A `sessionKey` mismatch between the request key and the event's canonical key is
  reported as `eventSessionKey`, not treated as a failure.
- Reconnect/replay is not implemented: after a WS drop, reconcile with the same
  `--idempotency-key` rather than resending under a new one.
- After a timeout, inspect the destination history before resending: delivery may
  have succeeded. Do not claim UI rendering from a successful injection alone.
