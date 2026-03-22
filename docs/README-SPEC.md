# README Specification — TinkerClaw Fork

**Purpose:** Single source of truth for what the fork README must contain.
Use this when writing, reviewing, or recovering the README.

## Reference Commit

The last verified good README: **`df7e1de73c`** (2026-03-21)

To view it: `git show df7e1de73c:README.md`
To restore it: `git show df7e1de73c:README.md > README.md`

**Update this after every intentional README change.**

## Required Sections Checklist

When spawning a sub-agent to modify README.md, include this checklist in the task:

- [ ] **Fork header** — TinkerClaw / Tinker Zone branding, NOT OpenClaw. Custom logo from `docs/assets/`.
- [ ] **Badges** — fork-of OpenClaw, fork commits count, skills count, papers count, MIT license.
- [ ] **Screenshots** — at least one Tinker UI screenshot with descriptive caption.
- [ ] **"Why This Fork"** — what makes this different from upstream.
- [ ] **"What's Different Here"** — security patches, smart defaults, fork fixes, Ubuntu-native.
- [ ] **Setup Guide** — Quick Start (`git clone` + `pnpm install` + `pnpm build` + `openclaw`), what you get out of the box, required setup, recommended config tweaks, cron jobs, multi-agent family setup.
- [ ] **Tinker Command Center** — bundled plugin description, what you're paying section.
- [ ] **Multi-Model Support** — failover chain, model aliases.
- [ ] **Published Skills table** — ALL skills from ClawHub, grouped by category (Voice, Media, Messaging, Cost, Enterprise, Agent, Security, Data). Currently 21+ skills.
- [ ] **Memory Research Papers table** — ALL papers with titles, token savings, and links. Currently **11 papers** (this is the section most often lost):
  1. Fractal Context Windows
  2. Temporal Pointer Networks
  3. Hierarchical Memory Compaction
  4. Emotional Valence Tagging
  5. Cognitive Load Prediction
  6. Adversarial Memory Injection
  7. Personality Drift Detection
  8. Cross-Agent Memory Sync
  9. Retrieval-Augmented Self-Reflection
  10. Sleep Consolidation Cycles
  11. Learned Intuition (AMYGDALA)
- [ ] **What's Next** — roadmap items.
- [ ] **Upstream Documentation** — link to OpenClaw docs.
- [ ] **Contributing** — how to contribute to the fork.
- [ ] **About the Maintainer** — Oscar Serra info.
- [ ] **OpenClaw Contributors** — upstream attribution.

## Recovery Procedure

If the README gets clobbered by an upstream merge:

1. **Don't rewrite from scratch.** Restore from the reference commit:
   ```bash
   git show df7e1de73c:README.md > README.md
   ```
2. Then patch any new content that needs to be added on top.
3. Update the reference commit hash in this file and in `merge-guardian.sh`.

## Merge Script Behavior

`scripts/merge-upstream.sh` resolves README.md conflicts with `--ours` (keeps our fork version).
The merge guardian (`scripts/merge-guardian.sh`) checks for fork branding and paper count.
