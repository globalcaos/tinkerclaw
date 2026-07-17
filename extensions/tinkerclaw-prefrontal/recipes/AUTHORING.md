# Authoring recipes so they SHOW in the recipes tab

The recipes tab is fed by `prefrontal.recipe.list` → `listOwnKits()` (in
`extensions/tinkerclaw-prefrontal/recipe-rpcs.ts`), then grouped by category in
`tinker-ui/src/app.ts` (`renderRecipesTab`). As of 2026-07-08 the scanner walks
this folder **recursively**, so both layouts below are visible. Before that fix
only top-level `<slug>/recipe.md` kits appeared and everything in a category
folder was invisible.

## The two layouts (both tab-visible)

1. **Self-contained kit** — `recipes/<slug>/recipe.md` (or legacy `kit.md`).
   Use for shareable / installable kits. Slug = frontmatter `slug` (or the dir
   name). Category = frontmatter `category` (or inferred from tags).

2. **Category-folder playbook** — `recipes/<category>/<name>.md`, optionally
   nested one more level for a **subdivision**: `recipes/<category>/<subdivision>/<name>.md`.
   - **Category = the top-level folder name** (e.g. `writing/…` → category
     `writing`). A frontmatter `category:` still works and wins when present.
   - **Subdivision = the nested folder** (e.g. `writing/papers/write-paper.md`
     → subdivision `papers`), rendered as a sub-header inside the category.
   - **Slug = frontmatter `slug` / `id`, else the filename** (minus `.md` /
     `.recipe.md`). This is why two files in one folder don't collide.

A bare `recipes/<name>.md` at the root is also surfaced (category from
frontmatter).

## Rules for a new recipe

- Give it a **category** that is a real folder OR an explicit `category:` field.
- If a category grows past ~8 recipes, **subdivide it** — either move files into
  a `<category>/<subdivision>/` folder, or add a `subdivision: "<label>"`
  frontmatter field (works even for top-level kits, no move needed).
- The UI declares colors/icons for known categories in `RECIPE_CATEGORIES`
  (app.ts). An **unknown** category still renders (generic 📦 bucket) — nothing
  is silently dropped — but add it to `RECIPE_CATEGORIES` for a proper
  color/icon/label.
- **Verify** it shows: `openclaw gateway call prefrontal.recipe.list --json`
  and grep for your slug. The plugin runs from `dist/`, so a code change to the
  scanner needs a build + gateway restart; a new _recipe file_ is picked up live
  (the scanner reads disk each call).

## Frontmatter fields the tab reads

`slug` / `id`, `title`, `summary`, `tags` (searched), `category`, `subdivision`.
