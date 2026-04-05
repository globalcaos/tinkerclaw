---
title: "QA E2E Automation"
summary: "Design note for a full end-to-end QA system built on a synthetic message-channel plugin, Dockerized OpenClaw, and subagent-driven scenario execution"
read_when:
  - You are designing a true end-to-end QA harness for OpenClaw
  - You want a synthetic message channel for automated feature verification
  - You want subagents to discover features, run scenarios, and propose fixes
---

# QA E2E Automation

This note proposes a true end-to-end QA system for OpenClaw built around a
real channel plugin dedicated to testing.

The core idea:

- run OpenClaw inside Docker in a realistic gateway configuration
- expose a synthetic but full-featured message channel as a normal plugin
- let a QA harness inject inbound traffic and inspect outbound state
- let OpenClaw agents and subagents explore, verify, and report on behavior
- optionally escalate failing scenarios into host-side fix workflows that open PRs

This is not a unit-test replacement. It is a product-level system test layer.

## Chosen direction

The initial direction for this project is:

- build the full system inside this repo
- test against a matrix, not a single model/provider pair
- use Markdown reports as the first output artifact
- defer auto-PR and auto-fix work until later
- treat Slack-class semantics as the MVP transport target
- keep orchestration simple in v1, with a host-side controller that exercises
  the moving parts directly
- evolve toward OpenClaw becoming the orchestration layer later, once the
  transport, scenario, and reporting model are proven

## Goals

- Test OpenClaw through a real messaging-channel boundary, not only `chat.send`
  or embedded mocks.
- Verify channel semantics that matter for real use:
  - DMs
  - channels/groups
  - threads
  - edits
  - deletes
  - reactions
  - polls
  - attachments
- Verify agent behavior across realistic user flows:
  - memory
  - thread binding
  - model switching
  - cron jobs
  - subagents
  - approvals
  - routing
  - channel-specific `message` actions
- Make the QA runner capable of feature discovery:
  - read docs
  - inspect plugin capability discovery
  - inspect code and config
  - generate a scenario protocol
- Support deterministic protocol tests and best-effort real-model tests as
  separate lanes.
- Allow automated bug triage artifacts that can feed a host-side fix worker.

## Non-goals

- Not a replacement for existing unit, contract, or live tests.
- Not a production channel.
- Not a requirement that all bug fixing happen from inside the Dockerized
  OpenClaw runtime.
- Not a reason to add test-only core branches for one channel.

## Why a channel plugin

OpenClaw already has the right boundary:

- core owns the shared `message` tool, prompt wiring, outer session
  bookkeeping, and dispatch
- channel plugins own:
  - config
  - pairing
  - security
  - session grammar
  - threading
  - outbound delivery
  - channel-owned actions and capability discovery

That means the cleanest design is:

- a real channel plugin for QA transport semantics
- a separate QA control plane for injection and inspection

This keeps the test transport inside the same architecture used by Slack,
Discord, Teams, and similar channels.

## System overview

The system has five pieces.

1. `qa-channel` plugin

- Bundled extension under `extensions/qa-channel`
- Normal `ChannelPlugin`
- Behaves like a Slack/Discord/Teams-class channel
- Registers channel-owned message actions through the shared `message` tool

2. `qa-bus` sidecar

- Small HTTP and/or WS service
- Canonical state store for synthetic conversations, messages, threads,
  reactions, edits, and event history
- Accepts inbound events from the harness
- Exposes inspection and wait APIs for assertions

3. Dockerized OpenClaw gateway

- Runs as close to real deployment as practical
- Loads `qa-channel`
- Uses normal config, routing, session, cron, and plugin loading

4. QA orchestrator

- Host-side runner or dedicated OpenClaw-driven controller
- Provisions scenario environments
- Seeds config
- Resets state
- Executes test matrix
- Collects structured outcomes

5. Auto-fix worker

- Host-side workflow
- Creates a worktree
- launches a coding agent
- runs scoped verification
- opens a PR

The auto-fix worker should start outside the container. It needs direct repo
and GitHub access, clean worktree control, and better isolation from the
runtime under test.

## High-level flow

1. Start `qa-bus`.
2. Start OpenClaw in Docker with `qa-channel` enabled.
3. QA orchestrator injects inbound messages into `qa-bus`.
4. `qa-channel` receives them as normal inbound traffic.
5. OpenClaw runs the agent loop normally.
6. Outbound replies and channel actions flow back through `qa-channel` into
   `qa-bus`.
7. QA orchestrator inspects state or waits on events.
8. Orchestrator records pass/fail/flaky/unknown plus artifacts.
9. Severe failures optionally emit a bug packet for the host-side fix worker.

## Lanes

The system should have two distinct lanes.

### Lane A: deterministic protocol lane

Use a deterministic or tightly controlled model setup.

Preferred options:

- a canned provider fixture
- the bundled `synthetic` provider when useful
- fixed prompts with exact assertions

Purpose:

- verify transport and product semantics
- keep flakiness low
- catch regressions in routing, memory plumbing, thread binding, cron, and tool
  invocation

### Lane B: quality lane

Use real providers and real models in a matrix.

Purpose:

- verify that the agent can still do good work end to end
- evaluate feature discoverability and instruction following
- surface model-specific breakage or degraded behavior

Expected result type:

- best-effort
- rubric-based
- more tolerant of wording variation

Matrix guidance for v1:

- start with a small curated matrix, not "everything configured"
- keep deterministic protocol runs separate from quality runs
- report matrix cells independently so one provider/model failure does not hide
  transport correctness

Do not mix these lanes. Protocol correctness and model quality should fail
independently.

## Use existing bootstrap seam first

Before the custom channel exists, OpenClaw already has a useful bootstrap path:

- admin-scoped synthetic originating-route fields on `chat.send`
- synthetic message-channel headers for HTTP flows

That is enough to build a first QA controller for:

- thread/session routing
- ACP bind flows
- subagent delivery
- cron wake paths
- memory persistence checks

This should be Phase 0 because it de-risks the scenario protocol before the
full channel lands.

## `qa-channel` plugin design

## Package layout

Suggested package:

- `extensions/qa-channel/`

Suggested file layout:

- `package.json`
- `openclaw.plugin.json`
- `index.ts`
- `setup-entry.ts`
- `api.ts`
- `runtime-api.ts`
- `src/channel.ts`
- `src/channel-api.ts`
- `src/config-schema.ts`
- `src/setup-core.ts`
- `src/setup-surface.ts`
- `src/runtime.ts`
- `src/channel.runtime.ts`
- `src/inbound.ts`
- `src/outbound.ts`
- `src/state-client.ts`
- `src/targets.ts`
- `src/threading.ts`
- `src/message-actions.ts`
- `src/probe.ts`
- `src/doctor.ts`
- `src/*.test.ts`

Model it after Slack, Discord, Teams, or Google Chat packaging, not as a one-off
test helper.

## Capabilities

MVP capabilities:

- one account
- DMs
- channels
- threads
- send text
- reply in thread
- read
- edit
- delete
- react
- search
- upload-file
- download-file

Phase 2 capabilities:

- polls
- member-info
- channel-info
- channel-list
- pin and unpin
- permissions
- topic create and edit

These map naturally onto the shared `message` tool action model already used by
channel plugins.

## Conversation model

Use a stable synthetic grammar that supports both simplicity and realistic
coverage.

Suggested ids:

- DM conversation: `dm:<user-id>`
- channel: `chan:<space-id>`
- thread: `thread:<space-id>:<thread-id>`
- message id: `msg:<ulid>`

Suggested target forms:

- `qa:dm:<user-id>`
- `qa:chan:<space-id>`
- `qa:thread:<space-id>:<thread-id>`

The plugin should own translation between external target strings and canonical
conversation ids.

## Pairing and security

Even though this is a QA channel, it should still implement real policy
surfaces:

- DM allowlist / pairing flow
- group policy
- mention gating where relevant
- trusted sender ids

Reason:

- these are product features and should be testable through the QA transport
- the QA lane should be able to verify policy failures, not only happy paths

## Threading model

Threading is one of the main reasons to build this channel.

Required semantics:

- create thread from a top-level message
- reply inside an existing thread
- list thread messages
- preserve parent message linkage
- let OpenClaw thread binding attach a session to a thread

The QA bus must preserve:

- conversation id
- thread id
- parent message id
- sender id
- timestamps

## Channel-owned message actions

The plugin should implement `actions.describeMessageTool(...)` and
`actions.handleAction(...)`.

MVP action list:

- `send`
- `read`
- `reply`
- `react`
- `edit`
- `delete`
- `thread-create`
- `thread-reply`
- `search`
- `upload-file`
- `download-file`

This is enough to test the shared `message` tool end to end with real channel
semantics.

## `qa-bus` design

`qa-bus` is the transport simulator and assertion backend.

It should not know OpenClaw internals. It should know channel state.

For v1, keep `qa-bus` in this repo so:

- fixtures and scenarios evolve with product code
- the transport contract can change in lock-step with the plugin
- CI and local dev do not need another repo checkout

## Responsibilities

- accept inbound user/platform events
- persist canonical conversation state
- persist append-only event log
- expose inspection APIs
- expose blocking wait APIs
- support reset per scenario or per suite

## Transport

HTTP is enough for MVP.

Suggested endpoints:

- `POST /reset`
- `POST /inbound/message`
- `POST /inbound/edit`
- `POST /inbound/delete`
- `POST /inbound/reaction`
- `POST /inbound/thread/create`
- `GET /state/conversations`
- `GET /state/messages`
- `GET /state/threads`
- `GET /events`
- `POST /wait`

Optional WS stream:

- `/stream`

Useful for live event taps and debugging.

## State model

Persist three layers.

1. Conversation snapshot

- participants
- type
- thread topology
- latest message pointers

2. Message snapshot

- sender
- content
- attachments
- edit history
- reactions
- parent and thread linkage

3. Append-only event log

- canonical timestamp
- causal ordering
- source: inbound, outbound, action, system
- payload

The append-only log matters because many QA assertions are event-oriented, not
just state-oriented.

## Assertion API

The harness needs waiters, not just snapshots.

Suggested `POST /wait` contract:

- `kind`
- `match`
- `timeoutMs`

Examples:

- wait for outbound message matching text regex
- wait for thread creation
- wait for reaction added
- wait for message edit
- wait for no event of type X within Y ms

This gives stable tests without custom polling code in every scenario.

## QA orchestrator design

The orchestrator should own scenario planning and artifact collection.

Start host-side. Later, OpenClaw can orchestrate parts of it.

This is the chosen v1 direction.

Why:

- simpler to iterate while the transport and scenario protocol are still moving
- easier access to the repo, logs, Docker, and test fixtures
- easier artifact collection and report generation
- avoids over-coupling the first version to subagent behavior before the QA
  protocol itself is stable

## Inputs

- docs pages
- channel capability discovery
- configured provider/model lane
- scenario catalog
- repo/test metadata

## Outputs

- structured protocol report
- scenario transcript
- captured channel state
- gateway logs
- failure packets

For v1, the primary output is a Markdown report.

Suggested report sections:

- suite summary
- environment
- provider/model matrix
- scenarios passed
- scenarios failed
- flaky or inconclusive scenarios
- captured evidence links or inline excerpts
- suspected ownership or file hints
- follow-up recommendations

## Scenario format

Use a data-driven scenario spec.

Suggested shape:

```json
{
  "id": "thread-memory-recall",
  "lane": "deterministic",
  "preconditions": ["qa-channel", "memory-enabled"],
  "steps": [
    {
      "type": "injectMessage",
      "to": "qa:dm:user-a",
      "text": "Remember that the deploy key is kiwi."
    },
    { "type": "waitForOutbound", "match": { "textIncludes": "kiwi" } },
    { "type": "injectMessage", "to": "qa:dm:user-a", "text": "What was the deploy key?" },
    { "type": "waitForOutbound", "match": { "textIncludes": "kiwi" } }
  ],
  "assertions": [{ "type": "outboundTextIncludes", "value": "kiwi" }]
}
```

Keep the execution engine generic and the scenario catalog declarative.

## Feature discovery

The orchestrator can discover candidate scenarios from three sources.

1. Docs

- channel docs
- testing docs
- gateway docs
- subagents docs
- cron docs

2. Runtime capability discovery

- channel `message` action discovery
- plugin status and channel capabilities
- configured providers/models

3. Code hints

- known action names
- channel-specific feature flags
- config schema

This should produce a proposed protocol with:

- must-test
- can-test
- blocked
- unsupported

## Scenario classes

Recommended catalog:

- transport basics
  - DM send and reply
  - channel send
  - thread create and reply
  - reaction add and read
  - edit and delete
- policy
  - allowlist
  - pairing
  - group mention gating
- shared `message` tool
  - read
  - search
  - reply
  - react
  - upload and download
- agent quality
  - follows channel context
  - obeys thread semantics
  - uses memory across turns
  - switches model when instructed
- automation
  - cron add and run
  - cron delivery into channel
  - scheduled reminders
- subagents
  - spawn
  - announce
  - threaded follow-up
  - nested orchestration when enabled
- failure handling
  - unsupported action
  - timeout
  - malformed target
  - policy denial

## OpenClaw as orchestrator

Longer-term, OpenClaw itself can coordinate the QA run.

Suggested architecture:

- one controller session
- N worker subagents
- each worker owns one scenario or scenario shard
- workers report structured results back to controller

Good fits for existing OpenClaw primitives:

- `sessions_spawn`
- `subagents`
- cron-based wakeups for long-running suites
- thread-bound sessions for scenario-local follow-up

Best near-term use:

- controller generates the plan
- workers execute scenarios in parallel
- controller synthesizes report

Avoid making the controller also own host Git operations in the first version.

Chosen direction:

- v1: host-side controller
- v2+: OpenClaw-native orchestration once the scenario protocol and transport
  model are stable

## Auto-fix workflow

The system should emit a structured bug packet when a scenario fails.

Suggested bug packet:

- scenario id
- lane
- failure kind
- minimal repro steps
- channel event transcript
- gateway transcript
- logs
- suspected files
- confidence

Host-side fix worker flow:

1. receive bug packet
2. create detached worktree
3. launch coding agent in worktree
4. write failing regression first when practical
5. implement fix
6. run scoped verification
7. open PR

This should remain host-side at first because it needs:

- repo write access
- worktree hygiene
- git credentials
- GitHub auth

Chosen direction:

- do not auto-open PRs in v1
- emit Markdown reports and structured failure packets first
- add host-side worktree + PR automation later

## Rollout plan

## Phase 0: bootstrap on existing synthetic ingress

Build a first QA runner without a new channel:

- use `chat.send` with admin-scoped synthetic originating-route fields
- run deterministic scenarios against routing, memory, cron, subagents, and ACP
- validate protocol format and artifact collection

Exit criteria:

- scenario runner exists
- structured protocol report exists
- failure artifacts exist

## Phase 1: MVP `qa-channel`

Build the plugin and bus with:

- DM
- channels
- threads
- read
- reply
- react
- edit
- delete
- search

Target semantics:

- Slack-class transport behavior
- not full Teams-class parity yet

Exit criteria:

- OpenClaw in Docker can talk to `qa-bus`
- harness can inject + inspect
- one green end-to-end suite across message transport and agent behavior

## Phase 2: protocol expansion

Add:

- attachments
- polls
- pins
- richer policy tests
- quality lane with real provider/model matrix

Exit criteria:

- scenario matrix covers major built-in features
- deterministic and quality lanes are separated

## Phase 3: subagent-driven QA

Add:

- controller agent
- worker subagents
- scenario discovery from docs + capability discovery
- parallel execution

Exit criteria:

- one controller can fan out and synthesize a suite report

## Phase 4: auto-fix loop

Add:

- bug packet emission
- host-side worktree runner
- PR creation

Exit criteria:

- selected failures can auto-produce draft PRs

## Risks

## Risk: too much magic in one layer

If the QA channel, bus, and orchestrator all become smart at once, debugging
will be painful.

Mitigation:

- keep `qa-channel` transport-focused
- keep `qa-bus` state-focused
- keep orchestrator separate

## Risk: flaky assertions from model variance

Mitigation:

- deterministic lane
- quality lane
- different pass criteria

## Risk: test-only branches leaking into core

Mitigation:

- no core special cases for `qa-channel`
- use normal plugin seams
- use admin synthetic ingress only as bootstrap

## Risk: auto-fix overreach

Mitigation:

- keep fix worker host-side
- require explicit policy for when PRs can open automatically
- gate with scoped tests

## Risk: building a fake platform nobody uses

Mitigation:

- emulate Slack/Discord/Teams semantics, not an abstract transport
- prioritize features that stress shared OpenClaw boundaries

## MVP recommendation

If building this now, start with this exact order.

1. Host-side scenario runner using existing synthetic originating-route support.
2. `qa-bus` sidecar with state, events, reset, and wait APIs.
3. `extensions/qa-channel` MVP with DMs, channels, threads, reply, read, react,
   edit, delete, and search.
4. Markdown report generator for suite + matrix output.
5. One deterministic end-to-end suite:
   - inject inbound DM
   - verify reply
   - create thread
   - verify follow-up in thread
   - verify memory recall on later turn
6. Add curated real-model matrix quality lane.
7. Add controller subagent orchestration.
8. Add host-side auto-fix worktree runner.

This order gets real value quickly without requiring the full grand design to
land before the first useful signal appears.

## Current product decisions

- `qa-bus` lives inside this repo
- the first controller is host-side
- Slack-class behavior is the MVP target
- the quality lane uses a curated matrix
- first version produces Markdown reports, not PRs
- OpenClaw-native orchestration is a later phase, not a v1 requirement
