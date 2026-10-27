# Changing a Jev question

For: whoever edits a file in this folder. Derived from the 2026-10-24 `false-blocker` change (bug log
`false-blocker-nudge`), whose turn paid four extra rounds for the steps below. Update it when a step
stops being true.

1. **Raise `version`** in the YAML when the wording, an answer or a cutoff changes. Tests that pin a
   version number break; compare against the version read before the change instead
   (`__tests__/learn-changes.test.ts`, "a tightening that would hold three controls").
2. **A new answer that should act needs its own send-back text** in `src/templates.ts` and a route in
   the family (`src/families/<family>.ts`). A text the flagged reply already satisfies ("say what
   blocks it") is not a nudge: it has to carry the fact that unblocks.
3. **Add one must-catch and one control** in `cases/must-catch/<family>.json` and
   `cases/controls/<family>.json`, and list the must-catch id under `mustCatch`. Write them with an
   editor or append by hand: `json.dump` re-indents the short arrays and turns the diff into churn.
   Run `npx oxfmt <files>` before committing.
4. **Tell the reviewer** (`src/review.ts`) when the change alters what counts as useful, or it will
   keep proposing fixes that undo it.
5. **Bug log:** an entry in `TINKER_UI_DESIGN_BIBLE/bug-log.md`; a header chip that is not in its
   failure-class table fails the commit hook. Add the row first.
6. Prove it: `npx vitest run extensions/tinkerclaw-amygdala` (the `cases replay` tests run every
   case), then `scripts/deploy-worktree.sh --sha <sha> --dry-run` under `longjob` before the merge.
