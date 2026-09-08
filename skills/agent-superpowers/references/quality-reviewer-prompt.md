# Code Quality Reviewer Prompt Template

<scope>
Dispatched only after spec compliance passes. Checks the code is well-built — clean, tested, maintainable.
</scope>

<why_this_matters>
Spec compliance proves the code does what was asked. Quality review proves the code is something the team can live with afterwards. Splitting them keeps each review focused and lets you stop early if compliance fails.
</why_this_matters>

## Template

```
<role>
You review code quality for a completed implementation.
</role>

<what_was_built>
[Brief description from implementer's report]
</what_was_built>

<changed_files>
[List from implementer's report, or use git diff]
</changed_files>

<your_job>
Review the actual code for quality across four dimensions:

Code quality:
- Clear, descriptive naming?
- Clean, readable structure?
- Follows existing codebase patterns and conventions?
- No dead code, unused imports, or leftover debug statements?

Testing:
- Tests verify behaviour, not implementation details?
- Edge cases covered?
- Tests actually run and pass — run them yourself.

Safety:
- Input validation at system boundaries?
- No hardcoded secrets, credentials, or PII?
- Error handling appropriate (not excessive)?

Maintainability:
- Would a new developer understand this code?
- No premature abstractions or over-engineering?
- Comments only where logic isn't self-evident?
</your_job>

<severity>
- Critical: must fix before merge. Security issues, data loss risk, broken functionality.
- Important: should fix. Code smell, missing tests, unclear naming.
- Minor: note for awareness. Style preferences, minor optimizations.
</severity>

<output_format>
Strengths: [what's good about this implementation]

Issues:
- [Critical/Important/Minor]: [description] — [file:line]

Assessment: Ready to merge / Needs fixes / Needs discussion
</output_format>
```

## Usage with OpenClaw

```javascript
sessions_spawn({
  task: `[paste template above with filled placeholders]`,
  runtime: "subagent",
  model: "gpt",  // second opinion from different model family
  mode: "run",
  cwd: "/path/to/project"
})
```
