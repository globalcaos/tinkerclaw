---
schema: "kit/1.0"
slug: "visual-brainstorm-questionnaire"
title: "Visual brainstorm via HTML questionnaire (submit wakes the agent)"
summary: "Instead of asking design questions one-by-one in chat, bake ALL clarifying questions, options and mockups into one local HTML page the user strolls through; a SUBMIT button sends structured answers back and wakes the agent in the same session."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "analysis"
tags:
  [
    "brainstorm",
    "design",
    "questionnaire",
    "visual",
    "mockup",
    "ui",
    "html",
    "visual questionnaire",
    "html questionnaire",
    "brainstorm visually",
    "bake the questions into a page",
    "show me the options in a page",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
parallelism:
  groups:
    - [0]
    - [1]
    - [2]
    - [3]
    - [4]
---

# Visual brainstorm via HTML questionnaire (submit wakes the agent)

> Instead of asking design questions one-by-one in chat, bake ALL clarifying questions, options and mockups into one local HTML page the user strolls through; a SUBMIT button sends structured answers back and wakes the agent in the same session.

## Goal

Collect all design decisions in one user pass, with visuals, without a chat ping-pong.

## When to Use

- A feature design has 5+ open questions and visual mockups would clarify them
- the architect says 'show me visually' or 'make a page with the choices'
- Any brainstorm where chat one-question-at-a-time would take many turns

## Steps

### 1. Start the visual-companion server

**Done when:** server-info JSON with url/screen_dir/state_dir captured

Run the superpowers brainstorming server: `~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/brainstorming/scripts/start-server.sh --project-dir <workspace>`. Parse the stdout JSON for `url`, `screen_dir`, `state_dir` (or read `$STATE_DIR/server-info` later). Server auto-exits after 30 min idle — if `server-stopped` exists or `server-info` is missing, re-run it.

### 2. Draft questions with baked recommendations

**Done when:** question list with options + one pre-selected recommendation each

Distill the open design questions into at most ~12 items, each single-select (or data-multiselect) with 2-4 options. For every question pick a recommendation, PRE-SELECT it (class `selected` + a visible agent-pick badge) so an untouched submit means 'all defaults accepted'. Genuinely visual questions (layout, traces, color) get an inline mockup: SVG or styled HTML next to the options.

### 3. Write the questionnaire page

**Done when:** fragment file exists in screen_dir and the server is serving it

Write ONE html content FRAGMENT (no <!DOCTYPE> — the server wraps it server-side, so inline <script> executes) into `screen_dir` with a FRESH filename (never reuse). Markup: each question is a container with `data-q="qN"` holding `.option` divs with `data-choice` + `onclick="toggleSelect(this)"`; free-text via plain inputs/textarea with ids. End with a SUBMIT button whose handler collects `.selected` choices per `[data-q]` plus the text fields and calls `window.brainstorm.send({type:'submit', choice:'submit', answers}) — the `choice`field is MANDATORY: server.cjs only appends events carrying a`choice` to the watched events file (no choice → log-only → the wake watcher never fires)`, then disables itself with a confirmation label.

### 4. Share the URL and arm the wake watcher

**Done when:** URL shared in chat and background watcher running

Reply to the user with the clickable http://localhost:<port> URL and a one-line summary of what is on the page. Then arm a background watcher that ends (and re-invokes the agent) on submit: `until grep -qs '"type":"submit"' $STATE_DIR/events; do [ -f $STATE_DIR/server-stopped ] && exit 1; sleep 2; done`. In the Claude-Code harness use Bash with run_in_background:true (single-notification pattern), NOT an unbounded tail.

### 5. Parse answers and follow up

**Done when:** answers parsed and next phase started

On wake, read `$STATE_DIR/events` (JSONL). The click events are the exploration path; the LAST `{type:'submit'}` event's `answers` object is authoritative. Merge with any chat text the user typed. Push a `waiting-N.html` fragment to clear the stale screen, then continue the work the questionnaire was gating (e.g. write the design doc to the bible, start implementation planning).

## Constraints

- Never reuse content filenames — the server serves the newest file by mtime
- Every question ships with a pre-selected recommendation; an untouched submit must be a valid 'all defaults' answer
- 2-4 options per question, at most ~12 questions per page
- The submit event is the ONLY wake signal — do not poll chat or ask the user to type 'done'
- Mockups are content fragments with inline style/SVG; full <!DOCTYPE> documents only when the frame must be overridden

## Safety Notes

- Server binds localhost only; nothing leaves the machine (PII boundary holds)
- Questionnaire answers land in .superpowers/brainstorm/<session>/state/events — workspace-local

## Failures Overcome

- Chat one-question-at-a-time brainstorms burning 10+ turns
- Inline <script> dead when injected client-side — companion server wraps fragments SERVER-side, so handlers work
- Submit event without a `choice` field reached server.log but never the events file — wake watcher stayed asleep (2026-06-13, first live run)
