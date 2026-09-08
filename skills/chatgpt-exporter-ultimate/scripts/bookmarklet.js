// ChatGPT Full Export Bookmarklet v2.1
// Exports your conversations — including the ones inside Projects (folders) — to a JSON
// file in your Downloads folder. Paste this entire script in the DevTools console while
// on chatgpt.com.
//
// WHAT IT TOUCHES: chatgpt.com's own API, same-origin, using the session your browser
// already has. It asks you three questions first: whether to export at all, whether to
// search Projects, and whether to include message text. Cancel any of them and it either
// stops or narrows the scope. Nothing is uploaded anywhere — the only output is the file
// your browser downloads.
//
// CREDENTIALS: it authenticates with your existing session cookie. It only reads a bearer
// token from /api/auth/session if the cookie call is rejected, and even then the token
// stays in this function's scope: never logged, never stored, never sent off-origin.
//
// OFF SWITCH: cancel the first dialog. Nothing is fetched and nothing is downloaded.

(async function () {
  console.log("🚀 ChatGPT Exporter v2.1 starting...");

  // ---------------------------------------------------------------- consent
  const proceed = confirm(
    "Export your ChatGPT history to a file in this browser's Downloads folder?\n\n" +
      "The file can contain the FULL text of every message in every conversation — " +
      "including anything sensitive you ever typed or pasted: passwords, API keys, " +
      "health, legal, financial or work-confidential material.\n\n" +
      "It is written in plaintext and is picked up by backups and sync clients like any " +
      "other download.\n\n" +
      "OK = continue.   Cancel = stop now, nothing is fetched.",
  );
  if (!proceed) {
    console.log("🛑 Aborted. Nothing was fetched and nothing was downloaded.");
    return;
  }

  const includeProjects = confirm(
    "Also find conversations inside Projects/folders?\n\n" +
      "These do not appear in the normal list, so the script runs ~65 short searches " +
      "against your history to surface them.\n\n" +
      "OK = include Projects (slower, more complete).   Cancel = main list only.",
  );

  const includeBodies = confirm(
    "Include the text of the messages?\n\n" +
      "OK = full export: every message, both sides.\n" +
      "Cancel = index only: titles, ids and timestamps, no message content.",
  );

  // ---------------------------------------------------------------- auth
  // Cookie-first. The token branch is a fallback and the value never leaves this scope.
  let headers = {};
  const probe = await fetch("/backend-api/conversations?offset=0&limit=1", {
    credentials: "include",
  });

  if (probe.status === 401 || probe.status === 403) {
    console.log("🔑 Session cookie was rejected — falling back to the session access token.");
    const sessionResp = await fetch("/api/auth/session", { credentials: "include" });
    const { accessToken } = await sessionResp.json();
    if (!accessToken) {
      alert("❌ Not logged in! Please log into ChatGPT first.");
      return;
    }
    headers = { Authorization: `Bearer ${accessToken}` };
  } else if (!probe.ok) {
    alert(`❌ ChatGPT API returned HTTP ${probe.status}. Try reloading chatgpt.com and re-running.`);
    return;
  }

  // Phase 1: Fetch conversation IDs from the main listing endpoint
  console.log("📋 Phase 1: Fetching main conversation list...");
  const allIds = new Map(); // id -> { title, create_time }
  let offset = 0;
  const limit = 100;

  while (true) {
    const resp = await fetch(`/backend-api/conversations?offset=${offset}&limit=${limit}`, {
      headers,
      credentials: "include",
    });
    const data = await resp.json();
    for (const item of data.items) {
      allIds.set(item.id, { title: item.title, create_time: item.create_time });
    }
    console.log(`   Listed ${allIds.size} conversations...`);
    if (data.items.length < limit) break;
    offset += limit;
    await new Promise((r) => setTimeout(r, 200));
  }

  const listedCount = allIds.size;
  console.log(`📊 Main listing: ${listedCount} conversations`);

  // Phase 2: Search-based discovery to find conversations inside Projects/folders.
  // Skipped entirely unless the user opted in above.
  console.log(
    includeProjects
      ? "🔍 Phase 2: Searching for conversations in Projects..."
      : "⏭️  Phase 2 skipped — Projects search declined.",
  );
  const searchTerms = [
    // Common words in multiple languages to maximize coverage
    "a",
    "e",
    "i",
    "o",
    "u",
    "el",
    "la",
    "de",
    "que",
    "per",
    "com",
    "en",
    "es",
    "un",
    "una",
    "the",
    "is",
    "to",
    "and",
    "for",
    "how",
    "what",
    "can",
    "my",
    "new",
    "AI",
    "code",
    "python",
    "help",
    "project",
    "plan",
    "mail",
    "work",
    "home",
    "casa",
    "buy",
    "water",
    "make",
    "create",
    "fix",
    "error",
    "list",
    "write",
    "find",
    "get",
    "set",
    "add",
    "use",
    "run",
    "file",
    "data",
    "test",
    "build",
    "open",
    "send",
    "read",
    "show",
    "app",
    "web",
    "api",
    "key",
    "log",
    "config",
    "install",
    "update",
  ];

  for (const term of includeProjects ? searchTerms : []) {
    try {
      const resp = await fetch(
        `/backend-api/conversations/search?query=${encodeURIComponent(term)}&limit=50`,
        { headers, credentials: "include" },
      );
      const data = await resp.json();
      for (const item of data.items || []) {
        if (!allIds.has(item.conversation_id)) {
          allIds.set(item.conversation_id, {
            title: item.title,
            create_time: null, // will be filled when fetching full conversation
            source: "project",
          });
        }
      }
    } catch (e) {
      // search term returned error, skip
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const projectCount = allIds.size - listedCount;
  console.log(`🔍 Found ${projectCount} additional conversations in Projects`);
  console.log(`📊 Total: ${allIds.size} conversations`);

  // Phase 3: Fetch each conversation's full content.
  // Skipped entirely when the user chose an index-only export — in that case no message
  // body is ever fetched, so none can end up in the file.
  const results = [];
  const errors = [];
  let idx = 0;
  const total = allIds.size;

  if (!includeBodies) {
    console.log("⏭️  Phase 3 skipped — index-only export (no message content).");
    for (const [convId, meta] of allIds) {
      results.push({
        id: convId,
        title: meta.title || "Untitled",
        created: meta.create_time,
        source: meta.source || "list",
      });
    }
  }

  if (includeBodies) {
    console.log("📥 Phase 3: Fetching full conversations...");
  }

  for (const [convId, meta] of includeBodies ? allIds : []) {
    idx++;
    const progress = `[${idx}/${total}]`;

    try {
      const resp = await fetch(`/backend-api/conversation/${convId}`, {
        headers,
        credentials: "include",
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();

      // Extract messages from mapping tree
      const messages = [];
      for (const node of Object.values(data.mapping || {})) {
        if (node.message?.content?.parts && node.message.author?.role !== "system") {
          const textParts = node.message.content.parts.filter((p) => typeof p === "string");
          if (textParts.length > 0) {
            messages.push({
              role: node.message.author.role,
              text: textParts.join("\n"),
              time: node.message.create_time || 0,
            });
          }
        }
      }
      messages.sort((a, b) => a.time - b.time);

      results.push({
        id: convId,
        title: data.title || meta.title || "Untitled",
        created: data.create_time,
        updated: data.update_time,
        gizmo_id: data.gizmo_id || null,
        messages,
      });

      console.log(`✅ ${progress} ${data.title || "Untitled"}`);
    } catch (e) {
      console.error(`❌ ${progress} Error: ${e.message}`);
      errors.push({ id: convId, title: meta.title, error: e.message });
    }

    // Rate limiting
    if (idx < total) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Create download
  console.log("📦 Creating download...");

  const exportData = {
    exported: new Date().toISOString(),
    exporter_version: "2.1",
    scope: {
      projects_searched: includeProjects,
      message_bodies_included: includeBodies,
    },
    total: allIds.size,
    listed: listedCount,
    from_projects: projectCount,
    successful: results.length,
    errors: errors.length,
    conversations: results,
    failedConversations: errors,
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `chatgpt-export-${new Date().toISOString().split("T")[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log("");
  console.log("🎉 Export complete!");
  console.log(`   📋 Listed: ${listedCount}`);
  console.log(`   🔍 From Projects: ${projectCount}`);
  console.log(`   ✅ Exported: ${results.length}`);
  console.log(`   ❌ Errors: ${errors.length}`);
  console.log("   📁 Check your Downloads folder");

  alert(
    `✅ Export complete!\n\nListed: ${listedCount}\nFrom Projects: ${projectCount}\nExported: ${results.length}\nErrors: ${errors.length}\n\n` +
      `Saved to your Downloads folder as a plaintext JSON file` +
      (includeBodies ? " containing full message text." : " containing titles and metadata only.") +
      `\n\nKeep it out of synced folders and delete it when you are done with it.`,
  );
})();
