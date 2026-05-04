/**
 * FORK: tinkerclaw-people — _index.md regeneration.
 *
 * Human-browsable index of every profile, grouped by display name with the
 * slug, primary email, primary phone, and lastInteraction (from _state.json).
 * Regenerated whenever the alias map changes.
 */
import fs from "node:fs";
import type { PeopleResolvedConfig } from "./paths.js";
import type { AliasMap, StateMap } from "./store.js";

export function renderIndexMd(aliases: AliasMap, state: StateMap): string {
  const rows = Object.entries(aliases).map(([slug, alias]) => {
    const email = alias.emails?.[0] ?? "";
    const phone = alias.phones?.[0] ?? "";
    const last = state[slug]?.lastInteraction ?? "";
    return { slug, displayName: alias.displayName, email, phone, last };
  });
  rows.sort((a, b) => {
    if (a.last && b.last) return b.last.localeCompare(a.last);
    if (a.last) return -1;
    if (b.last) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
  const header =
    "# People — Auto Index\n\n" +
    "*Auto-maintained — every profile lives in this directory as `<slug>.md`. Edits to **Manual context** in each profile are preserved across cron runs.*\n\n" +
    "| Display name | Slug | Email | Phone | Last interaction |\n" +
    "|---|---|---|---|---|\n";
  const body = rows
    .map(
      (r) =>
        `| ${r.displayName} | [\`${r.slug}\`](./${r.slug}.md) | ${r.email} | ${r.phone} | ${r.last} |`,
    )
    .join("\n");
  return header + body + "\n";
}

export function writeIndexMd(cfg: PeopleResolvedConfig, aliases: AliasMap, state: StateMap) {
  fs.mkdirSync(cfg.peopleDir, { recursive: true });
  fs.writeFileSync(cfg.indexPath, renderIndexMd(aliases, state), "utf-8");
}
