# Amygdala UI browser checks

Design doc §9, Phase F. Nothing here talks to a real gateway.

1. Build: `cd tinker-ui && npx vite build` (fills `dist/`).
2. Start the mock: `node mock-gateway.mjs --port 18995 --dist ../../dist`.
3. Drive every state and write screenshots: `node drive.mjs --url http://127.0.0.1:18995 --out /tmp/amy-e2e/screens`.
   Exit code 1 if an assertion fails.
4. Inert check (a gateway without the plugin must look like develop): build develop's base commit into another dist,
   serve it with a second mock on 18996, then `node inert-compare.mjs --ours http://127.0.0.1:18995 --base http://127.0.0.1:18996`.
   The only allowed difference is the empty `#amy-dot-host` span in the composer.
