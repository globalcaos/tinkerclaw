#!/usr/bin/env node
// Claude Code UserPromptSubmit hook: hand the agent THALAMUS's short list of enhancements (advice only).
//
// NOT INSTALLED BY THE THALAMUS BRANCH. Nothing points a live Claude Code settings file at this script; it is written,
// tested and shipped so that the architect can wire it. It talks to the gateway's loopback route with the token in
// `<dataDir>/endpoint.json`.
//
// FAIL OPEN, ALWAYS. Any problem (no endpoint file, gateway down, a late answer, bad JSON) prints nothing and exits 0,
// so the prompt goes through untouched. In shadow the route answers `{}` and this prints nothing either.
//
// Input (stdin): the hook JSON. Output (stdout): only when the route returned a note,
//   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = Number(process.env.THALAMUS_HOOK_TIMEOUT_MS ?? 1500);
const dataDir =
  process.env.THALAMUS_DATA_DIR ?? join(homedir(), ".openclaw", "data", "thalamus-v4");

async function main() {
  let hook;
  try {
    hook = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const prompt = typeof hook?.prompt === "string" ? hook.prompt : "";
  if (!prompt) return;
  let endpoint;
  try {
    endpoint = JSON.parse(readFileSync(join(dataDir, "endpoint.json"), "utf8"));
  } catch {
    return;
  }
  if (!(endpoint?.port > 0) || typeof endpoint?.token !== "string") return;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/plugins/thalamus/shortlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ prompt, session_id: hook.session_id ?? "" }),
      signal: ctl.signal,
    });
    if (!res.ok) return;
    const out = await res.json();
    if (typeof out?.additionalContext === "string" && out.additionalContext) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: out.additionalContext,
          },
        }),
      );
    }
  } catch {
    /* fail open */
  } finally {
    clearTimeout(timer);
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
