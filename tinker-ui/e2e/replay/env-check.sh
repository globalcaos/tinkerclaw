#!/bin/bash
# Where the harness's node modules and the headless browser come from (read-only).
W="${HARNESS_WORKTREE:-$(cd "$(dirname "$0")/../../.." && pwd)}"
ls -ld "$W/node_modules" "$W/tinker-ui/node_modules" 2>&1
for m in playwright playwright-core ws vite; do
  printf '== %s: ' "$m"
  node -e "try{console.log(require.resolve(process.argv[1]+'/package.json',{paths:[process.argv[2],process.argv[2]+'/tinker-ui']}))}catch(e){console.log('NOT FOUND')}" "$m" "$W"
done
echo "== browsers"
ls ~/.cache/ms-playwright 2>&1
echo "== node"
node --version
