---
purpose: AI entry point for the tinkerclaw bible (J15 RSC discipline)
audience: AI (Claude, etc). Human readability is incidental, not the design goal.
codename: RSC (after retrosplenial cortex, per paper J15)
last_verified: 2026-05-11
last_verified_commit: HEAD
verify:
  - name: bible folder exists with expected count of files
    cmd: python3 -c 'import glob,os; assert len(glob.glob(os.path.expanduser("~/src/tinkerclaw/TINKER_UI_DESIGN_BIBLE/*.md"))) >= 14'
  - name: gateway is reachable
    cmd: python3 -c 'import subprocess; r=subprocess.run(["openclaw","gateway","call","gateway.identity.get"],capture_output=True,text=True); assert "deviceId" in r.stdout, r.stdout[-500:]'
---

# Bible INDEX — tinkerclaw

This directory IS the bible. The monolithic `TINKER_UI_DESIGN_BIBLE.md` was split on 2026-05-11 into thirteen files: one narrative plus twelve structural intermediate-abstraction files (J15 paper). Together they remain "the bible" colloquially. References from code or memory that point at the old `.md` should be updated to point at this `INDEX.md`.

## How an AI should read this directory

1. **Always read THIS file first.** It is the map.
2. **Pick the right optic for the question:**
   - "in what order do these components communicate?" → `flows.md`
   - "what transitions are legal for X?" → `lifecycles.md`
   - "where does this run / what talks to what?" → `topology.md`
   - "what is this config key, who reads it, who can override?" → `config-shape.md`
   - "when X breaks, where does the symptom appear?" → `failures.md`
   - "what probes exist for inspecting Y?" → `probes.md`
   - "why is cc-bridge's tool loop different?" → `tool-loop.md`
   - "which model gets picked, in what order?" → `auth-routing.md`
   - "which crons run, when, last status?" → `crons.md`
   - "is this string safe to publish?" → `pii-boundary.md`
   - "where does memory dir X live, who writes it?" → `memory-layout.md`
   - "how do subagents and recipes work?" → `subagents-and-recipes.md`
   - "what's the intent / decision / don't-regress for §X.Y?" → `bible.md`
3. **Trust the frontmatter `last_verified` + `last_verified_commit` anchors.** Anything older than the most recent file in `git log src/` referenced by the section should be re-verified before relying on it.
4. **Do NOT re-narrate facts that live in another file.** Cross-reference them with `see also:` annotations. Single owner per fact.

## Files

| File                       | Compresses                                                                                                                                                                | Generation                       | ~Lines |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------ |
| `INDEX.md`                 | This map                                                                                                                                                                  | hand                             | ~80    |
| `bible.md`                 | Narrative, intent, decisions, don't-regress rules. The original 3,085-line file, preserved verbatim. Will slim incrementally as the twelve structural files absorb facts. | hand                             | ~3085  |
| `flows.md`                 | Sequence diagrams (Mermaid) for the top pipelines                                                                                                                         | hand + auto-validatable          | ~300   |
| `lifecycles.md`            | State machines for sessions, workers, messages, recovery                                                                                                                  | hand + auto-validatable          | ~200   |
| `topology.md`              | Components, ports, plugins, channels, workspace symlinks                                                                                                                  | mixed                            | ~250   |
| `config-shape.md`          | Settings flow from openclaw.json to runtime; override chains; dead-code traps                                                                                             | mixed                            | ~400   |
| `failures.md`              | Failure-mode propagation maps                                                                                                                                             | hand                             | ~300   |
| `probes.md`                | Inspection primitives registry (live + proposed)                                                                                                                          | auto from gateway methods + hand | ~150   |
| `tool-loop.md`             | Why cc-bridge tool calls don't round-trip through OpenClaw exec                                                                                                           | hand                             | ~150   |
| `auth-routing.md`          | Cost-aware model routing, failover, billing tiers                                                                                                                         | mixed                            | ~150   |
| `crons.md`                 | Cron registry + auto-merge policy                                                                                                                                         | auto from jobs.json + hand       | ~150   |
| `pii-boundary.md`          | Public-OK vs private-only, leak-grep regex, sanitization workflow                                                                                                         | hand                             | ~100   |
| `memory-layout.md`         | Workspace memory directory layout, writers, retention                                                                                                                     | mixed                            | ~150   |
| `subagents-and-recipes.md` | Subagent spawn, recipe-state CLI, Prefrontal observability                                                                                                                | hand                             | ~150   |

## Discipline

- **Single owner per fact.** If a fact appears in two files, one of them is wrong. The structural files (everything except `bible.md`) are authoritative for their domain; `bible.md` is authoritative for narrative and decision history.
- **Frontmatter on every section that claims `DEPLOYED`.** Use the J15 schema: `status`, `last_verified`, `last_verified_commit`, `verify[]`, `invariants[]`.
- **Mermaid diagrams in text form.** Renderable by humans through a markdown previewer, but the AI consumes them as text directly.
- **Cross-references over duplication.** Use `see also: lifecycles.md#session-state` rather than copy-pasting a state diagram.
- **TBD is a real status.** A section marked `status: TBD` is honest. A section marked `DEPLOYED` without a `verify` command is dishonest.

## Migration status (2026-05-11)

- [x] Move `TINKER_UI_DESIGN_BIBLE.md` (3,085 lines) → `bible.md` verbatim
- [x] Create `INDEX.md` (this file)
- [x] Scaffold 12 structural files with frontmatter + section structure + content I have today
- [ ] Slim `bible.md` by moving structural facts to their owning files (incremental, future work)
- [ ] Add `verify` commands to every `DEPLOYED` section (incremental)
- [ ] Wire `pnpm test:invariants` to run all `verify` commands at merge time (future, requires the gate of J15 §5)

## Naming

The folder is `TINKER_UI_DESIGN_BIBLE` to preserve external references that grep for the old token. The original `TINKER_UI_DESIGN_BIBLE.md` stub at the parent path redirects here.

We still call this "the bible." The plural inside the folder is the implementation; the singular outside is the artifact.
