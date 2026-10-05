#!/usr/bin/env node
/**
 * factorial-exec.mjs — Execute a Factorial GraphQL query via CDP
 *
 * Connects to the Chrome relay tab and runs a GraphQL query through the page context.
 * This bypasses httpOnly cookie restrictions by executing within the authenticated session.
 *
 * Usage:
 *   echo '{"query":"{ employees { employeesConnection(first:5) { nodes { id fullName } } } }"}' | node factorial-exec.mjs
 *   node factorial-exec.mjs '{ employees { employeesConnection(first:5) { nodes { id fullName } } } }'
 *
 * Requires: Chrome with OpenClaw browser relay, Factorial tab attached.
 * Connects to CDP at ws://127.0.0.1:18792/cdp (default relay port).
 */

import { readFileSync } from "fs";
import { WebSocket } from "node:net";

// NOTE: Node.js 22+ has WebSocket built-in via undici
const CDP_URL = process.env.FACTORIAL_CDP_URL || "ws://127.0.0.1:18792/cdp";
const GQL_ENDPOINT = "https://api.factorialhr.com/graphql";

async function main() {
  // Get query from argv or stdin
  let query;
  if (process.argv[2]) {
    query = process.argv[2];
    // If it looks like JSON, parse it
    try {
      const parsed = JSON.parse(query);
      query = parsed.query || query;
    } catch {}
  } else {
    const input = readFileSync("/dev/stdin", "utf8").trim();
    try {
      const parsed = JSON.parse(input);
      query = parsed.query || input;
    } catch {
      query = input;
    }
  }

  if (!query) {
    console.error('Usage: node factorial-exec.mjs "<graphql query>"');
    console.error('  or: echo \'{"query":"..."}\' | node factorial-exec.mjs');
    process.exit(1);
  }

  // Use global fetch to hit the OpenClaw browser relay's CDP HTTP API
  // Actually, simpler: use the evaluate approach via browser tool
  // But since this is a standalone script, we connect directly via CDP WebSocket

  // For simplicity and zero-dep, we'll use the HTTP endpoint approach
  // The agent should use browser(action=act, evaluate) instead.
  // This script is a fallback / reference implementation.

  console.error("⚠️  Direct CDP execution not implemented in standalone mode.");
  console.error("   Use the agent's browser tool with evaluate:");
  console.error("");
  console.error(`   browser(action=act, evaluate, fn: "async () => {`);
  console.error(`     const r = await fetch('${GQL_ENDPOINT}', {`);
  console.error(`       method: 'POST',`);
  console.error(`       headers: {'Content-Type': 'application/json'},`);
  console.error(`       credentials: 'include',`);
  console.error(`       body: JSON.stringify({query: \\\`${query.slice(0, 100)}...\\\`})`);
  console.error(`     });`);
  console.error(`     return await r.json();`);
  console.error(`   }")`);
  console.error("");
  console.error("   Or pipe through: factorial <cmd> | factorial-exec");

  // Output the query as a ready-to-use evaluate payload
  const evalFn = `async () => { const r = await fetch('${GQL_ENDPOINT}', { method: 'POST', headers: {'Content-Type': 'application/json'}, credentials: 'include', body: JSON.stringify({query: ${JSON.stringify(query)}}) }); return await r.json(); }`;

  console.log(JSON.stringify({ evaluateFn: evalFn, query }));
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
