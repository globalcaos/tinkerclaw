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
HIVE_DOOR="no"; HIVE_OWNER=""
if [ "$SETTING" = company ]; then
  COMPANY="$(ask 'Company name' '')"; DEPT="$(ask 'Department' '')"; ROLE="$(ask 'This agent'\''s role' overseer)"
  # Multi-user mode is opt-in and OFF by default: a personal install never sees this question.
  HIVE_DOOR="$(ask 'Several people will use this agent, each with their own token? Turns on the hive door so nobody can pose as someone else [yes/no]' no)"
  case "$HIVE_DOOR" in yes|y) HIVE_OWNER="$(ask 'Your name (the first person who gets a token)' Owner)" ;; esac
fi
OBJECTIVE="$(ask 'One-line objective/personality for the agent' 'A capable, direct assistant.')"
# Download daemon is opt-in and OFF by default: it needs aria2 and a systemd user unit.
DOWNLOADER="$(ask 'Download daemon for torrents and large files (aria2, Linux)? Lets the agent start a download that survives the chat and a reboot [yes/no]' no)"

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

# ---- 4b. Multi-user door (opt-in; see scripts/hive-door/README.md) ---------------
HIVE_NOTE=""
case "$HIVE_DOOR" in
  yes|y)
    say "Turning on the hive door (one token per person)…"
    HIVE_ID="$(printf '%s' "$HIVE_OWNER" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/^-*//;s/-*$//')"
    if node scripts/hive-door/setup.mjs --owner-id "${HIVE_ID:-owner}" --owner-name "${HIVE_OWNER:-Owner}" --title "$AGENT_NAME"; then
      HIVE_NOTE="Multi-user door is ON. Your first token is in ~/.openclaw/data/door/ (read it, delete the file). Add people: ${BOLD}node scripts/hive-door/door-tokens.mjs add <id> <Name>${N}"
    else
      warn "The hive door is configured but NOT running yet (see the command printed above)."
      HIVE_NOTE="Multi-user door is configured but NOT running. Start it with the command printed above, or re-run: ${BOLD}node scripts/hive-door/setup.mjs${N}"
    fi ;;
esac

# ---- 4c. Download daemon (opt-in; see extensions/tinkerclaw-downloader/README.md) ---
DOWNLOADER_NOTE=""
case "$DOWNLOADER" in
  yes|y)
    say "Installing the download daemon (aria2 on a systemd user unit)…"
    if node scripts/downloader/setup.mjs; then
      DOWNLOADER_NOTE="Download daemon is ON. Check it any time: ${BOLD}node scripts/downloader/setup.mjs --check${N}"
    else
      warn "The download daemon is NOT running (see the message above)."
      DOWNLOADER_NOTE="Download daemon is NOT running. Fix what the message above says, then re-run: ${BOLD}node scripts/downloader/setup.mjs${N}"
    fi ;;
esac

# ---- 5. Structural crons (the habits, not just the engine) -------------------
# These are the jobs that make the fork maintain ITSELF overnight: consolidate
# memory, tidy the workspace, sweep for security updates, refresh model ranks,
# scan the agent-OSS ecosystem. They ship with the repo under
# extensions/tinkerclaw-tinker-bridge/crons/ and each one is a readable brief.
#
# They are seeded ON, so a fresh clone behaves like a mature one out of the box.
# Be clear-eyed about what that means: each job wakes an agent on a schedule and
# spends model tokens on YOUR account — the whole nightly cycle is roughly one
# euro a night. Answer "off" to install them switched off, or "skip" to not
# install them at all; either way you can change your mind later.
say "Structural crons — nightly self-maintenance jobs bundled with this repo:"
node scripts/seed-structural-crons.mjs --list 2>/dev/null || true
CRON_ANSWER="$(ask 'Install them? "on" = running tonight (~1 EUR/night of tokens), "off" = installed but idle, "skip" = not at all [on/off/skip]' on)"
CRON_NOTE=""
case "$CRON_ANSWER" in
  skip|no|n) say "Skipping cron seeding. Run 'pnpm tinker:crons' any time." ;;
  off|disabled)
    if node scripts/seed-structural-crons.mjs --disabled; then :; else
      warn "Could not seed crons yet (the cron CLI needs a running gateway)."
      CRON_NOTE="Seed the nightly jobs: ${BOLD}pnpm tinker:crons -- --disabled${N}"
    fi ;;
  *)
    if node scripts/seed-structural-crons.mjs; then :; else
      warn "Could not seed crons yet (the cron CLI needs a running gateway)."
      CRON_NOTE="Seed the nightly jobs: ${BOLD}pnpm tinker:crons${N}"
    fi ;;
esac

# ---- 5. Optional components -------------------------------------------------
say "Optional components (install later from ClawHub / plugins as needed):"
echo "   • browser plugin   • mesh-VPN join   • messaging channels"
echo "   • download daemon  (node scripts/downloader/setup.mjs)"
echo "   • multi-user door  (company setting only: node scripts/hive-door/setup.mjs)"

# ---- 6. Done ----------------------------------------------------------------
cat <<DONE

$(printf "${BOLD}Setup complete.${N}")
  Run mode      : $RUN_MODE
  Code-linking  : $LINK
  Agent         : $AGENT_NAME${COMPANY:+ @ $COMPANY}
  Workspace     : $WS
  Multi-user    : ${HIVE_DOOR:-no}
  Downloader    : ${DOWNLOADER:-no}

Start the gateway:   ${BOLD}openclaw gateway start${N}     (or: node openclaw.mjs)
Open the UI:         the address the gateway prints on start.
${CRON_NOTE:+
$CRON_NOTE}
${HIVE_NOTE:+
$HIVE_NOTE}
${DOWNLOADER_NOTE:+
$DOWNLOADER_NOTE}

Personalize by editing files in your workspace ($WS) — never in this repo,
so future 'git pull' stays clean. See FORK_SETUP.md for the git-pull contract.
DONE
