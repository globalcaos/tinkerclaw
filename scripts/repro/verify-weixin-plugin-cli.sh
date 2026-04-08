#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
DEFAULT_ROOT="/tmp/openclaw-weixin-cli-repro"
if [[ -d /data/tmp || -w /data ]]; then
  DEFAULT_ROOT="/data/tmp/openclaw-weixin-cli-repro"
fi

STATE_ROOT="${OPENCLAW_WEIXIN_REPRO_ROOT:-$DEFAULT_ROOT}"
PLUGIN_SPEC="${OPENCLAW_WEIXIN_PLUGIN_SPEC:-@tencent-weixin/openclaw-weixin@2.1.7}"
PLUGIN_TGZ=""
PAIRING_CHANNEL="feishu"
PAIRING_CODE="BAH8YVB3"
CHANNEL_ID="openclaw-weixin"
TIMEOUT_ONBOARD=30
TIMEOUT_PAIRING=30
TIMEOUT_LOGIN=30
SKIP_BUILD=0

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/repro/verify-weixin-plugin-cli.sh [options]

Options:
  --repo <path>             Repo/worktree to validate. Default: current repo root.
  --state-root <path>       Temp run root. Default: /data/tmp/openclaw-weixin-cli-repro when available, else /tmp/openclaw-weixin-cli-repro.
  --plugin-spec <spec>      npm spec for the plugin. Default: @tencent-weixin/openclaw-weixin@2.1.7
  --plugin-tgz <path>       Use a local plugin tarball instead of npm pack.
  --pairing-channel <id>    Pairing channel for the approve smoke. Default: feishu
  --pairing-code <code>     Pairing code for the approve smoke. Default: BAH8YVB3
  --channel-id <id>         Channel id for login smoke. Default: openclaw-weixin
  --timeout-onboard <sec>   Timeout for onboard smoke. Default: 30
  --timeout-pairing <sec>   Timeout for pairing smoke. Default: 30
  --timeout-login <sec>     Timeout for channel login smoke. Default: 30
  --skip-build              Skip `pnpm build` before running probes.
  -h, --help                Show this help.

Examples:
  bash scripts/repro/verify-weixin-plugin-cli.sh
  bash scripts/repro/verify-weixin-plugin-cli.sh --repo /data/worktrees/openclaw-main-weixin-repro --skip-build
  bash scripts/repro/verify-weixin-plugin-cli.sh --plugin-spec @tencent-weixin/openclaw-weixin@2.1.7
  bash scripts/repro/verify-weixin-plugin-cli.sh --plugin-tgz /tmp/openclaw-weixin-bad.tgz
USAGE
}

log() {
  local level="$1"
  shift
  printf '[weixin-repro][%s] %s\n' "$level" "$*"
}

fail() {
  log ERROR "$*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_ROOT="$2"
      shift 2
      ;;
    --state-root)
      STATE_ROOT="$2"
      shift 2
      ;;
    --plugin-spec)
      PLUGIN_SPEC="$2"
      shift 2
      ;;
    --plugin-tgz)
      PLUGIN_TGZ="$2"
      shift 2
      ;;
    --pairing-channel)
      PAIRING_CHANNEL="$2"
      shift 2
      ;;
    --pairing-code)
      PAIRING_CODE="$2"
      shift 2
      ;;
    --channel-id)
      CHANNEL_ID="$2"
      shift 2
      ;;
    --timeout-onboard)
      TIMEOUT_ONBOARD="$2"
      shift 2
      ;;
    --timeout-pairing)
      TIMEOUT_PAIRING="$2"
      shift 2
      ;;
    --timeout-login)
      TIMEOUT_LOGIN="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

require_cmd npm
require_cmd pnpm
require_cmd rg
require_cmd script
require_cmd tar
require_cmd timeout

[[ -d "$REPO_ROOT" ]] || fail "repo not found: $REPO_ROOT"
[[ -f "$REPO_ROOT/package.json" ]] || fail "repo package.json not found: $REPO_ROOT/package.json"
if [[ -n "$PLUGIN_TGZ" && ! -f "$PLUGIN_TGZ" ]]; then
  fail "plugin tarball not found: $PLUGIN_TGZ"
fi

RUN_ID="$(basename "$REPO_ROOT")-$(date +%Y%m%d-%H%M%S)"
RUN_ROOT="$STATE_ROOT/$RUN_ID"
STATE_DIR="$RUN_ROOT/state"
PKG_DIR="$RUN_ROOT/pkg"
PLUGIN_DIR="$STATE_DIR/extensions/openclaw-weixin"
CONFIG_PATH="$STATE_DIR/openclaw.json"

mkdir -p "$RUN_ROOT" "$STATE_DIR" "$PKG_DIR" "$PLUGIN_DIR"

log INFO "repo=$REPO_ROOT"
log INFO "run_root=$RUN_ROOT"
if [[ -n "$PLUGIN_TGZ" ]]; then
  log INFO "plugin_source=tarball:$PLUGIN_TGZ"
else
  log INFO "plugin_spec=$PLUGIN_SPEC"
fi

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  log INFO "node_modules missing; running pnpm install"
  (cd "$REPO_ROOT" && pnpm install)
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log INFO "running pnpm build"
  (cd "$REPO_ROOT" && pnpm build)
else
  log INFO "skipping pnpm build"
fi

if [[ -n "$PLUGIN_TGZ" ]]; then
  log INFO "using plugin tarball: $PLUGIN_TGZ"
  tar -xzf "$PLUGIN_TGZ" -C "$PLUGIN_DIR" --strip-components=1
else
  log INFO "packing plugin via npm: $PLUGIN_SPEC"
  (cd "$PKG_DIR" && npm pack "$PLUGIN_SPEC" >/dev/null)
  PACKED_TGZ="$(find "$PKG_DIR" -maxdepth 1 -type f -name '*.tgz' | sort | tail -n 1)"
  [[ -n "$PACKED_TGZ" ]] || fail "npm pack did not produce a tarball"
  tar -xzf "$PACKED_TGZ" -C "$PLUGIN_DIR" --strip-components=1
fi

log INFO "installing plugin runtime dependencies"
(cd "$PLUGIN_DIR" && npm install --omit=dev)

if ! rg -n 'openclaw/plugin-sdk/command-auth' "$PLUGIN_DIR" >/dev/null; then
  fail "plugin does not import openclaw/plugin-sdk/command-auth; check the plugin version"
fi

cat > "$CONFIG_PATH" <<CONFIG
{
  "plugins": {
    "load": {
      "paths": ["$PLUGIN_DIR"]
    }
  }
}
CONFIG

COMMON_BAD_PATTERN='Maximum call stack size exceeded|Failed to read config.*RangeError|failed to load .*Maximum call stack size exceeded'

run_probe() {
  local name="$1"
  local timeout_secs="$2"
  local expected_status="$3"
  local required_pattern="$4"
  local fallback_pattern="$5"
  shift 5
  local logfile="$RUN_ROOT/${name}.log"
  local rendered_cmd
  rendered_cmd="$(printf '%q ' "$@")"

  log INFO "probe=$name timeout=${timeout_secs}s"
  set +e
  (
    cd "$REPO_ROOT"
    env \
      OPENCLAW_STATE_DIR="$STATE_DIR" \
      OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE=1 \
      OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE=1 \
      script -q -e -c "$rendered_cmd" /dev/null
  ) >"$logfile" 2>&1
  local status=$?
  set -e

  log INFO "probe=$name exit=$status log=$logfile"

  if rg -n "$COMMON_BAD_PATTERN" "$logfile" >/dev/null; then
    sed -n '1,220p' "$logfile"
    fail "probe '$name' hit the recursion/stack-overflow signature"
  fi

  if ! rg -n "$required_pattern" "$logfile" >/dev/null; then
    if [[ -n "$fallback_pattern" ]] && rg -n "$fallback_pattern" "$logfile" >/dev/null; then
      :
    else
      sed -n '1,220p' "$logfile"
      fail "probe '$name' did not emit the expected success/fallback markers"
    fi
  fi

  case "$expected_status" in
    zero-or-timeout)
      if [[ "$status" -ne 0 && "$status" -ne 124 && "$status" -ne 143 ]]; then
        sed -n '1,220p' "$logfile"
        fail "probe '$name' expected exit 0, 124, or 143, got $status"
      fi
      ;;
    one)
      if [[ "$status" -ne 1 ]]; then
        sed -n '1,220p' "$logfile"
        fail "probe '$name' expected exit 1, got $status"
      fi
      ;;
    one-or-timeout)
      if [[ "$status" -ne 1 && "$status" -ne 124 && "$status" -ne 143 ]]; then
        sed -n '1,220p' "$logfile"
        fail "probe '$name' expected exit 1, 124, or 143, got $status"
      fi
      ;;
    *)
      fail "internal error: unknown expected status policy '$expected_status'"
      ;;
  esac
}

run_probe \
  onboard \
  "$TIMEOUT_ONBOARD" \
  zero-or-timeout \
  'OpenClaw setup|Security warning|I understand this is personal-by-default' \
  'node scripts/run-node\.mjs onboard|OpenClaw' \
  timeout "${TIMEOUT_ONBOARD}s" pnpm openclaw onboard

run_probe \
  pairing_approve \
  "$TIMEOUT_PAIRING" \
  one-or-timeout \
  "No pending pairing request found for code: ${PAIRING_CODE}" \
  'node scripts/run-node\.mjs pairing approve|OpenClaw' \
  timeout "${TIMEOUT_PAIRING}s" pnpm openclaw pairing approve "$PAIRING_CHANNEL" "$PAIRING_CODE"

run_probe \
  channels_login \
  "$TIMEOUT_LOGIN" \
  zero-or-timeout \
  '正在启动微信扫码登录|使用微信扫描以下二维码|如果二维码未能成功展示|等待连接结果|Gateway online' \
  'node scripts/run-node\.mjs channels login --channel|OpenClaw' \
  timeout "${TIMEOUT_LOGIN}s" pnpm openclaw channels login --channel "$CHANNEL_ID"

log INFO "all probes passed"
log INFO "artifacts kept under: $RUN_ROOT"
