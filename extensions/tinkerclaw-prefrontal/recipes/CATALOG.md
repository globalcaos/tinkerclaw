# Prefrontal Recipe Catalog

> Available recipes for structured agent workflows. The agent activates a recipe
> by mentioning it in its response: "following the debug recipe."

## Categories

| Category | Color | Recipes |
|----------|-------|---------|
| Coding | olive | debug, feature, refactor, code-review, upstream-merge, fork-patch |
| Writing | purple | write-paper, brainstorm, write-plan |
| Operations | amber | gateway-restart, security-audit, deploy |
| Analysis | blue | investigate, dependency-analysis |
| Security | red | incident-response, credential-rotation |
| Communication | green | daily-report, jarvis-report |

## Quick Reference

| Recipe | Triggers | Steps | Effort |
|--------|----------|-------|--------|
| debug | bug, error, crash, broken, fails, exception, fix | reproduce, diagnose, fix, verify | standard |
| feature | add, create, build, implement, new feature | explore, design, test, implement, verify | deep |
| refactor | refactor, clean up, restructure, simplify | understand, baseline-tests, refactor, verify | standard |
| code-review | review, PR, check this, look at changes | read-diff, context, assess, report | light |
| upstream-merge | merge, upstream, sync, rebase | pre-check, merge, resolve, verify-wiring, build-test | deep |
| fork-patch | patch, fork fix, wiring, apply patch | identify, write-patch, apply, verify-guardian | standard |
| write-paper | paper, article, write-up, document, spec | outline, research, draft, review, polish | deep |
| brainstorm | brainstorm, ideas, explore options, what if | frame, diverge, converge, evaluate | light |
| write-plan | plan, roadmap, design doc, RFC, proposal | scope, research, structure, draft, review | standard |
| gateway-restart | restart, gateway, reload, bounce | pre-check, graceful-stop, start, verify | light |
| security-audit | audit, security, vulnerabilities, hardening | inventory, scan, analyze, report, remediate | deep |
| deploy | deploy, release, ship, push to prod | pre-flight, build, deploy, verify, rollback-plan | standard |
| investigate | investigate, analyze, look into, find out | scope, gather, analyze, report | standard |
| dependency-analysis | dependencies, outdated, upgrade, supply chain | inventory, audit, risk-assess, plan | standard |
| incident-response | incident, breach, compromised, leak | contain, assess, remediate, communicate, postmortem | critical |
| credential-rotation | rotate, credentials, keys, tokens, secrets | inventory, generate, deploy, verify, revoke-old | standard |
| daily-report | daily, status, standup, what happened | gather, summarize, format, deliver | light |
| jarvis-report | report for jarvis, structured report, incident | gather, analyze, structure, deliver | standard |

## How Recipes Work

1. The agent receives a user message
2. `selectRecipe()` matches trigger words to find the best recipe
3. The recipe's steps are injected into the agent's prompt as structured guidance
4. The agent follows steps in order, reporting completion of each before moving on
5. Tool usage is constrained to what each step allows

## Adding New Recipes

Create a new `.md` file in the appropriate category directory with:
- YAML frontmatter (schema, id, title, category, summary, triggers, effort, tools)
- Markdown body with Goal, When to Use, Steps, Constraints, Safety Notes, Failures Overcome
- The recipe engine loads all `.md` files from `recipes/` subdirectories on startup
