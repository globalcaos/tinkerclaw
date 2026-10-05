#!/usr/bin/env bash
# memory-bench submit — Publish a benchmark report as a PUBLIC pull request.
#
# Usage: submit.sh <report.json> [github-username] [--dry-run] [--yes]
#
#   --dry-run   Show exactly what would be uploaded, then stop. Nothing leaves
#               your machine. Do this first.
#   --yes       Skip the interactive confirmation (for scripted use).
#
# THIS UPLOADS. It forks a public repo, pushes a branch to YOUR fork, and opens
# a pull request containing the report file. A merged PR is public and permanent.
#
# Prerequisites: gh CLI authenticated, git configured.

set -euo pipefail

FORK_REPO="globalcaos/clawdbot-moltbot-openclaw"
BENCH_DIR="benchmarks/memory-bench"

REPORT=""
CONTRIBUTOR=""
DRY_RUN=0
ASSUME_YES=0

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --yes|-y)  ASSUME_YES=1 ;;
        *) if [ -z "$REPORT" ]; then REPORT="$arg"; else CONTRIBUTOR="$arg"; fi ;;
    esac
done

if [ -z "$REPORT" ] || [ ! -f "$REPORT" ]; then
    echo "❌ Usage: submit.sh <report.json> [github-username] [--dry-run] [--yes]"
    exit 1
fi

# Validate JSON
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$REPORT" 2>/dev/null; then
    echo "❌ Invalid JSON file: $REPORT"
    exit 1
fi

# Extract contributor from report if not provided
if [ -z "$CONTRIBUTOR" ]; then
    CONTRIBUTOR=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['contributor'])" "$REPORT" 2>/dev/null || echo "anonymous")
fi

# Validate contributor username
if [[ ! "$CONTRIBUTOR" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "❌ Invalid GitHub username: $CONTRIBUTOR"
    exit 1
fi

INSTANCE_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['instance_id'])" "$REPORT" 2>/dev/null || echo "unknown")
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
BRANCH="bench/${CONTRIBUTOR}-${TIMESTAMP}"
FILENAME="${CONTRIBUTOR}-${INSTANCE_ID}-${TIMESTAMP}.json"

echo "📊 Memory Bench Submission — PREVIEW"
echo "════════════════════════════════════════════════════════════════"
echo "  Destination : https://github.com/$FORK_REPO  (PUBLIC repository)"
echo "  Action      : fork → push branch '$BRANCH' to YOUR fork → open a PR"
echo "  File        : $BENCH_DIR/reports/$FILENAME"
echo ""
echo "  These fields become public if the PR is merged:"
python3 - "$REPORT" <<'PREVIEW'
import json, sys
r = json.load(open(sys.argv[1]))
m = r.get("memory_stats", {}).get("memories", {})
print(f"    contributor          : {r.get('contributor', 'anonymous')}")
print(f"    instance_id          : {r.get('instance_id', '?')}  (random UUID)")
print(f"    collected_at         : {r.get('collected_at', '?')}")
print(f"    collection_period    : {r.get('collection_period_days', '?')} days")
print(f"    system               : {r.get('system', {})}")
print(f"    active/deleted memos : {m.get('total_active', '?')} / {m.get('total_deleted', '?')}")
print(f"    type distribution    : {m.get('type_distribution', {})}")
print(f"    retrieval metrics    : {'yes' if r.get('retrieval_stats', {}).get('available') else 'no'}")
tok = r.get("token_stats", {})
print(f"    token/cost totals    : {'INCLUDED -> ' + str({k: v for k, v in tok.items() if k != 'available'}) if tok.get('available') else 'excluded'}")
extra = set(r) - {"schema_version", "collected_at", "collection_period_days", "contributor",
                  "instance_id", "system", "memory_stats", "retrieval_stats",
                  "token_stats", "longitudinal"}
if extra:
    print(f"    OTHER FIELDS         : {sorted(extra)}  <-- inspect these yourself")
print()
print("    No memory content and no benchmark queries are in this file.")
print(f"    Read it in full first: {sys.argv[1]}")
PREVIEW
echo "════════════════════════════════════════════════════════════════"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
    echo "🔍 Dry run — nothing was uploaded. Drop --dry-run to submit for real."
    exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
    if [ ! -t 0 ]; then
        echo "✋ Refusing to publish without confirmation (no terminal)."
        echo "   Re-run with --dry-run to inspect, or --yes to confirm non-interactively."
        exit 1
    fi
    printf "  Type 'publish' to open the public PR, anything else to abort: "
    read -r CONFIRM
    if [ "$CONFIRM" != "publish" ]; then
        echo "🛑 Aborted. Nothing was uploaded."
        exit 1
    fi
    echo ""
fi

# Verify gh auth
if ! gh auth status &>/dev/null; then
    echo "❌ GitHub CLI not authenticated. Run: gh auth login"
    exit 1
fi

# Fork if needed (idempotent)
echo "🔄 Ensuring fork exists..."
gh repo fork "$FORK_REPO" --clone=false 2>/dev/null || true

# Create a temp workdir to avoid touching the user's repo
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "📥 Cloning (shallow)..."
gh repo clone "$CONTRIBUTOR/$( echo $FORK_REPO | cut -d/ -f2 )" "$TMPDIR/repo" -- --depth=1 -q 2>/dev/null || \
    gh repo clone "$FORK_REPO" "$TMPDIR/repo" -- --depth=1 -q

cd "$TMPDIR/repo"

# Set upstream
git remote add upstream "https://github.com/$FORK_REPO.git" 2>/dev/null || true
git fetch upstream main --depth=1 -q

# Branch from upstream/main
git checkout -b "$BRANCH" upstream/main

# Place report
mkdir -p "$BENCH_DIR/reports"
cp "$REPORT" "$BENCH_DIR/reports/$FILENAME"

# Update aggregate index
python3 -c "
import json, glob, os, sys

reports_dir = os.path.join(sys.argv[1], 'reports')
reports = []
for f in sorted(glob.glob(os.path.join(reports_dir, '*.json'))):
    try:
        r = json.load(open(f))
        reports.append({
            'file': os.path.basename(f),
            'contributor': r.get('contributor', 'anonymous'),
            'instance_id': r.get('instance_id', ''),
            'collected_at': r.get('collected_at', ''),
            'memories': r.get('memory_stats', {}).get('memories', {}).get('total_active', 0),
            'period_days': r.get('collection_period_days', 0),
            'retrieval_available': r.get('retrieval_stats', {}).get('available', False),
        })
    except Exception:
        pass

index = {
    'updated_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'total_reports': len(reports),
    'unique_instances': len(set(r['instance_id'] for r in reports)),
    'unique_contributors': len(set(r['contributor'] for r in reports)),
    'reports': reports,
}
with open(os.path.join(sys.argv[1], 'INDEX.json'), 'w') as f:
    json.dump(index, f, indent=2)
print(f'✅ Index updated: {len(reports)} reports, {index[\"unique_instances\"]} instances')
" "$BENCH_DIR"

# Commit
git add "$BENCH_DIR/"
git commit -m "bench: add memory-bench report from $CONTRIBUTOR ($INSTANCE_ID)

Automated submission via memory-bench skill.
Collection period: $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['collection_period_days'])" "$REPORT" 2>/dev/null || echo '?') days
Active memories: $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['memory_stats']['memories']['total_active'])" "$REPORT" 2>/dev/null || echo '?')
"

# Push to contributor's fork
echo "📤 Pushing to your fork..."
git push origin "$BRANCH" -q

# Create PR
echo "📝 Creating pull request..."
PR_URL=$(gh pr create \
    --repo "$FORK_REPO" \
    --head "$CONTRIBUTOR:$BRANCH" \
    --title "bench: memory-bench report from $CONTRIBUTOR" \
    --body "## Memory Bench Report

**Contributor:** @$CONTRIBUTOR
**Instance ID:** \`$INSTANCE_ID\`
**Collection period:** $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['collection_period_days'])" "$REPORT" 2>/dev/null || echo '?') days

### Summary
$(python3 -c "
import json, sys
r = json.load(open(sys.argv[1]))
m = r['memory_stats']['memories']
ret = r['retrieval_stats']
print(f\"- **Active memories:** {m['total_active']}\")
print(f\"- **Deleted memories:** {m['total_deleted']}\")
print(f\"- **Embedding coverage:** {m['embedding_coverage']*100:.1f}%\")
print(f\"- **Type distribution:** {m['type_distribution']}\")
print(f\"- **Association count:** {r['memory_stats']['associations']['total']}\")
if ret.get('available'):
    print(f\"- **Retrieval queries logged:** {ret['total_queries']}\")
    for cfg, data in ret.get('by_config', {}).items():
        print(f\"  - {cfg}: n={data.get('query_count','N/A')}, ndcg={(data.get('ndcg') or {}).get('mean','N/A')}\")
else:
    print('- **Retrieval stats:** Not available (retrieval_log table not found)')
print(f\"- **Consolidation runs:** {r['memory_stats']['consolidation']['total_runs_in_period']}\")
" "$REPORT" 2>/dev/null || echo '(see report JSON for details)')

### Co-authorship

This data contributes to the research papers at:
- [ENGRAM (Context Compaction)](https://github.com/globalcaos/clawdbot-moltbot-openclaw/blob/main/docs/papers/context-compaction.md)
- [CORTEX (Agent Memory)](https://github.com/globalcaos/clawdbot-moltbot-openclaw/blob/main/docs/papers/agent-memory.md)

By submitting benchmark data, you are eligible for co-authorship per [#13991](https://github.com/openclaw/openclaw/issues/13991).

---
*Automated submission via \`memory-bench\` skill.*" \
    2>&1)

echo ""
echo "✅ PR created: $PR_URL"
echo ""
echo "Thank you for contributing to the research! 🧠"
