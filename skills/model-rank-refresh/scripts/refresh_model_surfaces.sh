#!/usr/bin/env bash
# Refresh and verify every derived reader of the model catalog.
#
# The agentic part of model-rank-refresh discovers, verifies, prices, and adds models.
# This script is the deterministic tail: rebuild effort estimates, THALAMUS domain
# strengths, and the dossier's provider matrix, then prove each newly-added model is
# present in the picker, smart×cost score table, published-cost resolver, and dynamic
# dossier input before running the UI suite.
set -euo pipefail

MODE=refresh
NEW_MODELS=()
while (($#)); do
  case "$1" in
    --verify-only) MODE=verify; shift ;;
    --new-model)
      [[ $# -ge 2 ]] || { echo "--new-model requires provider/model" >&2; exit 2; }
      NEW_MODELS+=("$2"); shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: refresh_model_surfaces.sh [--verify-only] [--new-model provider/model]...

Default: regenerate every derived chart/dossier/router table, verify new-model
coverage, then run the focused surface tests and the full tinker-ui suite.
--verify-only skips network regeneration but still runs every coverage/test gate.
EOF
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

WS="${HOME}/.openclaw/workspace"
TC="${HOME}/src/tinkerclaw"
SKILL="${WS}/skills/model-rank-refresh"
APP="${TC}/tinker-ui/src/app.ts"
CONFIG="${HOME}/.openclaw/openclaw.json"

for path in "$APP" "$CONFIG" \
  "$SKILL/scripts/estimate_effort_index.py" \
  "$SKILL/scripts/build_domain_strength.py" \
  "$SKILL/scripts/fetch_cn_provider_prices.mjs"; do
  [[ -f "$path" ]] || { echo "missing required input: $path" >&2; exit 1; }
done

if [[ "$MODE" == refresh ]]; then
  epoch_zip="$(mktemp --suffix=.epoch-benchmarks.zip)"
  trap 'rm -f "$epoch_zip"' EXIT
  curl -fL --retry 3 --retry-delay 2 \
    https://epoch.ai/data/benchmark_data.zip -o "$epoch_zip"
  [[ $(wc -c < "$epoch_zip") -gt 100000 ]] || {
    echo "Epoch archive is suspiciously small" >&2; exit 1;
  }
  unzip -tqq "$epoch_zip"

  python3 "$SKILL/scripts/estimate_effort_index.py" --epoch-zip "$epoch_zip"
  python3 "$SKILL/scripts/build_domain_strength.py" --epoch-zip "$epoch_zip"
  node "$SKILL/scripts/fetch_cn_provider_prices.mjs"
fi

# Dossier inclusion is intentionally dynamic: every configured scored model is read
# from modelConfigData. Guard the mechanism itself so a future refactor cannot quietly
# turn it back into a hand-maintained list.
# FORK 2026-09-05: this was `grep -Fq 'const ids = Object.keys(meta || {});'` — an EXACT
# string. Commit 4daf8e1050c legitimately rewrote the line to union in SD_UNROUTED_EXTRAS
# and the guard went red on a change that kept the mechanism perfectly intact, blocking the
# whole refresh tail. A guard pinned to a literal fails on correct code, which is the same
# defect that emptied the model picker today, one layer over. Match the MECHANISM: the
# dossier's id list must still be DERIVED from the configured models' keys.
grep -Eq 'const ids = .*Object\.keys\(meta' "$APP" || {
  echo "dossier no longer enumerates configured models dynamically" >&2; exit 1;
}

for id in "${NEW_MODELS[@]}"; do
  python3 - "$CONFIG" "$APP" "$id" <<'PY'
import json, re, sys
config_path, app_path, model_id = sys.argv[1:]
with open(config_path) as fh:
    cfg = json.load(fh)
models = cfg.get("agents", {}).get("defaults", {}).get("models", {})
if model_id not in models:
    raise SystemExit(f"NEW MODEL GATE: {model_id} is absent from agents.defaults.models")
with open(app_path) as fh:
    app = fh.read()
match = re.search(r"const AA_INTELLIGENCE_INDEX[^=]*=\s*\{(.*?)\n\};", app, re.S)
if not match or not re.search(rf'["\']{re.escape(model_id)}["\']\s*:', match.group(1)):
    raise SystemExit(f"NEW MODEL GATE: {model_id} is absent from AA_INTELLIGENCE_INDEX")
PY

  # A missing price must stay missing; DEFAULT_REL_COST is for drawing thickness, not
  # routing. Test the shared resolver the yellow envelope and gateway actually use.
  MODEL_ID="$id" pnpm --dir "$TC" exec tsx -e \
    'import { relCostLookup } from "./src/shared/rel-cost-table.ts"; const id=process.env.MODEL_ID!; const v=relCostLookup(id); if (v === undefined) { console.error(`NEW MODEL GATE: ${id} has no published cost row`); process.exit(1); } console.log(`${id}: relCost=${v}`);'
done

# ---- PANEL POPULATION GATE -------------------------------------------------
# FORK 2026-09-05 (the operator: "in the model picker panel I only have 2 models available
# now"). This gate used to prove that every model ADDED this run reached its four
# surfaces. It proved nothing about the models already there — so on 2026-09-05, when
# Artificial Analysis rebased its Intelligence Index and every score fell ~15-25%, the
# SMART MODELS set went from 23 entries to 2 and every check in this file was still
# green. A gate that only inspects the delta cannot see the floor fall out.
#
# So: count what the surfaces will actually SHOW, and refuse a refresh that empties
# them. The cut itself is ordinal now (tinker-ui/src/panels/aa-panel-floor.ts), which
# makes the collapse structurally impossible — this is the check that says so out loud,
# and the one that survives someone re-introducing an absolute threshold.
#
# It also prints the top-of-board delta, because a vendor rescale is a legitimate event
# that everything downstream needs to hear about, and the last one arrived unannounced.
BASELINE="${SKILL}/state/aa-board-baseline.json"
mkdir -p "$(dirname "$BASELINE")"
python3 - "$CONFIG" "$TC/tinker-ui/src/panels/aa-panel-floor.ts" "$BASELINE" <<'PY'
import json, os, re, sys

config_path, floor_path, baseline_path = sys.argv[1:]

top_n = int(re.search(r"AA_PANEL_TOP_N\s*=\s*(\d+)", open(floor_path).read()).group(1))

cfg = json.load(open(config_path))
models = cfg.get("agents", {}).get("defaults", {}).get("models", {})
scores = sorted(
    (m["intelligenceIndex"] for m in models.values()
     if isinstance(m, dict) and isinstance(m.get("intelligenceIndex"), (int, float))),
    reverse=True,
)

MIN_SCORED = 25   # the catalog itself must not collapse
MIN_PANEL  = 15   # SMART MODELS must stay a list, not a pair

if len(scores) < MIN_SCORED:
    raise SystemExit(
        f"PANEL GATE: only {len(scores)} configured models carry an intelligenceIndex "
        f"(expected >= {MIN_SCORED}). The catalog lost its scores; refusing to call this green."
    )

floor = scores[min(top_n, len(scores)) - 1]
admitted = sum(1 for s in scores if s >= floor)
if admitted < MIN_PANEL:
    raise SystemExit(
        f"PANEL GATE: only {admitted} models clear the SMART floor {floor:.4f} "
        f"(expected >= {MIN_PANEL}). This is the 2026-09-05 outage — the picker is empty."
    )

top = scores[0]
prev = None
if os.path.exists(baseline_path):
    try:
        prev = json.load(open(baseline_path)).get("top")
    except Exception:
        prev = None

note = ""
if isinstance(prev, (int, float)) and prev > 0:
    delta = (top - prev) / prev * 100
    note = f" (top moved {delta:+.1f}% since last run)"
    if abs(delta) >= 5:
        note += "  <-- BOARD RESCALED: tell every downstream reader of this index"

print(f"panel gate ok: {len(scores)} scored, top {top:.4f}, "
      f"floor {floor:.4f}, {admitted} in SMART MODELS{note}")

json.dump({"top": top, "scored": len(scores), "floor": floor, "admitted": admitted},
          open(baseline_path, "w"), indent=1)
PY

cd "$TC"
pnpm exec vitest run --config test/vitest/vitest.tinker-ui.config.ts \
  tinker-ui/src/panels/aa-effort-index.test.ts \
  tinker-ui/src/panels/smart-cost-chart-thalamus-envelope.test.ts \
  tinker-ui/src/panels/smart-model-dossier.test.ts
pnpm test:tinker-ui

printf 'model surfaces green: regenerated=%s new_models=%d\n' \
  "$([[ "$MODE" == refresh ]] && echo yes || echo no)" "${#NEW_MODELS[@]}"
