/**
 * WhatsApp History Tool
 * Allows agents to search and query WhatsApp message history
 */

import { Type } from "@sinclair/typebox";
import {
  searchMessages,
  getStats,
  importExportFile,
  importDirectory,
  formatImportResults,
} from "../../../extensions/tinkerclaw-whatsapp/src/history/index.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, readNumberParam, readBooleanParam } from "./common.js";

const WhatsAppHistorySchema = Type.Object({
  action: Type.Union([Type.Literal("search"), Type.Literal("stats"), Type.Literal("import")]),
  // Search parameters
  query: Type.Optional(Type.String({ description: "Full-text search query" })),
  chat: Type.Optional(Type.String({ description: "Filter by chat name or JID" })),
  sender: Type.Optional(Type.String({ description: "Filter by sender name or JID" })),
  fromMe: Type.Optional(Type.Boolean({ description: "Filter only messages from me" })),
  since: Type.Optional(Type.String({ description: "ISO date string for start of range" })),
  until: Type.Optional(Type.String({ description: "ISO date string for end of range" })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
  // Import parameters
  path: Type.Optional(
    Type.String({ description: "Path to WhatsApp export .txt file or directory" }),
  ),
  chatName: Type.Optional(Type.String({ description: "Override chat name for import" })),
});

function parseDate(dateStr: string | undefined): number | undefined {
  if (!dateStr) {
    return undefined;
  }
  const ts = Date.parse(dateStr);
  if (isNaN(ts)) {
    return undefined;
  }
  return Math.floor(ts / 1000);
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export function createWhatsAppHistoryTool(): AnyAgentTool {
  return {
    label: "WhatsApp History",
    name: "whatsapp_history",
    description: `Search and query WhatsApp message history stored in SQLite.

Actions:
- search: Full-text search across all messages. Use query for text search, chat/sender/fromMe for filters.
- stats: Get database statistics (total messages, chats, date range).
- import: Import WhatsApp chat exports (.txt files). Provide path to file or directory.

Examples:
- Search for keyword: { "action": "search", "query": "fusion reactor" }
- Find what a sender said: { "action": "search", "sender": "<name>", "limit": 20 }
- Messages from a chat: { "action": "search", "chat": "Max-Jarvis", "limit": 50 }
- My messages only: { "action": "search", "fromMe": true, "limit": 30 }
- Import exports: { "action": "import", "path": "/path/to/exports" }`,
    parameters: WhatsAppHistorySchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });

      try {
        switch (action) {
          case "search": {
            const query = readStringParam(params, "query");
            const chat = readStringParam(params, "chat");
            const sender = readStringParam(params, "sender");
            const fromMe = readBooleanParam(params, "fromMe");
            const since = parseDate(readStringParam(params, "since"));
            const until = parseDate(readStringParam(params, "until"));
            const limit = readNumberParam(params, "limit") || 50;

            const results = searchMessages({
              query,
              chat,
              sender,
              fromMe,
              since,
              until,
              limit,
            });

            // Format results for readability, extracting vCard details for contact messages
            const formatted = results.map((r) => {
              const base: Record<string, unknown> = {
                id: r.id,
                chat: r.chat_name || r.chat_jid,
                sender: r.from_me ? "me" : r.sender_name || r.sender_jid || "unknown",
                time: formatTimestamp(r.timestamp),
                type: r.message_type,
                text: r.text_content || r.caption || "(no text)",
              };
              // Extract vCard phone numbers from raw_json for contact messages
              if (r.message_type === "contact" && r.raw_json) {
                try {
                  const raw = JSON.parse(r.raw_json);
                  const vcards: string[] = [];
                  if (raw.message?.contactMessage?.vcard) {
                    vcards.push(raw.message.contactMessage.vcard);
                  }
                  if (raw.message?.contactsArrayMessage?.contacts) {
                    for (const c of raw.message.contactsArrayMessage.contacts) {
                      if (c.vcard) {
                        vcards.push(c.vcard);
                      }
                    }
                  }
                  if (vcards.length > 0) {
                    const contacts = vcards.map((vc) => {
                      const nameMatch = vc.match(/FN[;:]([^\r\n]+)/i);
                      const phoneMatches = vc.match(/TEL[^:]*:([+\d\s-]+)/gi) || [];
                      const phones = phoneMatches.map((t) => t.replace(/TEL[^:]*:/i, "").trim());
                      return {
                        name: nameMatch?.[1]?.trim() || "unknown",
                        phones,
                      };
                    });
                    base.vcard = contacts;
                  }
                } catch {
                  // raw_json parse failed — skip vCard extraction
                }
              }
              return base;
            });

            return jsonResult({
              count: formatted.length,
              messages: formatted,
            });
          }

          case "stats": {
            const stats = getStats();
            return jsonResult({
              total_messages: stats.total_messages,
              total_chats: stats.total_chats,
              total_contacts: stats.total_contacts,
              date_range:
                stats.oldest_message && stats.newest_message
                  ? {
                      oldest: formatTimestamp(stats.oldest_message),
                      newest: formatTimestamp(stats.newest_message),
                    }
                  : null,
            });
          }

          case "import": {
            const filePath = readStringParam(params, "path", { required: true });
            const chatName = readStringParam(params, "chatName");

            // Check if it's a directory or file
            const fs = await import("node:fs");
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
              const results = await importDirectory(filePath);
              return jsonResult({
                success: true,
                summary: formatImportResults(results),
                results,
              });
            } else {
              const result = await importExportFile(filePath, chatName);
              return jsonResult({
                success: true,
                ...result,
              });
            }
          }

          default:
            return jsonResult({ error: `Unknown action: ${action}` });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: message });
      }
    },
  };
}
