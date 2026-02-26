#!/usr/bin/env bash
# FORK: Full stack setup for the globalcaos OpenClaw fork
# Replicates the complete environment: gateway + diagnostics + skills
# Run from the repo root: bash scripts/fork-setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_DIR="${HOME}/.openclaw"
CONFIG_FILE="${OPENCLAW_DIR}/openclaw.json"

echo "=== OpenClaw Fork Setup ==="
echo "Repo: ${REPO_DIR}"
echo "Config: ${CONFIG_FILE}"
echo ""

# ─── Step 1: Dependencies ──────────────────────────────────────────
echo "▸ Step 1: Installing Node dependencies..."
cd "${REPO_DIR}"
if command -v pnpm &>/dev/null; then
  pnpm install
elif command -v npm &>/dev/null; then
  npm install
else
  echo "ERROR: Neither pnpm nor npm found. Install Node.js 22+ first."
  exit 1
fi
echo "  ✓ Dependencies installed"

# ─── Step 2: Build ─────────────────────────────────────────────────
echo "▸ Step 2: Building..."
if command -v pnpm &>/dev/null; then
  pnpm build || {
    echo "  ⚠ Full build failed. Trying tsdown only (skipping A2UI)..."
    npx tsdown
  }
else
  npm run build || {
    echo "  ⚠ Full build failed. Trying tsdown only (skipping A2UI)..."
    npx tsdown
  }
fi
echo "  ✓ Build complete"

# ─── Step 3: ClawMetry (OTEL diagnostics dashboard) ───────────────
echo "▸ Step 3: Setting up ClawMetry (diagnostics dashboard)..."
if command -v clawmetry &>/dev/null; then
  echo "  ✓ ClawMetry already installed ($(clawmetry --version 2>/dev/null || echo 'unknown version'))"
else
  echo "  Installing ClawMetry via pip..."
  pip3 install --user clawmetry
  echo "  ✓ ClawMetry installed"
fi

# Check if clawmetry is running
if ss -ltnp 2>/dev/null | grep -q ":4001"; then
  echo "  ✓ ClawMetry already running on port 4001"
else
  echo "  Starting ClawMetry on port 4001..."
  nohup clawmetry --port 4001 --data-dir "${OPENCLAW_DIR}" --no-debug > /tmp/clawmetry.log 2>&1 &
  sleep 2
  if ss -ltnp 2>/dev/null | grep -q ":4001"; then
    echo "  ✓ ClawMetry started (PID $!)"
  else
    echo "  ⚠ ClawMetry failed to start. Check /tmp/clawmetry.log"
  fi
fi

# ─── Step 4: Config template ──────────────────────────────────────
echo "▸ Step 4: Checking config..."
mkdir -p "${OPENCLAW_DIR}"

if [ -f "${CONFIG_FILE}" ]; then
  echo "  Config already exists. Checking diagnostics..."
  if python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    c = json.load(f)
d = c.get('diagnostics', {})
if not d.get('enabled') or not d.get('otel', {}).get('enabled'):
    exit(1)
" 2>/dev/null; then
    echo "  ✓ Diagnostics already enabled"
  else
    echo "  ⚠ Diagnostics not enabled in config."
    echo "  Run: openclaw config set diagnostics.enabled true"
    echo "  Run: openclaw config set diagnostics.otel.enabled true"
    echo "  Run: openclaw config set diagnostics.otel.endpoint http://localhost:4001"
    echo ""
    echo "  Or apply the template config with: bash scripts/fork-setup.sh --apply-diagnostics"
    if [ "${1:-}" = "--apply-diagnostics" ]; then
      python3 -c "
import json
with open('${CONFIG_FILE}') as f:
    c = json.load(f)
c.setdefault('diagnostics', {})
c['diagnostics']['enabled'] = True
c['diagnostics']['otel'] = {
    'enabled': True,
    'endpoint': 'http://localhost:4001',
    'serviceName': 'openclaw',
    'traces': True,
    'metrics': True,
    'logs': False,
    'sampleRate': 1
}
c.setdefault('plugins', {}).setdefault('entries', {})
c['plugins']['entries']['diagnostics-otel'] = {'enabled': True}
with open('${CONFIG_FILE}', 'w') as f:
    json.dump(c, f, indent=2)
print('  ✓ Diagnostics config applied')
"
    fi
  fi
else
  echo "  ⚠ No config file found. Run 'openclaw setup' first to create base config."
  echo "  Then re-run this script."
fi

# ─── Step 5: Skills ───────────────────────────────────────────────
echo "▸ Step 5: Skills available in workspace/skills/:"
ls "${REPO_DIR}/skills/" 2>/dev/null | head -20
SKILL_COUNT=$(ls "${REPO_DIR}/skills/" 2>/dev/null | wc -l)
echo "  ✓ ${SKILL_COUNT} skills available"

# ─── Step 6: Gateway ──────────────────────────────────────────────
echo ""
echo "▸ Step 6: Gateway"
if ss -ltnp 2>/dev/null | grep -q ":18789"; then
  echo "  ✓ Gateway already running on port 18789"
else
  echo "  Gateway not running. Start with:"
  echo "    nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &"
fi

# ─── Summary ──────────────────────────────────────────────────────
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Stack:"
echo "  • Gateway:    port 18789 (openclaw gateway)"
echo "  • ClawMetry:  port 4001 (OTEL diagnostics dashboard)"
echo "  • Skills:     ${SKILL_COUNT} available in workspace/skills/"
echo ""
echo "Quick start:"
echo "  1. Configure: openclaw setup"
echo "  2. Start:     openclaw gateway run --bind loopback --port 18789 --force"
echo "  3. Dashboard: open http://localhost:4001"
echo ""
echo "To apply diagnostics config: bash scripts/fork-setup.sh --apply-diagnostics"
