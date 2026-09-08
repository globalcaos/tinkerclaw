/**
 * ChatGPT Conversation Exporter — browser-relay path (recommended)
 *
 * Fetches conversations from ChatGPT's internal API through an attached browser relay,
 * using the session your browser already holds. It reads no token, no cookie jar and no
 * credential file: every request runs inside the page with `credentials: 'include'`.
 *
 * WRITES TO DISK: index.json, summary.md, and (unless indexOnly) one .json and one .md per
 * conversation containing full message text. The output directory is created mode 0700 and
 * every file mode 0600. Nothing is uploaded anywhere.
 *
 * CONSENT: exportChatGPTConversations() refuses to run unless the caller passes
 * `confirmed: true`. An agent must ask the user first — this is the gate that stops a
 * skill install from turning into an unattended dump of someone's chat history.
 *
 * OFF SWITCH: set CHATGPT_EXPORT_DISABLE=1 or create ~/.openclaw/chatgpt-export.disabled
 * and the function throws before any fetch or write.
 *
 * Usage: called from agent context. See SKILL.md.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Configuration
const CHATGPT_BASE = "https://chatgpt.com";
const API_BASE = `${CHATGPT_BASE}/backend-api`;
const DELAY_MS = 500; // Delay between requests to avoid rate limiting

interface ConversationItem {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
}

interface ConversationResponse {
  items: ConversationItem[];
  total: number;
  limit: number;
  offset: number;
}

interface MessageContent {
  content_type: string;
  parts?: string[];
}

interface Message {
  id: string;
  author: { role: string };
  content: MessageContent;
  create_time?: number;
}

interface MappingNode {
  id: string;
  message?: Message;
  parent?: string;
  children?: string[];
}

interface FullConversation {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, MappingNode>;
  current_node: string;
}

// JavaScript to execute in browser context
const FETCH_CONVERSATIONS_JS = `
(async () => {
  const results = [];
  let offset = 0;
  const limit = 100;
  
  while (true) {
    const response = await fetch(
      'https://chatgpt.com/backend-api/conversations?offset=' + offset + '&limit=' + limit,
      { credentials: 'include' }
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch: ' + response.status);
    }
    
    const data = await response.json();
    results.push(...data.items);
    
    if (data.items.length < limit) {
      break;
    }
    offset += limit;
    
    // Small delay to be nice
    await new Promise(r => setTimeout(r, 200));
  }
  
  return JSON.stringify({ items: results, total: results.length });
})()
`;

function assertConversationId(id: string): string {
  if (typeof id !== "string" || !id) throw new Error("Missing conversation id");
  if (id.length > 128) throw new Error("Conversation id too long");
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Conversation id contains disallowed characters");
  return id;
}

const createFetchConversationJS = (id: string) => {
  const safeId = assertConversationId(id);
  return `
(async () => {
  const response = await fetch(
    'https://chatgpt.com/backend-api/conversation/${safeId}',
    { credentials: 'include' }
  );
  
  if (!response.ok) {
    throw new Error('Failed to fetch conversation: ' + response.status);
  }
  
  return JSON.stringify(await response.json());
})()
`;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

function extractMessages(
  conversation: FullConversation,
): Array<{ role: string; content: string; timestamp?: number }> {
  const messages: Array<{ role: string; content: string; timestamp?: number }> = [];
  const mapping = conversation.mapping;

  // Find root node (no parent)
  let currentId = Object.keys(mapping).find((id) => !mapping[id].parent);
  if (!currentId) return messages;

  // Walk the tree following children
  const visited = new Set<string>();
  const queue = [currentId];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = mapping[nodeId];
    if (node?.message?.content?.parts && node.message.author.role !== "system") {
      const content = node.message.content.parts.join("\n");
      if (content.trim()) {
        messages.push({
          role: node.message.author.role,
          content,
          timestamp: node.message.create_time,
        });
      }
    }

    // Add children to queue
    if (node?.children) {
      queue.push(...node.children);
    }
  }

  return messages;
}

function conversationToMarkdown(conversation: FullConversation): string {
  const messages = extractMessages(conversation);
  const date = new Date(conversation.create_time * 1000).toISOString().split("T")[0];

  let md = `# ${conversation.title || "Untitled Conversation"}\n\n`;
  md += `**Date:** ${date}\n`;
  md += `**ID:** ${conversation.id}\n\n`;
  md += `---\n\n`;

  for (const msg of messages) {
    const roleLabel = msg.role === "user" ? "**You:**" : "**ChatGPT:**";
    md += `${roleLabel}\n\n${msg.content}\n\n---\n\n`;
  }

  return md;
}

// Main export function - designed to be called from agent context
export async function exportChatGPTConversations(options: {
  browserEvaluate: (js: string) => Promise<string>;
  /** Explicit user consent. Without `true` this function refuses to run. */
  confirmed?: boolean;
  outputDir?: string;
  format?: "json" | "md" | "both";
  limit?: number;
  /** Write only the conversation index — no message bodies are fetched or saved. */
  indexOnly?: boolean;
  onProgress?: (current: number, total: number, title: string) => void;
}): Promise<{ exported: number; outputDir: string; errors: string[] }> {
  const {
    browserEvaluate,
    confirmed = false,
    outputDir = join(homedir(), "chatgpt-export", new Date().toISOString().split("T")[0]),
    format = "both",
    limit,
    indexOnly = true,
    onProgress,
  } = options;

  // Off switch — checked before any network call or file write.
  if (
    process.env.CHATGPT_EXPORT_DISABLE === "1" ||
    existsSync(join(homedir(), ".openclaw", "chatgpt-export.disabled"))
  ) {
    throw new Error(
      "ChatGPT export is disabled on this machine " +
        "(CHATGPT_EXPORT_DISABLE=1 or ~/.openclaw/chatgpt-export.disabled). Nothing was fetched.",
    );
  }

  // Consent gate — the caller must have asked the user, and say so.
  if (!confirmed) {
    throw new Error(
      "Refusing to export without explicit consent. Tell the user that this writes a " +
        "plaintext copy of their full ChatGPT history to " +
        outputDir +
        " — message text included, which may contain credentials, health, legal, financial " +
        "or work-confidential material — then call again with { confirmed: true }. " +
        "Use { indexOnly: true } to export titles and timestamps only.",
    );
  }

  const errors: string[] = [];

  // Create output directories, readable only by this user.
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(outputDir, "conversations"), { recursive: true, mode: 0o700 });

  // Fetch conversation list
  console.log("Fetching conversation list...");
  const listResult = await browserEvaluate(FETCH_CONVERSATIONS_JS);
  const { items } = JSON.parse(listResult) as { items: ConversationItem[] };

  console.log(`Found ${items.length} conversations`);

  // Save index
  writeFileSync(join(outputDir, "index.json"), JSON.stringify(items, null, 2), { mode: 0o600 });

  if (indexOnly) {
    console.log("indexOnly: skipping message bodies. Only index.json was written.");
    return { exported: 0, outputDir, errors };
  }

  // Fetch each conversation
  const toFetch = limit ? items.slice(0, limit) : items;
  let exported = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const item = toFetch[i];
    const slug = slugify(item.title || "untitled");

    onProgress?.(i + 1, toFetch.length, item.title || "Untitled");

    try {
      const convResult = await browserEvaluate(createFetchConversationJS(item.id));
      const conversation = JSON.parse(convResult) as FullConversation;

      // Save JSON
      if (format === "json" || format === "both") {
        writeFileSync(
          join(outputDir, "conversations", `${item.id}.json`),
          JSON.stringify(conversation, null, 2),
          { mode: 0o600 },
        );
      }

      // Save Markdown
      if (format === "md" || format === "both") {
        const md = conversationToMarkdown(conversation);
        writeFileSync(join(outputDir, "conversations", `${item.id}_${slug}.md`), md, {
          mode: 0o600,
        });
      }

      exported++;

      // Rate limiting delay
      if (i < toFetch.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    } catch (err) {
      const errMsg = `Failed to export ${item.id} (${item.title}): ${err}`;
      console.error(errMsg);
      errors.push(errMsg);
    }
  }

  // Create summary
  const summary = `# ChatGPT Export Summary

**Date:** ${new Date().toISOString()}
**Total Conversations:** ${items.length}
**Exported:** ${exported}
**Errors:** ${errors.length}

## Conversations

${items.map((i) => `- [${i.title || "Untitled"}](conversations/${i.id}_${slugify(i.title || "untitled")}.md)`).join("\n")}
`;

  writeFileSync(join(outputDir, "summary.md"), summary, { mode: 0o600 });

  return { exported, outputDir, errors };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("This script should be run from the OpenClaw agent context.");
  console.log("The agent will use the browser tool to execute the export.");
  console.log('\nUsage from agent: "Export my ChatGPT conversations"');
  console.log("");
  console.log("It writes plaintext copies of your conversations to ~/chatgpt-export/<date>");
  console.log("(mode 0700) and will not run until you have confirmed that.");
  console.log("Off switch: CHATGPT_EXPORT_DISABLE=1 or touch ~/.openclaw/chatgpt-export.disabled");
}
