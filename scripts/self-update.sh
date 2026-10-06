#!/usr/bin/env bash
# Self-update from the published repository: the ONLY way a deployed machine receives code.
#
# WHAT IT IS FOR: a machine that runs TinkerClaw from a git checkout (a company agent, a clone) updates
# itself from what is PUBLISHED, never from files copied onto it by hand. Owner's rule (2026-10-06):
# "nothing goes to the agent directly ... sanitize, publish in github, then git pull from the server."
# HOW IT WAS DERIVED: the per-machine update and swap scripts that had been written straight onto one
# deployment (fresh clone beside the live tree, private extras carried over, build, wait for idle,
# swap with health check and automatic rollback), made generic and committed.
# WHAT WOULD CHANGE IT: a packaged release channel (then this becomes "install version X").
#
# Usage (on the machine, from its live checkout):
#   bash scripts/self-update.sh [--branch develop] [--idle-min 3] [--max-wait-min 45] [--build-only]
# Env:
#   SELF_UPDATE_TREE        live checkout (default: this repo's root)
#   SELF_UPDATE_EXTRAS      file listing private, never-published paths to carry into the new tree,
#                           one path relative to the repo root per line (default ~/.openclaw/self-update.extras)
#   SELF_UPDATE_PROBE_MODEL optional model id for a reply probe after the swap (no probe when empty)
#   SELF_UPDATE_UNIT        gateway systemd user unit (default openclaw-gateway)
# Progress: one line per step on stdout; ~/.self-update.progress holds "<step> <total>".
set -uo pipefail

BRANCH=develop; IDLE_MIN=3; MAX_WAIT_MIN=45; BUILD_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --idle-min) IDLE_MIN="$2"; shift 2 ;;
    --max-wait-min) MAX_WAIT_MIN="$2"; shift 2 ;;
    --build-only) BUILD_ONLY=1; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done

# Node from PATH, else the newest nvm install (systemd and ssh shells often lack nvm's PATH).
if ! command -v node >/dev/null 2>&1; then
  NVM_NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)
  [ -n "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
fi
export PATH="$HOME/.local/bin:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
command -v node >/dev/null || { echo "node not found"; exit 2; }
command -v pnpm >/dev/null || { echo "pnpm not found"; exit 2; }

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TREE="${SELF_UPDATE_TREE:-$HERE}"
NEXT="$TREE-next"
PREV="$TREE-prev-$(date +%Y%m%d%H%M%S)"
EXTRAS="${SELF_UPDATE_EXTRAS:-$HOME/.openclaw/self-update.extras}"
UNIT="${SELF_UPDATE_UNIT:-openclaw-gateway}"
PROGRESS="$HOME/.self-update.progress"
TOTAL=7
step() { echo "$1 $TOTAL" > "$PROGRESS"; echo "[self-update $(date +%T)] $2"; }

step 1 "fresh clone of the published $BRANCH beside the live tree"
ORIGIN=$(git -C "$TREE" remote get-url origin) || { echo "no origin in $TREE"; exit 2; }
[ -e "$NEXT" ] && mv "$NEXT" "$NEXT.stale-$(date +%Y%m%d%H%M%S)"
git clone -q --no-checkout "$TREE" "$NEXT" || exit 2
cd "$NEXT" || exit 2
git remote set-url origin "$ORIGIN" && git fetch -q origin "$BRANCH" || exit 2
if [ -f "$TREE/.git/info/sparse-checkout" ] && [ "$(git -C "$TREE" config core.sparseCheckout)" = true ]; then
  git config core.sparseCheckout true
  git config core.sparseCheckoutCone "$(git -C "$TREE" config core.sparseCheckoutCone || echo false)"
  cp "$TREE/.git/info/sparse-checkout" .git/info/sparse-checkout
fi
git checkout -q -B "$BRANCH" "origin/$BRANCH" || exit 2
git branch -q --set-upstream-to="origin/$BRANCH" "$BRANCH"
echo "  at $(git log -1 --format='%h %s' | cut -c1-90)"

step 2 "carry this machine's private extras"
if [ -f "$EXTRAS" ]; then
  while IFS= read -r rel; do
    rel="${rel%%#*}"; rel="$(echo "$rel" | xargs)"
    [ -z "$rel" ] && continue
    case "$rel" in /*|*..*) echo "  skipped unsafe path: $rel"; continue ;; esac
    if [ -e "$TREE/$rel" ]; then
      mkdir -p "$(dirname "$NEXT/$rel")" && cp -a "$TREE/$rel" "$(dirname "$NEXT/$rel")/" && echo "  carried $rel"
    fi
  done < "$EXTRAS"
else
  echo "  none listed ($EXTRAS absent)"
fi

step 3 "install dependencies"
pnpm install --frozen-lockfile > "$HOME/.self-update-install.log" 2>&1 || { tail -5 "$HOME/.self-update-install.log"; exit 3; }
step 4 "build the gateway"
pnpm build > "$HOME/.self-update-build.log" 2>&1 || { tail -8 "$HOME/.self-update-build.log"; exit 3; }
step 5 "build the Tinker UI"
pnpm --filter tinker-ui build > "$HOME/.self-update-ui.log" 2>&1 || { tail -8 "$HOME/.self-update-ui.log"; exit 3; }
node dist/index.js --version >/dev/null && [ -f tinker-ui/dist/index.html ] || exit 3
[ "$BUILD_ONLY" = 1 ] && { echo "BUILD_ONLY: ready in $NEXT, live tree untouched"; exit 0; }

step 6 "wait until nobody has used the agent for ${IDLE_MIN} minutes (at most ${MAX_WAIT_MIN})"
age=0
for _ in $(seq 1 $(( MAX_WAIT_MIN * 6 ))); do
  last=$(ls -t "$HOME"/.openclaw/agents/*/sessions/*.jsonl 2>/dev/null | head -1)
  age=$(( $(date +%s) - $(stat -c %Y "$last" 2>/dev/null || date +%s) ))
  [ "$age" -ge $(( IDLE_MIN * 60 )) ] && break
  sleep 10
done
echo "  idle for ${age}s"
[ "$age" -ge $(( IDLE_MIN * 60 )) ] || { echo "still in use: build ready in $NEXT, swap NOT done"; exit 4; }

step 7 "swap, health check, automatic rollback"
PORT=$(node -e 'try{const c=require(process.env.HOME+"/.openclaw/openclaw.json");console.log(c.gateway?.port??18789)}catch{console.log(18789)}')
rollback() {
  echo "[self-update] ROLLBACK: $1"
  systemctl --user stop "$UNIT"
  mv "$TREE" "$NEXT.failed-$(date +%Y%m%d%H%M%S)" && mv "$PREV" "$TREE"
  systemctl --user start "$UNIT"
  systemctl --user try-restart hive-door.service 2>/dev/null || true
  echo "[self-update] rolled back to $(git -C "$TREE" log -1 --format=%h)"
  exit 5
}
OLDPID=$(systemctl --user show "$UNIT" -p MainPID --value)
systemctl --user stop "$UNIT"
for u in $(systemctl --user list-units "tinkerclaw-worker-${OLDPID}-*" --no-legend --plain --all 2>/dev/null | grep -oE 'tinkerclaw-worker-[A-Za-z0-9_-]+\.service' | sort -u); do
  systemctl --user stop "$u"
done
mv "$TREE" "$PREV" && mv "$NEXT" "$TREE" || { echo "swap failed"; exit 3; }
cd "$TREE" || rollback "cd"
node dist/index.js config validate >/dev/null 2>&1 || rollback "config invalid"
systemctl --user start "$UNIT"
for _ in $(seq 1 90); do
  ss -ltn | grep -q ":$PORT " && journalctl --user -u "$UNIT" --since "-4min" --no-pager | grep -q "\[gateway\] ready" && break
  sleep 2
done
ss -ltn | grep -q ":$PORT " || rollback "gateway not listening on $PORT"
# The multi-user door (if installed) runs from this tree: restart it onto the new code.
systemctl --user try-restart hive-door.service 2>/dev/null || true
echo "  gateway ready: $(git log -1 --format=%h)"

if [ -n "${SELF_UPDATE_PROBE_MODEL:-}" ]; then
  K="agent:main:explicit:health-self-update-$(date +%s)"
  P=$(printf '{"sessionKey":"%s","message":"Health check after an update. Reply with exactly: DEPLOY_OK","model":"%s","idempotencyKey":"%s"}' "$K" "$SELF_UPDATE_PROBE_MODEL" "$K")
  for try in 1 2 3 4 5; do
    timeout 60 node "$PREV/dist/index.js" gateway call chat.send --timeout 50000 --params "$P" > /tmp/self-update-send.log 2>&1 && break
    echo "  probe send $try failed: $(tail -1 /tmp/self-update-send.log | cut -c1-100)"; sleep 15
  done
  OK=""
  for _ in $(seq 1 36); do
    OK=$(K="$K" node -e '
      const fs=require("fs"),os=require("os");
      try{const st=JSON.parse(fs.readFileSync(os.homedir()+"/.openclaw/agents/main/sessions/sessions.json","utf8"));
      const e=st[process.env.K]; if(e&&fs.existsSync(e.sessionFile)){for(const l of fs.readFileSync(e.sessionFile,"utf8").split("\n")){
      try{const o=JSON.parse(l);const c=o?.message?.content;const t=typeof c==="string"?c:(Array.isArray(c)?c.map(x=>x?.text??"").join(" "):"");
      if(o.type==="message"&&o.message.role==="assistant"&&t.includes("DEPLOY_OK")){console.log("yes");break}}catch{}}}}catch{}')
    [ "$OK" = yes ] && break
    sleep 5
  done
  [ "$OK" = yes ] || rollback "model probe got no DEPLOY_OK in 180s"
  echo "  model probe: DEPLOY_OK"
fi
echo "SELF_UPDATE_OK $(git log -1 --format='%h %s' | cut -c1-80) (previous tree kept at $PREV)"
