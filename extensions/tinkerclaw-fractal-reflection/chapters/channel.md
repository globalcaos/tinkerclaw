## Chapter: channel — the owner did not see the work

_Why this chapter came with your prompt: his prompt says he did not see, receive or render
something. v4 chapter 10 (the delivery channel is in scope, 2026-08-26, after a completed 304-page
build reached him as a wall of thinking with no answer attached)._

"done?", "I don't see an answer", "just thinking", bubbles fused together, a duplicated or missing
reply: that is a defect report about the channel, and this reflection owns it. Answering the
original question again while stepping over the delivery failure fixes nothing; the next turn is
lost the same way.

### What the reply owed him (check it; a miss is a fix to the governing rule)

- [ ] **"Reload the tab" FIRST**, in one line, before any root-cause narrative. The served history
      already holds the reply, so a reload repaints it. He wants his answer back more than the
      autopsy.
- [ ] **On "try again", the FIRST tokens are the answer, not more diagnosis** (2026-08-28, after
      two retries drowned in file reads and never produced a visible reply). The previous turn's
      work is usually on disk: lead with it. Diagnosis comes after the answer, never instead of it.

### Run the three-step ladder before theorising

Each step halves the search space; it localised the 2026-08-26 case in three steps, and is cheap
enough that guessing is never justified.

1. **Disk**: `grep -rl "<a distinctive phrase from the reply>" ~/.openclaw ~/.claude/projects`.
   Present ⇒ the model produced it and it was persisted; the loss is downstream. Absent ⇒ the turn
   died before persist, and nothing downstream can be at fault.
2. **Served**: `openclaw gateway call chat.history --params '{"sessionKey":"…","limit":1000}'`, the
   size an open tab reads (`TAIL_READ_LIMIT`), then `"limit":100`, a fresh tab's first read
   (`WINDOW_PAGE`). Search the text, not the seq: a claude-cli turn's answer is served as an import
   row with no seq. Present ⇒ the gateway serves it; the defect is in the renderer. Absent only at
   100 ⇒ a fresh tab loses it, an open one does not. A smaller probe is not this step. (2026-10-09:
   at limit 30 and 60 the 14:33 SV2 reply looked dropped; limit 1000 served it with its card.)
3. **Rendered**: grep the phrase INSIDE the `id="messages"` region of
   `~/.openclaw/data/tinker-ui-snapshot.html`. Grep the whole file and you match the amygdala panel
   echoing your own query back. Absent from `#messages` while present in steps 1–2 is the
   signature of **persisted-but-not-painted**.

### Before trusting "already fixed"

- [ ] Establish all three: the commit is an ancestor of HEAD, the symbol is in the BUILT bundle,
      and the build is newer than the commit (`stat` the artifact against
      `git log -1 --format=%ci <commit>`). A "fixed" memory records **where it is running**, not
      only where it was committed; update it the moment observation contradicts it.
- [ ] A stored culprit (a named commit in a memory file) is a hypothesis, not a diagnosis: run the
      ladder first.

Why: a note saying "fixed in commit `abc123`" is a claim about SOURCE; the symptom is evidence about
the RUNNING artifact. On 2026-08-26 the fix landed 2026-08-25 16:11 and the bundle was built
2026-08-24 15:21: committed, merged, never built, so the gateway served the buggy path for a day.
That is the stale-dist failure again, so it escalates as a recurrence. Same day, both obvious
suspects proved innocent in three commands: the block-index fix `caa186c1ca5` was an ancestor of
HEAD and the bundle in `tinker-ui/dist/assets/` was built after it, and the bug it fixed lived in
tinker-bridge while the session ran on cc-bridge.

### Auto-detect the class without him naming it

- A long thinking/tool loop with no answer bubble, then "I did not see any answer" / "try again" /
  "done?": treat as **persisted-or-on-disk, not painted**. Reload-first line, then the answer from
  the artifact, then the autopsy.
- Fused thinking bubbles: the same event from the other side. When the stream stops mid-turn the
  block breaks are never finalised, so the deltas coalesce into one tall block.
- A mid-turn warning (gateway restart, provider error) that should be a **centred orange envelope
  with extra info** but shows only a collapsed headline or a grey chip: recoverable `__ERR_ENV__`
  envelopes used to hide `explanation` behind a `<details>` collapse (`openAttr` only when
  `fatal`). Info that tells him what is happening belongs in the collapsed view; tech kv/raw stays
  behind the expand. The source fix lives in `renderEnvelope` in `app.ts`; until a frontend rebuild
  is live and you looked at it, say **written, not running**.

### Solving it

Diagnosing, fixing, building and deploying are all in reach, bounded by reversibility and by the
core's quiet-house rule: a background reflection merges and lets the next rebuild carry it while a
chat is busy. Restart only through the `gateway-restart` or `tinker-rebuild` skills (since
2026-09-30 they hold every live turn and continue it), never any other way.
