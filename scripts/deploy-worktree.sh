#!/usr/bin/env bash
#
# deploy-worktree.sh — safe OpenClaw gateway deploy: build in a clean detached
# git worktree, gate the artifacts, swap them under a STOPPED gateway, then
# restart unconditionally.
#
# WHY THIS EXISTS: on 2026-07-29 a `pnpm build` run directly in this shared
# checkout while the gateway was live deleted dist/ under the running process
# and crashed it mid-conversation (ERR_MODULE_NOT_FOUND on a content-hashed
# chunk). This script makes the safe path the easy path. The exact procedure
# it encodes ran successfully 09:27-09:46 on 2026-07-29.
#
# USAGE
#   scripts/deploy-worktree.sh [--sha <SHA>] [--note <text>] [--keep-worktree] [--dry-run]
#
#   --sha <SHA>       commit to deploy; defaults to the current HEAD of the
#                     local `develop` branch. Always resolved to an explicit
#                     commit SHA and built from a DETACHED worktree at that
#                     SHA — never build a branch name: the shared checkout is
#                     permanently dirty with peer work-in-progress and a
#                     branch could move mid-deploy.
#   --note <text>     passed through to gateway-full-restart.sh --note
#                     (wake note for the agent after the restart).
#   --keep-worktree   do not remove the deploy worktree at the end.
#   --dry-run         run Phase 1 (build) and Phase 2 (gates) only; never
#                     touches the live tree or the gateway.
#
# EXIT CODES (distinct per failure so the failing step is identifiable from
# the exit status alone):
#    0  success
#    2  usage / SHA-resolution error
#    3  missing prerequisite tool (git / node / pnpm)
#   10  git worktree add failed
#   11  pnpm install failed            (build NOT attempted after this)
#   12  pnpm build failed
#   20  gate: dist/.buildstamp missing
#   21  gate: buildstamp `head` != requested SHA
#   22  gate: dist/index.js missing
#   23  gate: dist/.runtime-postbuildstamp missing
#   24  gate: dist-runtime/ missing
#   25  gate: smoke test (`node dist/index.js --version`) lacks the short SHA
#   26  gateway still ACTIVE after `systemctl --user stop` — swap aborted with
#       the live tree untouched (old build keeps running; safe state)
#   30  gateway ACTIVE at the end, but >=1 swap step failed (inspect the log)
#   40  gateway NOT active at the end  — needs a human NOW
#
# ── VERIFIED LANDMINES (2026-07-29) — both actively fight recovery ──────────
# 1. ~/.config/systemd/user/openclaw-gateway.service.d/build-guard.conf runs
#    `pnpm build` IN THE SHARED TREE if dist/index.js is missing at service
#    start — and the base unit's TimeoutStartSec=30 guarantees that build can
#    never finish, so the service just dies. Therefore the swap below must
#    always leave a COMPLETE dist/ in place.
# 2. ~/.config/systemd/user/openclaw-gateway.service.d/no-restart.conf sets
#    Restart=no, so a bad dist stays DOWN until a human intervenes. That is
#    why Phase 4 (start) is UNCONDITIONAL and must never be &&-chained behind
#    a rename that might fail.
# Measured fact: a worktree-built dist IS relocatable — zero absolute
# build-directory paths were found across 2.0 GB of dist, and native .node
# addons are per-arch copies inside dist/extensions/*/node_modules.
# ────────────────────────────────────────────────────────────────────────────
#
# Deliberately `set -uo pipefail` and NOT `set -e`: phases 3 and 4 check each
# step's rc individually, so a failed step can never silently abort the
# script and skip the unconditional restart (with Restart=no, that would
# leave the gateway down with nothing to recover it).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"

say() { echo "[deploy] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
die() { local _rc="$1"; shift; say "FATAL(rc=${_rc}): $*"; exit "${_rc}"; }
usage() { echo "usage: scripts/deploy-worktree.sh [--sha <SHA>] [--note <text>] [--keep-worktree] [--dry-run]"; }

# ── args ────────────────────────────────────────────────────────────────────
SHA_ARG=""
NOTE=""
KEEP_WT=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sha)           [ $# -ge 2 ] || { usage; die 2 "--sha needs a value"; };  SHA_ARG="$2"; shift 2 ;;
    --note)          [ $# -ge 2 ] || { usage; die 2 "--note needs a value"; }; NOTE="$2";    shift 2 ;;
    --keep-worktree) KEEP_WT=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage; die 2 "unknown argument: $1" ;;
  esac
done

for tool in git node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || die 3 "required tool not on PATH: $tool"
done

# ── resolve the commit to deploy (always a pinned SHA, never a branch) ──────
if [ -n "$SHA_ARG" ]; then
  SHA="$(git -C "$REPO" rev-parse --verify --quiet "${SHA_ARG}^{commit}")" \
    || die 2 "cannot resolve --sha '${SHA_ARG}' to a commit"
else
  SHA="$(git -C "$REPO" rev-parse --verify --quiet "develop^{commit}")" \
    || die 2 "cannot resolve local branch 'develop' (pass --sha explicitly)"
fi
SHORT_SHA="$(git -C "$REPO" rev-parse --short "$SHA")"

STAMP="$(date +%Y%m%d-%H%M%S)"
WT="${HOME}/src/.tclaw-deploy-${STAMP}"

# ── phase 1: build in a clean detached worktree (NEVER the shared tree) ─────
DIRTY_COUNT="$(git -C "$REPO" status --porcelain | wc -l | tr -d ' ')"
say "── phase 1: build in clean detached worktree ──"
say "repo:      $REPO (dirty files in shared checkout: ${DIRTY_COUNT} — left untouched)"
say "deploying: $SHA (${SHORT_SHA})"
say "worktree:  $WT"
say "node $(node -v) | pnpm $(pnpm -v)"

git -C "$REPO" worktree add --detach "$WT" "$SHA"
[ $? -eq 0 ] || die 10 "git worktree add failed"

T_PHASE=$SECONDS
( cd "$WT" && pnpm install --frozen-lockfile )
if [ $? -ne 0 ]; then
  say "worktree left at $WT for inspection (remove: git -C $REPO worktree remove --force $WT)"
  die 11 "pnpm install failed — NOT building on top of a failed install"
fi
say "pnpm install: $((SECONDS - T_PHASE))s"

T_PHASE=$SECONDS
( cd "$WT" && pnpm build )
if [ $? -ne 0 ]; then
  say "worktree left at $WT for inspection (remove: git -C $REPO worktree remove --force $WT)"
  die 12 "pnpm build failed"
fi
say "pnpm build: $((SECONDS - T_PHASE))s"

# ── phase 2: gates — ALL must pass; the live tree is untouched until they do ─
say "── phase 2: gates (live tree untouched so far) ──"

BS="${WT}/dist/.buildstamp"
[ -f "$BS" ] || die 20 "gate: ${BS} missing"
BS_HEAD="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).head' "$BS" 2>/dev/null)"
[ "$BS_HEAD" = "$SHA" ] || die 21 "gate: buildstamp head '${BS_HEAD}' != requested '${SHA}'"
say "gate ok: buildstamp head matches requested SHA"

[ -f "${WT}/dist/index.js" ] || die 22 "gate: ${WT}/dist/index.js missing"
say "gate ok: dist/index.js present"

[ -f "${WT}/dist/.runtime-postbuildstamp" ] || die 23 "gate: ${WT}/dist/.runtime-postbuildstamp missing"
say "gate ok: dist/.runtime-postbuildstamp present"

[ -d "${WT}/dist-runtime" ] || die 24 "gate: ${WT}/dist-runtime/ missing"
say "gate ok: dist-runtime/ present"

SMOKE="$(node "${WT}/dist/index.js" --version 2>&1)"
# FORK 2026-07-29: compare by PREFIX, not by substring-match against
# `git rev-parse --short`. The binary stamps its own abbreviation (7 chars) while
# this repo's core.abbrev is 11, so `*"$SHORT_SHA"*` could NEVER match and this
# gate rejected every otherwise-valid build. Observed on the first real use:
#   FATAL(rc=25): smoke test output 'OpenClaw 2026.4.27 (e0ca2c2)'
#                 does not contain 'e0ca2c26db0'
# Extracting the sha the binary reports and requiring the deployed SHA to START
# with it is agnostic to the abbreviation length on either side, so it keeps
# working if either the build stamp or core.abbrev changes.
SMOKE_SHA="$(printf '%s' "$SMOKE" | grep -oE '[0-9a-f]{7,40}' | head -1)"
if [ -z "$SMOKE_SHA" ]; then
  die 25 "gate: smoke test output '${SMOKE}' contains no commit sha"
fi
case "$SHA" in
  "${SMOKE_SHA}"*) say "gate ok: smoke test → ${SMOKE}" ;;
  *) die 25 "gate: smoke sha '${SMOKE_SHA}' is not a prefix of deployed SHA '${SHA}' (output: ${SMOKE})" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  say "── dry-run: build + gates PASSED; stopping before touching the live tree ──"
  if [ "$KEEP_WT" -eq 1 ]; then
    say "keeping worktree at $WT (--keep-worktree)"
  else
    git -C "$REPO" worktree remove --force "$WT"
    say "worktree remove rc=$?"
  fi
  exit 0
fi

# ── phase 3: swap, with the gateway STOPPED ─────────────────────────────────
# Each step below is its own independently-checked command. Do NOT &&-chain
# them: a failed rename must never suppress a later step, and above all it
# must never suppress the unconditional restart in phase 4.
say "── phase 3: swap under a STOPPED gateway ──"
SWAP_FAIL=0

systemctl --user stop openclaw-gateway
say "systemctl stop rc=$?"
sleep 2
STOPPED_STATE="$(systemctl --user is-active openclaw-gateway 2>&1)"
say "gateway is-active after stop: ${STOPPED_STATE}"
if [ "$STOPPED_STATE" = "active" ]; then
  # Never move dist out from under a RUNNING gateway — that is the exact
  # crash this script exists to prevent. Aborting here is safe: the live
  # tree is untouched and the old build keeps serving.
  say "worktree left at $WT (remove: git -C $REPO worktree remove --force $WT)"
  die 26 "gateway is still active after stop — swap aborted, live tree untouched"
fi

if [ -d "${REPO}/dist" ]; then
  mv "${REPO}/dist" "${REPO}/dist.bak-${STAMP}"
  rc=$?
  say "live dist -> dist.bak-${STAMP} rc=${rc}"
  [ "$rc" -eq 0 ] || SWAP_FAIL=1
else
  say "no live dist/ to move aside"
fi

# Guard against nesting: if the live dir still exists (move-aside failed),
# `mv` would drop the new build INSIDE it as dist/dist. Skip instead.
if [ -e "${REPO}/dist" ]; then
  say "ERROR: live dist/ still present after move-aside — skipping swap-in to avoid nesting"
  SWAP_FAIL=1
else
  mv "${WT}/dist" "${REPO}/dist"
  rc=$?
  say "worktree dist -> live dist rc=${rc}"
  [ "$rc" -eq 0 ] || SWAP_FAIL=1
fi

if [ -d "${REPO}/dist-runtime" ]; then
  mv "${REPO}/dist-runtime" "${REPO}/dist-runtime.bak-${STAMP}"
  rc=$?
  say "live dist-runtime -> dist-runtime.bak-${STAMP} rc=${rc}"
  [ "$rc" -eq 0 ] || SWAP_FAIL=1
else
  say "no live dist-runtime/ to move aside"
fi

if [ -e "${REPO}/dist-runtime" ]; then
  say "ERROR: live dist-runtime/ still present after move-aside — skipping swap-in to avoid nesting"
  SWAP_FAIL=1
else
  mv "${WT}/dist-runtime" "${REPO}/dist-runtime"
  rc=$?
  say "worktree dist-runtime -> live dist-runtime rc=${rc}"
  [ "$rc" -eq 0 ] || SWAP_FAIL=1
fi

# dist.bak-<stamp>/ and dist-runtime.bak-<stamp>/ are FULL builds (~2 GB each).
# Left unpruned they fill the disk: on 2026-08-23 they had reached 135 dirs /
# 155 GB with the root filesystem at 97%. Keep the newest KEEP_BAKS of each and
# delete the rest. Only strictly auto-stamped names (bak-YYYYMMDD-HHMMSS) are
# eligible — hand-labelled rollback points (dist.bak-pre-eeg, dist.bak-mecha,
# dist.bak-20260728-effort, ...) are deliberate and never touched here.
KEEP_BAKS="${KEEP_BAKS:-3}"
for prefix in dist dist-runtime; do
  ls -d "${REPO}/${prefix}.bak-"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null \
    | sort | head -n "-${KEEP_BAKS}" | while IFS= read -r stale; do
      rm -rf -- "$stale" && say "pruned $(basename "$stale")"
    done
done

# ── phase 4: start, UNCONDITIONALLY ─────────────────────────────────────────
# Restart=no (no-restart.conf) means nothing else will ever bring the
# gateway back — so this phase runs no matter what happened above.
say "── phase 4: start gateway (UNCONDITIONAL) ──"
if [ -n "$NOTE" ]; then
  "${SCRIPT_DIR}/gateway-full-restart.sh" --note "$NOTE"
else
  "${SCRIPT_DIR}/gateway-full-restart.sh"
fi
say "gateway-full-restart.sh rc=$?"
sleep 3

ACTIVE="$(systemctl --user is-active openclaw-gateway 2>&1)"
MAINPID="$(systemctl --user show -p MainPID --value openclaw-gateway 2>/dev/null)"
LIVE_STAMP="$(cat "${REPO}/dist/.buildstamp" 2>/dev/null || echo '<missing>')"
say "gateway: is-active=${ACTIVE} MainPID=${MAINPID}"
say "live buildstamp: ${LIVE_STAMP}"

# ── phase 5: cleanup + verdict ──────────────────────────────────────────────
say "── phase 5: cleanup ──"
if [ "$KEEP_WT" -eq 1 ]; then
  say "keeping worktree at $WT (--keep-worktree)"
else
  # --force: the worktree is dirty by design (node_modules + dist moved out).
  git -C "$REPO" worktree remove --force "$WT"
  say "worktree remove rc=$?"
fi

if [ "$ACTIVE" != "active" ]; then
  die 40 "gateway is NOT active — intervene now (Restart=no will not recover it); previous build preserved at dist.bak-${STAMP}"
fi
if [ "$SWAP_FAIL" -ne 0 ]; then
  die 30 "gateway is active but one or more swap steps failed — inspect the log above"
fi
say "deploy complete: ${SHORT_SHA} is live (PID ${MAINPID})"
exit 0
