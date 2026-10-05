#!/bin/bash
# Retired 2026-09-10: Vite HMR on :18790 is no longer the operator UI.
# Production Tinker: http://127.0.0.1:18793/tinker/
echo "tinker-ui-dev.sh retired. Use production Tinker at http://127.0.0.1:18793/tinker/" >&2
echo "To evaluate a UI change: cd ~/src/tinkerclaw/tinker-ui && npx vite build" >&2
echo "Then reload the production tab. Restart tinker-prod-ui only if the proxy script or gateway token changed." >&2
exit 1
