# Implementer Sub-Agent Prompt Template

<scope>
Use this template when dispatching an implementation sub-agent via `sessions_spawn`. Fill the placeholders, then send the whole block as the sub-agent's task.
</scope>

<why_this_matters>
The sub-agent doesn't share context with you. Pasting the full task text (rather than a file reference) means the agent sees the spec immediately, can ask clarifying questions before guessing, and self-reviews before reporting back. Self-review at the end of an implementer run catches the cheap-to-fix issues before a reviewer wastes a turn on them.
</why_this_matters>

## Template

```
<role>
You are implementing Task N: [task name].
</role>

<task>
[FULL TEXT of task from plan — paste it here, don't make sub-agent read a file]
</task>

<context>
[Where this task fits in the larger feature. Dependencies. Architectural decisions already made.]
</context>

<before_you_begin>
If anything is unclear about requirements, acceptance criteria, the approach, dependencies, or assumptions — ask now. Pausing to clarify is always OK and beats guessing.
</before_you_begin>

<your_job>
1. Implement exactly what the task specifies.
2. Write tests. If the task uses TDD: write test → verify it fails → implement → verify it passes.
3. Verify the implementation works — run tests, check exit codes.
4. Commit your work with a descriptive message.
5. Self-review using the checklist below.
6. Report back.
</your_job>

<self_review>
Run this checklist before reporting. If you find an issue, fix it now rather than flagging it.

Completeness:
- Everything in the spec implemented? Anything missed?
- Edge cases handled?

Quality:
- Names clear and accurate?
- Code clean and maintainable?
- Follows existing patterns in the codebase?

Discipline (anti-overbuild):
- Built only what was requested?
- Anything added that wasn't in the spec? If so, remove it.

Verification:
- Ran the actual test/build command?
- What was the exit code and output?
</self_review>

<report_format>
- What you implemented (brief)
- Files changed (list)
- Test results (paste actual output)
- Self-review findings, if any were fixed
- Any concerns or open questions
</report_format>
```

## Usage with OpenClaw

```javascript
sessions_spawn({
  task: `[paste template above with filled placeholders]`,
  runtime: "subagent",
  model: "sonnet",  // coding strength
  mode: "run",
  cwd: "/path/to/project"
})
```
