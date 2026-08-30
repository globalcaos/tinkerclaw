#!/usr/bin/env bash
#
# build-whatsmeow-node.sh — rebuild the whatsmeow Go binary against a CURRENT
# go.mau.fi/whatsmeow, and install it where the WhatsApp channel will pick it up.
#
# WHY THIS EXISTS
#   WhatsApp enforces a minimum client version and raises it periodically. It did
#   so around 2026-07-29 and our channel died for a month. The symptom is NOT
#   obvious: whatsmeow answers `getQRChannel` with
#       {"event":"qr:error","data":{"event":"err-client-outdated"}}
#   and the channel reports a generic connection failure. WhatsApp refuses to
#   issue a pairing QR at all, so RELINKING CANNOT FIX IT.
#
#   Upgrading the npm package does not help either: every published
#   @whatsmeow-node release (0.5.3 .. 0.7.0) embeds the same Go library,
#   `whatsmeowVersion 0.0.0-20260305`. Only a rebuild moves the protocol code.
#
# HOW TO TELL IT IS TIME TO RUN THIS
#   Run the fresh-store probe (never the live credentials dir):
#     node scripts/whatsmeow-selftest.mjs
#   `err-client-outdated` means run this script.
#
# The binary is installed OUTSIDE node_modules on purpose: deploys build in a
# clean worktree where `pnpm install` would restore the stale vendored binary.
# The channel picks it up via OPENCLAW_WHATSMEOW_BINARY (see session-wm.ts).
set -euo pipefail

UPSTREAM="${WHATSMEOW_NODE_REPO:-https://github.com/nicastelo/whatsmeow-node.git}"
DEST="${OPENCLAW_WHATSMEOW_BINARY:-$HOME/.openclaw/bin/whatsmeow-node}"
WORK="$(mktemp -d /tmp/whatsmeow-node-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

command -v go >/dev/null 2>&1 || { echo "FATAL: go toolchain not found" >&2; exit 3; }
echo "[build] go: $(go version)"

echo "[build] cloning $UPSTREAM"
git clone --depth 20 "$UPSTREAM" "$WORK/src" >/dev/null 2>&1

cd "$WORK/src"
echo "[build] pinning go.mau.fi/whatsmeow@latest"
GOFLAGS=-mod=mod go get go.mau.fi/whatsmeow@latest
PINNED="$(grep -E '^\s*go\.mau\.fi/whatsmeow ' go.mod | awk '{print $2}')"
echo "[build] whatsmeow -> $PINNED"

# Upstream lags the whatsmeow API. Known drift, re-check on each rebuild:
#   2026-08: SetStatusMessage(ctx, string) -> SetStatusMessage(ctx, types.SetStatusInput)
if grep -q 'SetStatusMessage(a.ctx, args.Message)' cmd/whatsmeow-node/commands_extra.go 2>/dev/null; then
  echo "[build] patching SetStatusMessage for the types.SetStatusInput signature"
  sed -i 's/SetStatusMessage(a\.ctx, args\.Message)/SetStatusMessage(a.ctx, types.SetStatusInput{Text: \&args.Message})/' \
    cmd/whatsmeow-node/commands_extra.go
fi

echo "[build] building"
GOFLAGS=-mod=mod go build -o "$WORK/whatsmeow-node" ./cmd/whatsmeow-node

mkdir -p "$(dirname "$DEST")"
# Never overwrite a running binary in place: unlink then move, so any live
# process keeps its own inode and exits cleanly on the next restart.
rm -f "$DEST.new"
cp "$WORK/whatsmeow-node" "$DEST.new"
chmod 755 "$DEST.new"
mv -f "$DEST.new" "$DEST"

echo "[build] installed: $DEST"
ls -la "$DEST"
echo
echo "Next:"
echo "  1. export OPENCLAW_WHATSMEOW_BINARY=$DEST  (systemd drop-in for the gateway)"
echo "  2. node scripts/whatsmeow-selftest.mjs     (expect: QR RECEIVED)"
echo "  3. restart the gateway, then relink from the channels tab"
