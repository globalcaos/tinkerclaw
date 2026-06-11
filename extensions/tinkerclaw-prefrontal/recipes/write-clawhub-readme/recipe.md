---
schema: "kit/1.0"
slug: "write-clawhub-readme"
title: "Write a ClawHub Skill/Plugin README"
summary: "Author the front README section for a ClawHub skill or plugin — TinkerClaw provenance banner, Marketia slow-lure, plain-language core, funnel close. Prose only; all code lives below the fold."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "writing"
tags:
  [
    "writing",
    "clawhub",
    "readme",
    "marketing",
    "marketia",
    "skill",
    "plugin",
    "description",
    "funnel",
    "write a readme for a skill",
    "write a readme for a plugin",
    "clawhub readme",
    "skill description",
    "rehaul the readme",
    "front readme section",
    "marketing copy for a skill",
    "publish a skill to clawhub",
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
    - [5]
    - [6]
---

# Write a ClawHub Skill/Plugin README

> Author the front README section for a ClawHub skill or plugin — TinkerClaw provenance banner, Marketia slow-lure, plain-language core, funnel close. Prose only; all code lives below the fold.

## Goal

Turn a stranger's scroll into a click. Every published skill/plugin page opens with: provenance banner -> Marketia slow-lure -> plain-language core -> funnel close, prose-only, code below the fold. The front section sells; the rest serves.

## When to Use

- Writing or rewriting the README / front section of one of OUR ClawHub skills or plugins.
- Rehauling a whole catalog of skill READMEs (run this recipe per skill).
- A new skill/plugin is about to be published and needs its marketing surface.

## Steps

### 1. Locate the marketing surface and read it

**Done when:** You have read the full file and noted the live frontmatter description hook.

Find the file ClawHub renders as the page. Skills: the top of SKILL.md body (after frontmatter). Plugins/guides vary — README.md, GUIDE.md, or BUDGET_README.md. Read it fully. Note the live frontmatter `description:` hook and whether it is already a keeper (sharp, value-first). NEVER downgrade a live keeper hook for a keyword — refine, don't blandify. If a parallel session has uncommitted edits in the file, graft only the new front block and preserve their work; never overwrite the whole file.

### 2. Write the provenance banner (first line)

**Done when:** A one-line blockquote banner sits at the very top, linking the repo.

The very first line is a markdown blockquote establishing this is part of a living stack and planting the funnel link high for the early clicker: `> One of dozens of skills and plugins in **[TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — a self-improving OpenClaw fork that's been running 24/7 for months.`

### 3. Write the Marketia lure (slow-pull)

**Tools:** ai-humanizer
**Done when:** Two to three short lines build tension before any explanation, opening with emotional punctuation.

Pull the reader in slowly. Two or three short lines that build before they explain — each earns the next. Open with ONE of: a cliffhanger, an absurd/concrete contrast, a concrete scenario, or a blunt value-proposition. Put emotional punctuation ( — ? ! ) on the opener. The pain is the reader's status quo, NEVER our tool failing. Patterns that work: relatable pain ('Your agent says done — but did it check?'), absurd contrast ('Won't send a single one. Not even if you ask nicely.'), concrete scale ('Triages a thousand GitHub forks per run.'), model roast ('Claude follows your rules. GPT ignores half.'). Avoid leading with jargon (no 'sherpa-onnx TTS', 'embedding space', 'pull-based bash daemon'). Keep the rebellious 'hack' ethos, but AVOID criminal-connotation words — no 'stolen', 'steal', 'harvest', 'exfiltrate'. They trip ClawHub/security scanners (they flagged teams-hack as a 'critical exfiltration' false-positive) and undercut our safe-by-construction trust story. 'Your tab IS the API' / 'no consent screens' / 'one tap' = good; 'one stolen token' = bad. Emphasize it's the user's OWN session.

### 4. Write the plain core (pay it off)

**Done when:** Two to four plain-language sentences explain what it does and the win.

Now explain, plainly, the way you'd tell a smart friend who doesn't code: what it actually does and the concrete win. Specific beats adjectives. No buzzwords (revolutionary, cutting-edge, game-changing, state-of-the-art, paradigm). Name the real capability in words, not config. If a non-engineer can't follow it, it's still too technical for the front section.

### 5. Write the funnel close

**Done when:** The verbatim TinkerClaw close + 'Clone it. Fork it. Break it.' sits at the end of the front section.

Close with the hard CTA, after the reader is invested. Keep verbatim: a bold line `**Part of [TinkerClaw](https://github.com/globalcaos/tinkerclaw)** — real-time token tracking, self-improving crons, persistent cognitive memory. This is one piece of that stack; the repo has dozens more.` then a `👉 **https://github.com/globalcaos/tinkerclaw**` line, then `_Clone it. Fork it. Break it. Make it yours._`

### 6. Enforce prose-only and push machine content below the fold

**Done when:** No code/flags/paths/API names appear in the front section; install + usage + security sit below it; version bumped.

The front section is PROSE ONLY. Move every code block, flag, file path, API name, and env var BELOW the front section (Install / Usage / Security headings). Skills install with `openclaw skills install <slug>`; plugins with `clawhub package install <name>` — get the right install line. Bump the frontmatter `version:` field if one exists (patch bump). Keep the whole front block tight: roughly 8–12 lines.

### 7. De-AI and gate before publishing

**Tools:** ai-humanizer
**Done when:** ai-humanizer pass is clean and marketia-check.sh exits READY TO PUBLISH.

Run the front section through the ai-humanizer skill to strip AI-tells. Then run `bash scripts/marketia-check.sh skills/<name>` — it checks emotional punctuation, no buzzwords, funnel link present, closing line, no hardcoded personal paths. Verify the banner appears exactly once and the funnel link resolves. This recipe writes COPY only — it does not publish. Publishing is a separate, human-gated step (`clawhub login`).

## Constraints

- Front section is PROSE ONLY — no code blocks, flags, file paths, API names, or env config above the fold.
- Banner is the FIRST line; funnel close is LAST; both link github.com/globalcaos/tinkerclaw.
- Never downgrade a LIVE keeper hook for a keyword — refine, don't blandify.
- No buzzwords: revolutionary, cutting-edge, game-changing, next-generation, state-of-the-art, paradigm.
- No criminal-connotation wording (stolen/steal/harvest/exfiltrate) — keep the hack ethos without the rap sheet; such words trip security scanners and undercut the safe-by-construction trust story. Frame access as the user's OWN session.
- The pain is the reader's status quo, never OUR tool failing.
- Keep the front block tight — roughly 8–12 lines.

## Safety Notes

- This recipe writes COPY only. Publishing/rescan needs `clawhub login` (Oscar's hands; the token gets revoked often) — never auto-publish.
- If the target file has foreign uncommitted WIP, graft only the front block and preserve the other session's edits; do not overwrite the whole file.
- Skills vs plugins differ at publish: `clawhub skill publish` / `skills install` vs `clawhub package publish` / `package install`. Match the install line to the artifact type.

## Failures Overcome

- A feature-list opener (no hook) is the C-grade failure mode (e.g. shell-security pre-rehaul) — this recipe forces hook-first.
- Older 'searchable rename' drafts were weaker than the live hooks — the keeper-hook rule stops that regression.
- Leading with jargon ('sherpa-onnx TTS', 'embedding space') reads like a package.json — banned from the lure.
