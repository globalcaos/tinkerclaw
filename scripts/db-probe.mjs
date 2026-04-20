import Database from "better-sqlite3";

const db = new Database("/home/<user>/.openclaw/data/anatomy-timeline.db", { readonly: true });

console.log("=== TABLE COUNT ===", db.prepare("SELECT COUNT(*) as n FROM anatomy_events").get());

console.log("\n=== BY PROVIDER ===");
for (const r of db
  .prepare("SELECT provider, COUNT(*) as n FROM anatomy_events GROUP BY provider ORDER BY n DESC")
  .all()) {
  console.log(r.provider ?? "(null)", r.n);
}

console.log("\n=== RECENT (last 15, any provider) ===");
const recent = db
  .prepare(`
  SELECT session_key, turn, provider, model, datetime(timestamp_ms/1000, 'unixepoch', 'localtime') as ts,
         duration_ms, stop_reason, response_tokens, response_thinking_tokens, response_text_tokens, response_tool_call_tokens,
         LENGTH(user_message) as um_len, LENGTH(assistant_response) as ar_len,
         LENGTH(context_sent) as cs_len, LENGTH(response_content) as rc_len
  FROM anatomy_events ORDER BY id DESC LIMIT 15
`)
  .all();
for (const r of recent) {
  console.log(JSON.stringify(r));
}

console.log("\n=== CC-BRIDGE LAST 5 ===");
const cc = db
  .prepare(`
  SELECT * FROM anatomy_events WHERE provider = 'claude-code' ORDER BY id DESC LIMIT 5
`)
  .all();
for (const r of cc) {
  const s = {
    id: r.id,
    ts: new Date(r.timestamp_ms).toLocaleString(),
    session_key: r.session_key,
    turn: r.turn,
    round_number: r.round_number,
    run_id: r.run_id,
    provider: r.provider,
    model: r.model,
    auth_profile_id: r.auth_profile_id,
    duration_ms: r.duration_ms,
    stop_reason: r.stop_reason,
    tokens: {
      total: r.response_tokens,
      think: r.response_thinking_tokens,
      text: r.response_text_tokens,
      tool: r.response_tool_call_tokens,
    },
    cache: { read: r.cache_read_tokens, create: r.cache_creation_tokens },
    has: {
      user_message: Boolean(r.user_message),
      assistant_response: Boolean(r.assistant_response),
      context_sent: Boolean(r.context_sent),
      response_content: Boolean(r.response_content),
    },
    len: {
      um: r.user_message?.length ?? 0,
      ar: r.assistant_response?.length ?? 0,
      cs: r.context_sent?.length ?? 0,
      rc: r.response_content?.length ?? 0,
    },
    user_preview: (r.user_message ?? "").slice(0, 80),
    resp_preview: (r.assistant_response ?? "").slice(0, 120),
  };
  console.log(JSON.stringify(s, null, 2));
}

console.log("\n=== NON-CC-BRIDGE RECENT 3 (for comparison) ===");
const other = db
  .prepare(`
  SELECT * FROM anatomy_events WHERE provider != 'claude-code' OR provider IS NULL ORDER BY id DESC LIMIT 3
`)
  .all();
for (const r of other) {
  const s = {
    id: r.id,
    ts: new Date(r.timestamp_ms).toLocaleString(),
    provider: r.provider,
    model: r.model,
    tokens: {
      total: r.response_tokens,
      think: r.response_thinking_tokens,
      text: r.response_text_tokens,
    },
    len: {
      um: r.user_message?.length ?? 0,
      ar: r.assistant_response?.length ?? 0,
      cs: r.context_sent?.length ?? 0,
      rc: r.response_content?.length ?? 0,
    },
    user_preview: (r.user_message ?? "").slice(0, 80),
  };
  console.log(JSON.stringify(s));
}
