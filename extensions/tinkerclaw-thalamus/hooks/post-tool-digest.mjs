#!/usr/bin/env node
// Claude Code PostToolUse hook: replace a very long tool result with a short digest (design D3; paper 5.2).
//
// NOT INSTALLED BY THE THALAMUS BRANCH. Nothing points a live Claude Code settings file at this script; it is written and
// tested so that the architect can wire it, with a hook timeout longer than THALAMUS_DIGEST_TIMEOUT_MS plus a margin (the reader
// model is called from the gateway; the default allows it 20 s). It talks to the gateway's loopback route with the token
// in `<dataDir>/endpoint.json`, and names the chat by `TC_SESSION_KEY`, which the bridge sets in the worker's environment.
//
// SHAPE-PRESERVING. The CLI accepts `updatedToolOutput` only when it has the tool's own output shape and keeps the original
// otherwise. So the script never builds a shape: it clones `tool_response` and swaps the ONE largest string inside it for
// the digest, leaving every other field as the tool wrote it.
//
// FAIL OPEN, ALWAYS. No endpoint file, no session key, a short result, the gateway down or slow, a bad reply: print nothing
// and exit 0, and the model sees the tool's output exactly as before. In shadow the route answers `{}`.
//
// Input (stdin): the hook JSON. Output (stdout): only when the route returned a digest,
//   {"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":<tool_response with the digest in it>}}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = Number(process.env.THALAMUS_DIGEST_TIMEOUT_MS ?? 25000);
/** Below this many characters the route would not digest anyway (2000 tokens by default); skip the round trip. */
const MIN_CHARS = Number(process.env.THALAMUS_DIGEST_MIN_CHARS ?? 6000);
const dataDir =
  process.env.THALAMUS_DATA_DIR ?? join(homedir(), ".openclaw", "data", "thalamus-v4");

/** The path to the longest string inside `value`, or undefined when there is none. Strings only; arrays and objects walked. */
export function longestString(value, path = [], best = { path: undefined, len: 0 }) {
  if (typeof value === "string") {
    if (value.length > best.len) {
      best.path = path;
      best.len = value.length;
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => longestString(v, [...path, i], best));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) longestString(v, [...path, k], best);
  }
  return best;
}

export function replaceAt(value, path, text) {
  if (path.length === 0) return text;
  const clone = Array.isArray(value) ? [...value] : { ...value };
  clone[path[0]] = replaceAt(value[path[0]], path.slice(1), text);
  return clone;
}

async function main() {
  let hook;
  try {
    hook = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const sessionKey = process.env.TC_SESSION_KEY ?? "";
  const toolName = typeof hook?.tool_name === "string" ? hook.tool_name : "";
  const response = hook?.tool_response;
  if (!sessionKey || !toolName || response === undefined || response === null) return;
  const longest = longestString(response);
  if (longest.path === undefined || longest.len < MIN_CHARS) return;
  const text = (path) => path.reduce((v, k) => v[k], response);
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
    const res = await fetch(`http://127.0.0.1:${endpoint.port}/plugins/thalamus/digest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({
        tc_session_key: sessionKey,
        session_id: hook.session_id ?? "",
        tool_name: toolName,
        tool_use_id: typeof hook.tool_use_id === "string" ? hook.tool_use_id : "",
        text: text(longest.path),
      }),
      signal: ctl.signal,
    });
    if (!res.ok) return;
    const out = await res.json();
    if (typeof out?.text === "string" && out.text) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            updatedToolOutput: replaceAt(response, longest.path, out.text),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
