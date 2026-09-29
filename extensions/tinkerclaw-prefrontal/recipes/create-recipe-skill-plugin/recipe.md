---
schema: "kit/1.0"
slug: "create-recipe-skill-plugin"
title: "Create a New Enhancement (Recipe, Skill or Plugin)"
summary: "Turn a repeatable need into the lightest enhancement that serves it — recipe, skill or plugin — after a prior-art sweep of the local inventory, ClawHub, Journey kits and prompts.chat, so we adopt or improve before we build; then place it: which agents run it, and whether it is public."
version: "1.1.0"
owner: "globalcaos"
license: "MIT"
category: "coding"
subdivision: "authoring"
tags:
  [
    "recipe",
    "skill",
    "plugin",
    "authoring",
    "prior art",
    "clawhub",
    "journey",
    "prompts.chat",
    "create a recipe",
    "create a new skill",
    "create a plugin",
    "make this a skill",
    "turn this into a recipe",
    "we keep doing this",
    "is there already a skill for",
    "new capability",
    "enhancement",
    "new enhancement",
    "where should this live",
    "which agents get it",
    "public or private",
  ]
testedHarnesses: ["OpenClaw", "Claude Code"]
authoredBy: "jarvis-on-the-fly"
params:
  idea:
    {
      type: "string",
      description: "One sentence: the repeatable need this artifact should serve, in the user's words.",
    }
  artifact_kind:
    {
      type: "string",
      default: "auto",
      description: "recipe | skill | plugin | auto (auto = decide in step 1 by the lightest-artifact rule).",
    }
  recipes_dir:
    {
      type: "string",
      default: "extensions/tinkerclaw-prefrontal/recipes",
      description: "Repo-relative folder where recipes (kit/1.0) live.",
    }
  skills_dir:
    {
      type: "string",
      default: "skills",
      description: "Folder holding local skills (one SKILL.md per skill folder).",
    }
  plugins_dir:
    {
      type: "string",
      default: "extensions",
      description: "Repo-relative folder holding plugins (one openclaw.plugin.json per plugin).",
    }
  placement_policy:
    {
      type: "string",
      default: "~/.openclaw/workspace/memory/knowledge/enhancement-placement.md",
      description: "The deployment's private placement policy: which agents exist, what each is for, and the owner's own rulings. Overrides the generic rules in step 9. Skipped when absent.",
    }
  funnel_url:
    {
      type: "string",
      description: "Optional project link to carry inside anything published publicly (resolved from the private VarStore).",
    }
parallelism:
  groups:
    - [0]
    - [1]
    - [2, 3, 4]
    - [5]
    - [6]
    - [7]
    - [8]
    - [9]
    - [10]
---

# Create a New Recipe, Skill or Plugin

> Turn a repeatable need into the lightest artifact that serves it — after checking what already exists, locally and in the three public registries.

## Goal

Every repeatable ask, codified once, is ready for every future session. But the cheapest artifact is the one that already exists: a borrowed, battle-tested skill usually beats a self-made one. This recipe forces the prior-art sweep BEFORE any drafting, then builds the lightest artifact that fully serves `{{idea}}`.

## When to Use

- The same kind of ask has come up twice, or clearly will again.
- Someone says "make this a skill / recipe / plugin", "is there already something for…", or "we keep doing this".
- A saved procedure nearly fits a task and needs a sibling rather than a patch.

Do NOT use for a one-off: do the task inline.

## Steps

### 0. Decide the artifact kind — lightest that fully works

**Done when:** One kind is chosen and the reason fits in one sentence.

If `{{artifact_kind}}` is not `auto`, confirm it against this table; otherwise pick with it.

| Kind       | It is                                                                               | Choose it when                                                                          |
| ---------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Recipe** | An orchestration playbook — ordered Steps, "Done when" gates, no code of its own    | The need is a _procedure_ built from tools and skills that already exist                |
| **Skill**  | Instructions the agent loads on trigger, plus optional `scripts/` and `references/` | The need is _knowledge or a small tool_ the agent must carry into a task                |
| **Plugin** | Code running inside the gateway — hooks, RPCs, channels, UI panels                  | The need must run _without the agent_: on every message, on a schedule, or as a service |

Lightest-first: recipe < skill < plugin. Escalate only for a named reason. A plugin needs a build, a deploy and a restart; a recipe is live the moment it is saved.

### 1. Sweep the LOCAL inventory first

**Done when:** You can say "nothing local covers it" or name the file that nearly does.

Enumerate by command, never from memory:

- Recipes: read `{{recipes_dir}}/CATALOG.md`, and grep every recipe's `tags:` for the idea's key nouns and verbs.
- Skills: list `{{skills_dir}}/*/SKILL.md` and grep their `description:` lines.
- Plugins: list `{{plugins_dir}}/*/openclaw.plugin.json` and read the `name`/`description` of any hit.

If something nearly fits, **improve it** (a new step, a param, a trigger) instead of creating a sibling — and stop here unless the improvement changes what the artifact is FOR.

### 2. Prior art — ClawHub (skills and plugins)

**Tools:** clawhub CLI
**Done when:** The top matches are listed with slug, owner and one line each, and any worth reading have been read.

```
clawhub search "<idea in 3–6 words>" --limit 10
clawhub explore            # latest-updated, to see what is moving
```

Search two or three phrasings — vector search is phrasing-sensitive. To read a candidate's actual content without touching your live skills, install it into a scratch folder: `clawhub install <slug> --workdir /tmp/prior-art`. Read its SKILL.md. Delete the scratch folder afterwards.

### 3. Prior art — Journey kits (full agent workflows)

**Done when:** Matching kits are listed with kitRef, licence and one line each.

Journey (journeykits.ai) is a registry of complete agent workflows — system prompts, skills, tool configs, tests — in the same `kit/1.0` lineage as these recipes, so a good kit distils almost directly into a recipe.

```
curl -s "https://www.journeykits.ai/api/kits/search?q=<url-encoded idea>"
```

Each hit carries `kitRef`, `title`, `summary`, `status` and `verifiedPublisher`. **Licence-gate before distilling** — read the kit's licence. If it is permissive, borrow, and attribute in a blockquote under the Goal section.

### 4. Prior art — prompts.chat (wording and role framing)

**Done when:** Useful framings are noted, or "no fit" is recorded.

prompts.chat is the largest open prompt library: about 2,170 prompts, all **CC0 (public domain)**. It is mostly chat personas ("act as a…"), so it rarely supplies _structure_. It is good for _wording_: how to frame a role, a tone, or a checklist. Filter to the `STRUCTURED` type and the `for_devs` flag for the relevant slice.

- **MCP (live):** `https://prompts.chat/api/mcp` → tools `search_prompts` (query, type, category, tag, limit ≤ 50) and `get_prompt`.
- **Bulk:** `https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv`, with columns `act`, `prompt`, `for_devs`, `type`, `contributor`. Some prompts exceed Python's default CSV field size; call `csv.field_size_limit(10**9)` first, or the parse aborts.

Steps 2–4 are independent — run them in parallel.

### 5. Decide: install, improve, borrow, or build

**Done when:** A one-line verdict is recorded, with a prior-art table behind it.

Write a short table — source · ref · what to borrow · licence · verdict (adopt / adapt / ignore). Then pick exactly one:

- **Install** an existing artifact that fully covers the need → install it and stop.
- **Improve** a local one → patch it and bump its version.
- **Borrow** → distil the external one, keep its licence and attribution, and adapt it to our conventions.
- **Build** new → only when nothing covers the need. Carry the best framings from the sweep.

### 6. Draft to the kind's anatomy

**Done when:** The artifact exists on disk in the right shape.

- **Recipe** → `{{recipes_dir}}/<slug>/recipe.md`, with `kit/1.0` frontmatter: `slug`, `title`, `summary`, `version`, `category` (a real folder, or explicit), `subdivision`, and `tags` that include natural phrasings a user would actually type, plus `params` for anything specific. Body: Goal, When to Use, Steps (each with **Done when:**), Constraints, Safety Notes, Failures Overcome. Mark independent steps in `parallelism.groups`.
- **Skill** → `{{skills_dir}}/<name>/SKILL.md` with `name` and `description`. The description IS the trigger: say what it does AND when to use it, comprehensively. Keep SKILL.md lean and push detail into `references/`, loaded only when needed. Code goes in `scripts/`; test cases in `evals/`.
- **Plugin** → `{{plugins_dir}}/<name>/` with `openclaw.plugin.json`, `package.json` and `index.ts`. Wrap every hook in failure isolation, so a crash in the plugin never breaks the gateway. Declare each config key with its default and state what that default costs.

### 7. Scrub — generic skeleton, private values

**Done when:** The scrub grep returns nothing.

Anything operator-specific becomes a `{{param}}`: people's names, client or company names, domains, host-specific absolute paths, emails, tokens, internal strategy. Its value lives in the private VarStore, not in the file. Grep the draft for those patterns before saving. A generic skeleton is both shareable AND covers more of your own future tasks.

### 8. Verify it works where it will be used

**Done when:** You have observed it working, not merely saved it.

- **Recipe:** parse the frontmatter as YAML, then confirm it is listed: `openclaw gateway call prefrontal.recipe.list --json | grep <slug>`. Recipes are read from disk on every call, so no restart is needed. Dry-run two or three trigger phrases, to catch collisions with existing recipes.
- **Skill:** run its evals, or invoke it once on a real task and read the result.
- **Plugin:** build, run its tests, deploy through the normal deploy path, and confirm the gateway loads it.

### 9. Place the enhancement — which agents run it, and is it public

**Done when:** every place (each agent, and the public repo) has a decision, each decision names the rule that made it, and every decision no rule explains is one question to the owner.

Read `{{placement_policy}}` first: it names the agents, what each is for, and the owner's past rulings, and it overrides the defaults below. Then apply the defaults in order. They were read from an owner's 114 overrides of an agent's placement picks, plus the reasons he gave for the ones that looked like outliers.

1. **Check what it IS before placing it by its name.** Read the manifest (providers, contracts, required binaries). A plugin named after a marketplace company can be that company's AI-model service, not its shop.
2. **The main agent is the superset.** Whatever any agent has, the main agent has too. A capability taken off a child agent moves to the main agent instead of disappearing. The one exception: model vendors no agent calls stay off everywhere.
3. **A child agent that serves a team gets everything that helps that team's job**, including several overlapping sources for one job. A purchasing agent gets every marketplace and price source it can search, because breadth is what makes it fast and cheap. Strip only personal accounts and personal messaging, home devices, tools for a platform the machine does not run, and the chores of maintaining the public repo.
4. **Judge a capability by the role it serves, not by how it looks.** Phone location looks personal, yet it lets a manager plan flights and warn waiting customers without calling a travelling colleague. When a capability touches people, record the condition that makes it acceptable (for location: the people are told first, as local law requires) instead of stripping it.
5. **Do not remove a capability for a misuse it could have** when it has legal uses the owner wants. Torrent search also finds 3D-print files and public datasets.
6. **The delivery channel decides publication.** If an agent receives code only by pulling the public repo, "give it to that agent" means "publish it, sanitized". Per-deployment values go into a thin private overlay beside the public enhancement.
7. **Publish by default, after sanitizing.** Keep an enhancement private only when the private subject IS its content (a gateway to one company's file server, one company's wiki, one company's article codes). A private name in a slug becomes a generic name, and the result serves a wider audience.
8. **Exclusive slots are per agent, not per fleet.** Where a kind allows one active holder (a memory backend, for example), each agent picks its own; the others of that kind load but stay dormant on that agent.
9. **Inert enhancements** (a required binary is missing) cost clutter, not tokens. Keep the ones that serve a known use and list the install as a setup task; switch off the ones that serve nothing.
10. **Retire a superseded enhancement everywhere at once:** the repo, every agent, the registry listing (soft-delete, which stays restorable for a while) and the README.

Where a decision makes a live agent restart, stage it for the next start or pick a moment when that agent is idle, and say which.

### 10. Register, attribute, and — only by hand — publish

**Done when:** It is registered, attribution is in place, and the publish decision is recorded.

- Add a row to `{{recipes_dir}}/CATALOG.md` (recipes), or to the relevant index for skills and plugins.
- Keep the attribution blockquote for anything borrowed.
- If it changes how the system behaves (skills and plugins usually do), run the `bible-currency-gate` recipe.
- **Publishing is human-gated.** ClawHub needs `clawhub login`, which the owner does by hand. For the public page, use the `write-clawhub-readme` recipe and carry `{{funnel_url}}` _inside_ the text. Never auto-publish.

## Constraints

- Prior art before drafting: steps 1–5 are not optional. Enumerate by command, never from memory.
- Lightest artifact first (recipe < skill < plugin), and escalate only for a named reason.
- Improve an existing artifact before creating a near-duplicate.
- No operator specifics in the body: they belong in `{{params}}` with private values.
- Licence-gate and attribute every borrowed piece.
- A recipe is not done until `prefrontal.recipe.list` shows it; a skill or plugin is not done until it has run once.

## Safety Notes

- Installing someone else's skill runs someone else's code. Read it in `/tmp/prior-art` first; never install an unread skill into the live skills folder.
- prompts.chat content is CC0. Anything _we_ publish there becomes public domain too, so no credit is owed back. A link has to live inside the text itself.
- Publishing (ClawHub, Journey, prompts.chat) is an irreversible external action. Draft here and let the owner publish.

## Failures Overcome

- 2026-09-29: an owner kept two model-vendor plugins on a purchasing agent, reading their names as shopping platforms. Step 9 rule 1 (read the manifest before placing by name) exists because of it.

- `prompts.csv` fails to parse with `field larger than field limit (131072)`: the longest prompt is about 144k characters. Raise `csv.field_size_limit` before reading.
- Vector search is phrasing-sensitive: one query missed obvious matches. Always sweep two or three phrasings.
- A grown catalogue causes trigger collisions between recipes with overlapping tags. Dry-run ambiguous phrases before shipping.
- Local skill folders are often git-ignored, so the public registry may be the ONLY distribution path. Check before assuming a commit ships it.
