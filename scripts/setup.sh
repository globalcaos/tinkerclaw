#!/usr/bin/env bash
# TinkerClaw — from-source setup & agent configuration
# The cloner's journey: after `git clone`, run `bash scripts/setup.sh`.
# Generic by design: no company, person, or deployment is named here — all
# personalization lands in your workspace (~/.openclaw), never in the repo.
set -euo pipefail

BOLD='\033[1m'; C='\033[38;2;0;229;204m'; W='\033[38;2;255;176;32m'; E='\033[38;2;230;57;70m'; N='\033[0m'
say(){ printf "${C}▸${N} %s\n" "$*"; }
warn(){ printf "${W}!${N} %s\n" "$*"; }
die(){ printf "${E}✗ %s${N}\n" "$*"; exit 1; }
ask(){ local p="$1" d="${2:-}"; local a; read -r -p "$(printf "${BOLD}%s${N}%s " "$p" "${d:+ [$d]}")" a || true; echo "${a:-$d}"; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
printf "${BOLD}TinkerClaw setup${N}  (%s)\n\n" "$REPO"

# ---- 1. Prerequisites -------------------------------------------------------
say "Checking prerequisites…"
command -v git >/dev/null || die "git is required"
if ! command -v node >/dev/null; then
  die "Node.js not found. Install Node >= 22.14 (recommended: nvm → 'nvm install 24'), then re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node >= 22.14 required (found $(node -v))."
if ! command -v pnpm >/dev/null; then
  say "Enabling pnpm via corepack…"; corepack enable >/dev/null 2>&1 || npm i -g pnpm@latest
fi
say "node $(node -v) · pnpm $(pnpm -v) · git $(git --version | awk '{print $3}')"

# ---- 2. Install & build -----------------------------------------------------
say "Installing dependencies (pnpm install)…"
pnpm install

# The gateway boots from dist/entry.(m)js — `pnpm install` does NOT produce it.
# Without this build the installer prints "Setup complete", and the very next
# command it tells you to run dies with "missing dist/entry.(m)js (build output)".
# Found 2026-09-08 on a real from-scratch deployment, where exactly that happened.
say "Building the gateway (pnpm build)…"
pnpm build
if [ ! -f dist/entry.js ] && [ ! -f dist/entry.mjs ]; then
  die "Build finished but dist/entry.(m)js is missing — the gateway cannot start. Check the pnpm build output above."
fi

if [ -d tinker-ui ]; then
  say "Installing tinker-ui deps…"; ( cd tinker-ui && pnpm install )
fi

RUN_MODE="$(ask 'Run mode — production (built UI) or development (Vite/HMR)?' production)"
if [ "$RUN_MODE" = production ] && [ -d tinker-ui ]; then
  say "Building tinker-ui (production)…"; ( cd tinker-ui && pnpm build )
fi

# ---- 3. Code-linking (installer option) -------------------------------------
LINK="$(ask 'Code-linking — installed-copy (default) or dev-linked (edit the clone live)?' installed-copy)"
if [ "$LINK" = dev-linked ]; then
  say "Linking the gateway CLI globally so edits to this clone are live…"
  pnpm link --global || warn "pnpm link --global failed (non-fatal)."
fi

# ---- 4. Agent identity (personalization lives in the workspace) -------------
WS="${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"
mkdir -p "$WS"
AGENT_NAME="$(ask 'Agent name' Assistant)"
SETTING="$(ask 'Setting — personal or company?' personal)"
COMPANY=""; DEPT=""; ROLE=""
if [ "$SETTING" = company ]; then
  COMPANY="$(ask 'Company name' '')"; DEPT="$(ask 'Department' '')"; ROLE="$(ask 'This agent'\''s role' overseer)"
fi
OBJECTIVE="$(ask 'One-line objective/personality for the agent' 'A capable, direct assistant.')"

IDFILE="$WS/IDENTITY.md"
if [ -e "$IDFILE" ]; then
  warn "IDENTITY.md already exists in the workspace — leaving it untouched."
else
  say "Writing agent identity to $IDFILE (workspace, not the repo)…"
  {
    echo "# Identity"
    echo
    echo "- **Name:** $AGENT_NAME"
    echo "- **Setting:** $SETTING${COMPANY:+ — $COMPANY${DEPT:+ / $DEPT}${ROLE:+ ($ROLE)}}"
    echo "- **Objective:** $OBJECTIVE"
  } > "$IDFILE"
fi

# ---- 5. Structural crons (the habits, not just the engine) -------------------
# These are the jobs that make the fork maintain ITSELF overnight: consolidate
# memory, tidy the workspace, sweep for security updates, refresh model ranks,
# scan the agent-OSS ecosystem. They ship with the repo under
# extensions/tinkerclaw-tinker-bridge/crons/ and each one is a readable brief.
#
# They seed ENABLED by default so a novice cloner gets the benefit without
# knowing what to opt into. Each job uses the cloner's configured/default model
# (no pinned Claude provider), never delivers outbound, and never takes an
# irreversible action. Opt out is one answer: skip. Disable later with
# `pnpm tinker:crons:disable` (only affects jobs that are not yet installed).
say "Structural crons — nightly self-maintenance jobs bundled with this repo:"
node --import tsx scripts/seed-structural-crons.mjs --list 2>/dev/null || true
CRON_ANSWER="$(ask 'Install them? (default ON — uses your model for nightly self-maintenance; skip to opt out) [on/skip/off]' on)"
CRON_NOTE=""
case "$CRON_ANSWER" in
  skip|no|n) say "Skipping cron seeding. Run 'pnpm tinker:crons' any time." ;;
  off|disabled)
    if node --import tsx scripts/seed-structural-crons.mjs --disabled; then :; else
      warn "Could not seed crons yet. Re-run: pnpm tinker:crons:disable"
      CRON_NOTE="Seed the nightly jobs (disabled): ${BOLD}pnpm tinker:crons:disable${N}"
    fi ;;
  *)
    if node --import tsx scripts/seed-structural-crons.mjs; then :; else
      warn "Could not seed crons yet. Re-run: pnpm tinker:crons"
      CRON_NOTE="Seed the nightly jobs: ${BOLD}pnpm tinker:crons${N}"
    fi ;;
esac

# ---- 5. Optional components -------------------------------------------------
say "Optional components (install later from ClawHub / plugins as needed):"
echo "   • browser plugin   • downloader app   • mesh-VPN join   • messaging channels"

# ---- 6. Done ----------------------------------------------------------------
cat <<DONE

$(printf "${BOLD}Setup complete.${N}")
  Run mode      : $RUN_MODE
  Code-linking  : $LINK
  Agent         : $AGENT_NAME${COMPANY:+ @ $COMPANY}
  Workspace     : $WS

Start the gateway:   ${BOLD}openclaw gateway start${N}     (or: node openclaw.mjs)
Open the UI:         the address the gateway prints on start.
${CRON_NOTE:+
$CRON_NOTE}

Personalize by editing files in your workspace ($WS) — never in this repo,
so future 'git pull' stays clean. See FORK_SETUP.md for the git-pull contract.
DONE
