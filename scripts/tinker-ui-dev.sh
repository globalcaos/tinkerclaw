#!/bin/bash
# Start Tinker UI in dev mode with hot reload
# Changes to tinker-ui/src/ will instantly reflect without rebuild or refresh
# Access at: http://localhost:18790/tinker/
cd "$(dirname "$0")/../tinker-ui" && npx vite --port 18790
