/**
 * Decomposes an assembled system prompt string into named sections
 * by splitting on `## Header` markers used in system-prompt.ts.
 */

export interface SystemPromptSection {
  name: string;
  text: string;
  chars: number;
}

/**
 * Known section header → short name mapping.
 * Headers not in this map are slugified automatically.
 */
const HEADER_NAME_MAP: Record<string, string> = {
  Tooling: "tooling",
  "Tool Call Style": "tool_call_style",
  Safety: "safety",
  "OpenClaw CLI Quick Reference": "cli_reference",
  "Skills (mandatory)": "skills",
  Memory: "memory_recall",
  "OpenClaw Self-Update": "self_update",
  "Model Aliases": "model_aliases",
  Workspace: "workspace",
  Docs: "docs",
  Sandbox: "sandbox",
  Owner: "user_identity",
  Identity: "user_identity",
  "Authorized Senders": "authorized_senders",
  "Current Date & Time": "time",
  Time: "time",
  "Workspace Files (injected)": "workspace_files",
  "Reply Tags": "reply_tags",
  Messaging: "messaging",
  Channels: "messaging",
  Voice: "voice",
  "Group Chat Context": "group_chat_context",
  "Subagent Context": "subagent_context",
};

function slugify(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function parseSystemPromptSections(systemPrompt: string): SystemPromptSection[] {
  if (!systemPrompt) {
    return [];
  }

  const sections: SystemPromptSection[] = [];
  const lines = systemPrompt.split("\n");

  let currentName = "identity";
  let currentLines: string[] = [];
  let identityDone = false;

  for (const line of lines) {
    const headerMatch = line.match(/^## (.+)$/);
    if (headerMatch) {
      // Flush the previous section
      const text = currentLines.join("\n").trim();
      if (text) {
        sections.push({ name: currentName, text, chars: text.length });
      }

      // If identity section just ended and there was content before first ##,
      // check if there's a cortex persona block (content between identity line and first ##)
      if (!identityDone && sections.length === 1) {
        // The identity section already captured; now see if there's a persona block
        // that was part of the identity content. Split it out if multi-line.
        const identitySection = sections[0];
        const identityLines = identitySection.text.split("\n");
        if (identityLines.length > 1) {
          const firstLine = identityLines[0].trim();
          const rest = identityLines.slice(1).join("\n").trim();
          if (firstLine && rest) {
            sections[0] = { name: "identity", text: firstLine, chars: firstLine.length };
            sections.splice(1, 0, { name: "persona_cortex", text: rest, chars: rest.length });
          }
        }
      }
      identityDone = true;

      const rawHeader = headerMatch[1].trim();
      currentName = HEADER_NAME_MAP[rawHeader] ?? slugify(rawHeader);
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  const text = currentLines.join("\n").trim();
  if (text) {
    sections.push({ name: currentName, text, chars: text.length });
  }

  // Handle the identity/cortex split if no ## headers were found at all
  if (!identityDone && sections.length === 1) {
    const identitySection = sections[0];
    const identityLines = identitySection.text.split("\n");
    if (identityLines.length > 1) {
      const firstLine = identityLines[0].trim();
      const rest = identityLines.slice(1).join("\n").trim();
      if (firstLine && rest) {
        sections[0] = { name: "identity", text: firstLine, chars: firstLine.length };
        sections.splice(1, 0, { name: "persona_cortex", text: rest, chars: rest.length });
      }
    }
  }

  return sections;
}
