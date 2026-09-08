# Systematic Debugging — Extended Guide

<role>
You debug software bugs systematically: investigate root cause, then fix once, with evidence.
</role>

<why_this_matters>
Most "fixes" that don't work are guesses skipped past Phase 1. Five minutes of careful reading-the-error and reproducing-the-bug saves hours of stacked half-fixes. The four phases run in order because each one builds on the last — diagnosis precedes hypothesis precedes change.
</why_this_matters>

## The Four Phases (run in order)

### Phase 1: Root Cause Investigation

Run this phase first, even when the fix looks obvious. Two minutes of investigation regularly redirects the work entirely.

```
1. Read error messages CAREFULLY — often contain the solution
2. Reproduce consistently — same input, same error, every time
   - If not reproducible → gather more data, add logging
3. Check recent changes:
   - git log --oneline -10
   - git diff HEAD~3
   - Any new dependencies? Config changes?
4. For multi-component systems:
   - Add diagnostic logging at EACH boundary
   - Run once to see WHERE it breaks
   - Follow the data flow: input → processing → output
```

### Phase 2: Pattern Analysis

```
1. Find WORKING examples of similar code in this codebase
   - grep/search for similar functions, patterns, API calls
2. Compare working vs broken — list EVERY difference:
   - Different imports?
   - Different argument types/order?
   - Different environment variables?
   - Different file paths?
3. Understand dependencies and assumptions:
   - What does the broken code assume exists?
   - What state does it expect?
```

### Phase 3: Hypothesis & Testing

```
1. State hypothesis CLEARLY:
   "I think [X] because [evidence Y]"

2. Make the SMALLEST possible change to test:
   - Change ONE variable
   - Add ONE log statement
   - Toggle ONE config value

3. Run and observe:
   - Fixed? → Phase 4
   - Not fixed? → New hypothesis (NOT another random change)
   - Made it worse? → Revert immediately, reconsider

4. DON'T stack fixes. One at a time. Revert if it doesn't help.
```

### Phase 4: Implementation

```
1. Create failing test case that reproduces the bug
2. Implement single fix addressing ROOT CAUSE (not symptoms)
3. Run test → verify it passes
4. Run full suite → verify no regressions
5. Commit with explanation of root cause and fix
```

## The Three-Strike Rule

```
After fix attempt 1: normal. Continue Phase 3.
After fix attempt 2: suspicious. Review Phase 1 findings.
After fix attempt 3: stop.

Three failed fixes usually means one of:
- Wrong root cause identification → go back to Phase 1
- Architectural issue → discuss fundamentals
- Missing understanding → read more code/docs

Before attempting fix #4:
1. Acknowledge the three failures explicitly.
2. Discuss what's fundamentally wrong.
3. Get a fresh perspective — a different approach, or a different person.
```

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "I know what's wrong" | Did you reproduce it? |
| "Quick fix, obvious problem" | Follow Phase 1 anyway. 2 minutes. |
| "Just one more try" (after 2 fails) | That's the three-strike trigger |
| "This is different from the pattern" | It's probably the same pattern |
| "Let me try a completely different approach" | Did you understand WHY the first approach failed? |
| "The error message is misleading" | Read it again. Literally. |
| "It works on my machine" | Check environment, config, versions |
| "Must be a race condition" | Add logging. Prove it. Don't guess. |

## Multi-Component Debugging

When the system has multiple layers (API → service → database):

```
1. Instrument EVERY boundary:
   - Log request/response at each layer
   - Include timestamps and correlation IDs
2. Run the failing operation ONCE with instrumentation
3. Read logs to identify WHICH layer breaks
4. Focus Phase 1-4 on THAT layer only
5. Remove instrumentation after fix
```

## Common Traps

- **Fixing symptoms instead of causes:** The error is in module A, but the bug is in module B's configuration. Fix B, not A.
- **Copy-pasting from StackOverflow without understanding:** Read. Understand. Then adapt.
- **Changing multiple things at once:** Revert. Change ONE thing. Test.
- **Not reading the FULL error:** The real cause is often on line 3 of the stack trace, not line 1.
