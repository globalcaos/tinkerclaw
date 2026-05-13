#!/usr/bin/env node
/**
 * FORK: tinkerclaw-control-panel — one-shot import from Todoist v1 API.
 *
 * Reads tasks from both Todoist projects via the v1 REST API, maps each
 * Todoist task to a `control-panel.tasks.import` manifest entry, and inserts
 * via the gateway RPC.
 *
 * Run after rotating TODOIST_API_TOKEN at
 *   https://todoist.com/app/settings/integrations/developer
 *
 * Usage:
 *   TODOIST_API_TOKEN=<fresh-token> \
 *     node extensions/tinkerclaw-control-panel/scripts/import-from-todoist.mjs
 *
 * Defaults:
 *   - All imported tasks land under axis "ventures" (unless --axis overrides).
 *     Rationale: per SPEC §14, the import is a one-shot before subscription
 *     cancellation; the user can re-assign axes inside Tinker as needed.
 *   - Tasks with a due_date carry it forward; others default to today (NULL).
 *   - Duplicate IDs are skipped (idempotent — safe to re-run).
 */
import { execSync } from "node:child_process";

const TOKEN = process.env.TODOIST_API_TOKEN;
if (!TOKEN) {
  console.error("ERROR: TODOIST_API_TOKEN not set in env.");
  process.exit(1);
}

const args = process.argv.slice(2);
const argAxis = (() => {
  const i = args.indexOf("--axis");
  return i >= 0 ? args[i + 1] : "ventures";
})();
const dryRun = args.includes("--dry-run");

async function fetchAllTodoistTasks() {
  const out = [];
  // The v1 API returns all active tasks for the workspace under the auth token.
  // Pagination uses `cursor` if > 200 tasks; we follow it.
  let cursor = null;
  for (;;) {
    const url = new URL("https://api.todoist.com/api/v1/tasks");
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`Todoist API ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    const tasks = Array.isArray(body.results) ? body.results : Array.isArray(body) ? body : [];
    out.push(...tasks);
    cursor = body.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

function mapTodoistToManifest(td) {
  const id = `todoist-${td.id}`;
  const text = td.content ?? td.title ?? "(no content)";
  const dueDate = td.due?.date ?? null;
  const labels = Array.isArray(td.labels) ? td.labels : [];
  const description =
    typeof td.description === "string" && td.description.length > 0 ? td.description : null;
  return {
    id,
    text,
    context_md: description,
    priority_axis: argAxis,
    priority_rank: 50 - (td.priority ?? 1) * 10, // p1→40 (top), p4→10 (bottom)
    due_date: dueDate,
    hands: "user",
    metadata: {
      todoist_id: td.id,
      todoist_project_id: td.project_id ?? null,
      todoist_labels: labels,
      todoist_priority: td.priority ?? 1,
      todoist_url: td.url ?? null,
    },
  };
}

function callRpc(method, params) {
  const json = JSON.stringify(params);
  const cmd = `openclaw gateway call ${method} --params ${JSON.stringify(json)} --json --timeout 30000`;
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out);
  } catch (err) {
    console.error(`RPC ${method} failed:`, err.message);
    if (err.stdout) console.error("stdout:", err.stdout);
    if (err.stderr) console.error("stderr:", err.stderr);
    throw err;
  }
}

async function main() {
  console.log("▶ Fetching Todoist tasks...");
  const todoist = await fetchAllTodoistTasks();
  console.log(`  fetched ${todoist.length} active tasks`);

  const manifestTasks = todoist.map(mapTodoistToManifest);
  console.log(`▶ Mapped ${manifestTasks.length} tasks to axis="${argAxis}"`);

  if (dryRun) {
    console.log("DRY RUN — not calling the gateway");
    console.log(JSON.stringify(manifestTasks.slice(0, 5), null, 2));
    return;
  }

  const passId = `2026-05-11.todoist-import-${Date.now()}`;
  const result = callRpc("control-panel.tasks.import", {
    pass_id: passId,
    version: 2,
    delivered_to_user_at: Date.now(),
    prune_missing: false,
    tasks: manifestTasks,
  });

  console.log("▶ Import result:");
  console.log(`  inserted: ${result.inserted?.length ?? 0}`);
  console.log(`  updated: ${result.updated?.length ?? 0}`);
  console.log(`  skipped_dismissed: ${result.skipped_dismissed?.length ?? 0}`);
  console.log(`  dropped_missing: ${result.dropped_missing?.length ?? 0}`);
  console.log("✓ Done.");
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
