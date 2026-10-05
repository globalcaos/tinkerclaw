/**
 * ChatGPT Conversation Exporter — browser-relay path (recommended)
 *
 * Fetches conversations from ChatGPT's internal API through an attached browser relay,
 * using the session your browser already holds. It reads no token, no cookie jar and no
 * credential file: every request runs inside the page with `credentials: 'include'`.
 *
 * WRITES TO DISK: .chatgpt-export-manifest.json and index.json; unless indexOnly also summary.md
 * and one .json and one .md per conversation containing full message text. The output directory is created mode 0700 and
 * every file mode 0600. Nothing is uploaded anywhere.
 *
 * NO WRITE FOLLOWS A SYMLINK (1.9.2). Every file is opened with O_NOFOLLOW and its mode is set
 * through the open descriptor; the `conversations` subdirectory must be a real directory whose
 * canonical path is exactly <export dir>/conversations. A reused export directory that contains
 * a symlinked index.json, summary.md, manifest, conversations/ or conversation file is refused
 * and the link target is left untouched. Platforms without O_NOFOLLOW are refused (fail closed).
 * The directory is re-checked after every open; on Linux the descriptor's real path must match
 * too, so a directory swapped in and back out around the open is caught. Without /proc that
 * swap-and-restore race by another process running as the same user is not detected.
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

import {
  mkdirSync,
  existsSync,
  realpathSync,
  readlinkSync,
  lstatSync,
  unlinkSync,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  ftruncateSync,
  writeSync,
  constants as fsConstants,
} from "fs";
import { join, resolve, sep, dirname, isAbsolute } from "path";
import { homedir } from "os";

// Configuration
const CHATGPT_BASE = "https://chatgpt.com";
const API_BASE = `${CHATGPT_BASE}/backend-api`;
const DELAY_MS = 500; // Delay between requests to avoid rate limiting

/**
 * A dedicated private directory, deliberately NOT ~/chatgpt-export: sync clients and backup
 * tools tend to watch the top of the home directory, and an export is a plaintext copy of
 * everything the user has ever typed into ChatGPT.
 */
const EXPORT_ROOT = join(homedir(), ".local", "share", "chatgpt-export");

/**
 * The ownership marker. scripts/export.sh --purge deletes nothing that does not carry this
 * file, so the relay writes it too — otherwise exports made here could not be cleaned up by
 * the supported delete path.
 */
const MANIFEST_NAME = ".chatgpt-export-manifest.json";
const MANIFEST_FORMAT = "chatgpt-export-manifest/1";

/**
 * Best-effort redaction of the fixed-shape credentials people paste into chats. This is a
 * safety net, not a guarantee: it cannot recognise a secret that has no recognisable shape.
 */
const REDACTIONS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED:openai-key]"],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED:github-token]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-key-id]"],
  [/AIza[0-9A-Za-z_-]{30,}/g, "[REDACTED:google-key]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED:jwt]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key-header]"],
  [/(Bearer |bearer )[A-Za-z0-9._-]{20,}/g, "$1[REDACTED:bearer]"],
];

export function redact(text: string, enabled: boolean): string {
  if (!enabled) return text;
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Destination allowlisting. Writing an export into a folder a sync client is watching hands a
 * plaintext copy of the user's whole history to a cloud they were not thinking about, so a
 * destination that looks synced, sits inside a git repo, or leaves the home directory is
 * refused unless the caller explicitly overrides it.
 */
const SYNC_MARKERS = [
  "Dropbox",
  "Google Drive",
  "GoogleDrive",
  "OneDrive",
  "iCloud",
  "Mobile Documents",
  "Nextcloud",
  "ownCloud",
  "Syncthing",
  "pCloud",
  "MEGA",
  "Yandex.Disk",
];

/** Raised for any destination-integrity failure; always aborts the whole export. */
export class UnsafeDestinationError extends Error {}

const NOFOLLOW_FLAGS = (() => {
  const { O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK } = fsConstants as Record<string, number | undefined>;
  if (typeof O_NOFOLLOW !== "number" || typeof O_DIRECTORY !== "number" || typeof O_NONBLOCK !== "number") {
    return null;
  }
  return { O_NOFOLLOW, O_DIRECTORY, O_NONBLOCK };
})();

function requireNoFollow(): NonNullable<typeof NOFOLLOW_FLAGS> {
  if (!NOFOLLOW_FLAGS) {
    throw new UnsafeDestinationError(
      "Refusing to export: this platform does not offer O_NOFOLLOW, so writes cannot be " +
        "guaranteed not to follow a symbolic link.",
    );
  }
  return NOFOLLOW_FLAGS;
}

function linkRefusal(path: string, err: unknown): never {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK") {
    throw new UnsafeDestinationError(
      `Refusing to use ${path} — it is a symbolic link (or not the expected kind of entry). ` +
        "Nothing was written through it.",
    );
  }
  throw err;
}

/**
 * Create (or reuse) a directory that is a REAL directory — never a symlink — owned by this user,
 * forced to 0700 through its own descriptor, and whose canonical path is exactly `expected`.
 */
function ensurePrivateDir(path: string, expected: string | null, recursive: boolean): string {
  const { O_NOFOLLOW, O_DIRECTORY } = requireNoFollow();
  try {
    mkdirSync(path, { recursive, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    linkRefusal(path, err);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) {
      throw new UnsafeDestinationError(`Refusing to export to ${path} — it is not a directory.`);
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new UnsafeDestinationError(`Refusing to export to ${path} — it is not owned by you.`);
    }
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
  const real = realpathSync(path);
  if (expected !== null && real !== expected) {
    throw new UnsafeDestinationError(
      `Refusing to export to ${path} — it resolves to ${real}, not ${expected}.`,
    );
  }
  return real;
}

/**
 * Test seam for the race cases only: called just before the file is opened and just after, so
 * relay-selftest.ts can swap a directory in between. Not reachable through
 * exportChatGPTConversations(); null in normal use.
 */
type RaceStage = "beforeOpen" | "afterOpen";
let raceHook: ((stage: RaceStage, path: string) => void) | null = null;

/**
 * Write a file that is readable only by this user, without ever following a symlink.
 *
 * `dir` must be a canonical directory already verified by ensurePrivateDir; it is re-verified
 * here before AND after the open. The file is opened O_NOFOLLOW (a symlink at the leaf fails with
 * ELOOP), must be a regular file with a single link owned by this user (so a hard link to some
 * other file is not overwritten), and is truncated and chmod-ed through the descriptor only after
 * every check passes. Where /proc exposes it (Linux), the descriptor's real path must equal the
 * intended path, which also catches a directory swapped in and back out around the open.
 * If a check fails for a file this call created, the empty file is removed again (Linux).
 */
function writePrivate(dir: string, name: string, contents: string): void {
  const { O_NOFOLLOW, O_NONBLOCK } = requireNoFollow();
  if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new UnsafeDestinationError(`Refusing to write ${name} — not a plain file name.`);
  }
  if (realpathSync(dir) !== dir) {
    throw new UnsafeDestinationError(`Refusing to write into ${dir} — it no longer resolves to itself.`);
  }
  const path = join(dir, name);
  raceHook?.("beforeOpen", path);
  const base = fsConstants.O_WRONLY | O_NOFOLLOW | O_NONBLOCK;
  let fd: number;
  let created = false;
  try {
    fd = openSync(path, base | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    created = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") linkRefusal(path, err);
    try {
      fd = openSync(path, base);
    } catch (err2) {
      linkRefusal(path, err2);
    }
  }
  const procPath = `/proc/self/fd/${fd}`;
  const hasProc = existsSync(procPath);
  try {
    raceHook?.("afterOpen", path);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new UnsafeDestinationError(`Refusing to write ${path} — it is not a regular file.`);
    }
    if (st.nlink !== 1) {
      throw new UnsafeDestinationError(`Refusing to write ${path} — it is hard-linked elsewhere.`);
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new UnsafeDestinationError(`Refusing to write ${path} — it is not owned by you.`);
    }
    if (hasProc && readlinkSync(procPath) !== path) {
      throw new UnsafeDestinationError(`Refusing to write ${path} — the opened file is not at that path.`);
    }
    let stillHere = false;
    try {
      stillHere = realpathSync(dir) === dir;
    } catch {
      stillHere = false;
    }
    if (!stillHere) {
      throw new UnsafeDestinationError(
        `Refusing to write ${path} — ${dir} changed while the file was being opened.`,
      );
    }
    ftruncateSync(fd, 0);
    fchmodSync(fd, 0o600);
    const buf = Buffer.from(contents, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } catch (err) {
    if (created && hasProc) removeEmptyCreatedFile(fd, procPath);
    throw err;
  } finally {
    closeSync(fd);
  }
}

/** Remove a still-empty file this process just created, wherever it actually landed (Linux). */
function removeEmptyCreatedFile(fd: number, procPath: string): void {
  try {
    const real = readlinkSync(procPath);
    const st = fstatSync(fd);
    const at = lstatSync(real);
    if (at.isFile() && at.dev === st.dev && at.ino === st.ino && at.size === 0) unlinkSync(real);
  } catch {
    // best effort: nothing was written into the file, and the export is aborting anyway
  }
}

/** For scripts/relay-selftest.ts only. */
export const _testing = {
  writePrivate,
  setRaceHook(hook: ((stage: RaceStage, path: string) => void) | null): void {
    raceHook = hook;
  },
};

export function destinationObjection(dir: string): string | null {
  const abs = resolve(dir);

  // CANONICALIZE FIRST, THEN JUDGE (fixed 1.9.1). The sync-marker test used to run against the
  // path as written, which meant ~/notsynced passed while being a symlink to ~/Dropbox: the
  // string carries no marker, so the export went to a cloud folder anyway. Every test below now
  // runs on the resolved path. The destination usually does not exist yet, so resolve the
  // deepest ancestor that DOES exist and re-attach the tail — the symlink is always in the part
  // that exists.
  let existing = abs;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let canonical: string;
  try {
    canonical =
      abs === existing ? realpathSync(abs) : join(realpathSync(existing), abs.slice(existing.length + 1));
  } catch {
    return "its path could not be resolved";
  }
  let home: string;
  try {
    home = realpathSync(homedir());
  } catch {
    return "your home directory could not be resolved";
  }

  for (const marker of SYNC_MARKERS) {
    if (canonical.includes(marker) || abs.includes(marker)) {
      return `it resolves to what looks like a synced folder (${marker})`;
    }
  }
  if (canonical === home) {
    return "it resolves to your home directory itself";
  }
  if (!canonical.startsWith(home + sep)) {
    return `it resolves to a location outside your home directory (${canonical})`;
  }
  let probe = canonical;
  while (probe.startsWith(home + sep)) {
    if (existsSync(join(probe, ".git"))) {
      return `it resolves to a path inside a git repository (${probe})`;
    }
    probe = dirname(probe);
  }
  return null;
}

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
  /** Best-effort scrub of common secret formats before anything is written. */
  redact?: boolean;
  /** Days until this export is considered expired by `export.sh --purge-expired`. */
  expireDays?: number;
  onProgress?: (current: number, total: number, title: string) => void;
}): Promise<{ exported: number; outputDir: string; errors: string[] }> {
  const {
    browserEvaluate,
    confirmed = false,
    outputDir: requestedDir = join(EXPORT_ROOT, new Date().toISOString().split("T")[0]),
    format = "both",
    limit,
    indexOnly = true,
    redact: redactSecrets = false,
    expireDays = 30,
    onProgress,
  } = options;

  // "~/x" is expanded; anything else must already be absolute, as in export.sh --check-dest.
  const outputDir =
    requestedDir === "~" || requestedDir.startsWith("~/")
      ? join(homedir(), requestedDir.slice(1))
      : requestedDir;

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

  // Consent gate — the caller must have asked the user, and say so. The message is structured
  // on purpose: an agent that relays it has already told the user the destination and the exact
  // scope, which is the confirmation step this skill is required to perform before any fetch.
  if (!confirmed) {
    throw new Error(
      "Refusing to export without explicit consent. Show the user these exact terms and get a " +
        "yes, then call again with { confirmed: true }:\n" +
        `  Destination : ${outputDir} (created mode 0700, files 0600)\n` +
        `  Scope       : ${indexOnly ? "INDEX ONLY — titles, ids, timestamps. No message text is fetched." : "FULL CONTENT — the complete text of every message, both sides."}\n` +
        `  Cap         : ${limit ? `the ${limit} most recent conversations` : "none — every conversation in the account"}\n` +
        `  Redaction   : ${redactSecrets ? "on (best-effort)" : "off"}\n` +
        "  Network     : chatgpt.com only. No upload, no telemetry, no third party.\n" +
        "  Sensitivity : the export may contain credentials, health, legal, financial or " +
        "work-confidential material.\n" +
        "Use { indexOnly: true } to export titles and timestamps only.",
    );
  }

  // Destination allowlisting, before anything is fetched or written. This is unconditional:
  // the allowUnsafeDest override was removed in 1.9.1. An escape hatch that lets a plaintext
  // copy of an entire chat history be written into a synced folder or a git repo is not a
  // guardrail, and documenting it did not make it one.
  const objection = isAbsolute(outputDir)
    ? destinationObjection(outputDir)
    : "the destination must be an absolute path (or start with ~/)";
  if (objection) {
    throw new Error(
      `Refusing to export to ${outputDir} — ${objection}. Pick a local, non-synced ` +
        "directory inside your home and outside any git repository.",
    );
  }

  const errors: string[] = [];

  // Create the output directory and verify it. ensurePrivateDir opens it O_NOFOLLOW (so a
  // symlinked leaf is refused BEFORE its mode is touched — chmod would otherwise follow the link),
  // requires a real directory owned by this user, and forces 0700 through the descriptor so a
  // reused permissive directory is tightened too.
  const settledDir = ensurePrivateDir(outputDir, null, true);
  const settledObjection = destinationObjection(settledDir);
  if (settledObjection) {
    throw new Error(
      `Refusing to export to ${outputDir} — after creation it resolves to ${settledDir}, ` +
        `which is unacceptable: ${settledObjection}.`,
    );
  }

  // Every path below is built from the CANONICAL directory. The conversations subdirectory must
  // be a real directory at exactly <settledDir>/conversations — a symlink there, left behind in a
  // reused export directory, is refused instead of being written through.
  const convDir = indexOnly
    ? null
    : ensurePrivateDir(join(settledDir, "conversations"), join(settledDir, "conversations"), false);

  // Ownership marker + expiry, so `export.sh --purge` / `--purge-expired` will accept this
  // directory later. Without it the delete path refuses to touch these files, by design.
  const nowEpoch = Math.floor(Date.now() / 1000);
  writePrivate(
    settledDir,
    MANIFEST_NAME,
    JSON.stringify(
      {
        format: MANIFEST_FORMAT,
        tool: "chatgpt-exporter-ultimate",
        created_at_epoch: nowEpoch,
        expires_at_epoch: nowEpoch + expireDays * 86400,
        expire_days: expireDays,
        index_only: indexOnly,
        redacted: redactSecrets,
      },
      null,
      2,
    ),
  );

  // Fetch conversation list
  console.log("Fetching conversation list...");
  const listResult = await browserEvaluate(FETCH_CONVERSATIONS_JS);
  const { items } = JSON.parse(listResult) as { items: ConversationItem[] };

  console.log(`Found ${items.length} conversations`);

  // Save index
  writePrivate(
    settledDir,
    "index.json",
    redact(JSON.stringify(items, null, 2), redactSecrets),
  );

  if (indexOnly) {
    console.log("indexOnly: skipping message bodies. Only the manifest and index.json were written.");
    console.log(`Delete it when done:  ./scripts/export.sh --purge -o "${outputDir}"`);
    return { exported: 0, outputDir: settledDir, errors };
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
        writePrivate(
          convDir!,
          `${item.id}.json`,
          redact(JSON.stringify(conversation, null, 2), redactSecrets),
        );
      }

      // Save Markdown
      if (format === "md" || format === "both") {
        const md = redact(conversationToMarkdown(conversation), redactSecrets);
        writePrivate(convDir!, `${item.id}_${slug}.md`, md);
      }

      exported++;

      // Rate limiting delay
      if (i < toFetch.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    } catch (err) {
      // A destination-integrity failure aborts the whole run; it is not a per-conversation hiccup.
      if (err instanceof UnsafeDestinationError) throw err;
      const errMsg = `Failed to export ${item.id} (${item.title}): ${err}`;
      console.error(errMsg);
      errors.push(errMsg);
    }
  }

  // Create summary.
  //
  // Conversation TITLES are conversation content: people paste keys, client names and medical
  // detail into the first message, and ChatGPT titles the thread from it. Redaction used to be
  // applied to index.json and to the per-conversation files but NOT here, so a run with
  // { redact: true } produced a "redacted" export whose summary still listed every title in
  // clear. The whole rendered summary now goes through the same filter as everything else.
  const summary = redact(
    `# ChatGPT Export Summary

**Date:** ${new Date().toISOString()}
**Total Conversations:** ${items.length}
**Exported:** ${exported}
**Errors:** ${errors.length}

## Conversations

${items.map((i) => `- [${i.title || "Untitled"}](conversations/${i.id}_${slugify(i.title || "untitled")}.md)`).join("\n")}
`,
    redactSecrets,
  );

  writePrivate(settledDir, "summary.md", summary);

  return { exported, outputDir: settledDir, errors };
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("This script should be run from the OpenClaw agent context.");
  console.log("The agent will use the browser tool to execute the export.");
  console.log('\nInvoke it by name, so ordinary conversation about ChatGPT cannot trigger it:');
  console.log('  "chatgpt-exporter-ultimate: export my conversations"');
  console.log("");
  console.log("It writes plaintext copies of your conversations to");
  console.log("~/.local/share/chatgpt-export/<date> (mode 0700), index-only unless you ask for");
  console.log("full content, and will not run until you have confirmed the destination and scope.");
  console.log("Delete an export:  ./scripts/export.sh --purge -o <dir>");
  console.log("Off switch: CHATGPT_EXPORT_DISABLE=1 or touch ~/.openclaw/chatgpt-export.disabled");
}
