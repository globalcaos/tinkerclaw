#!/usr/bin/env node
/**
 * teams.mjs — Microsoft Teams via Graph API
 *
 * SAFETY MODEL (every rule below is enforced in code, not just documented):
 *   - The MSAL refresh token is stored in the OS keychain (secret-tool on Linux,
 *     security on macOS). If no keychain exists it falls back to a 0600 file and
 *     PRINTS A WARNING on every use.
 *   - The token is never accepted as a command-line argument (it would show up in
 *     `ps` and shell history). It is read from stdin.
 *   - Access tokens are held in memory for one run and never written to disk.
 *   - Credentialed requests go only to graph.microsoft.com and
 *     login.microsoftonline.com; any other host is refused before the token is read.
 *   - Sending messages is OFF by default: needs TEAMS_ALLOW_SEND=1 and --yes.
 *   - `token logout` clears the keychain entry AND the fallback file, and prints
 *     the Microsoft URL that revokes the token server-side.
 *
 * Subcommands:
 *   token extract-browser    — Print JS to run in Teams tab (extracts refresh token)
 *   token store [--tenant-id <id>]          — reads the refresh token from STDIN
 *   token test
 *   token logout                            — clear local credentials (alias: --revoke)
 *   chats [--top N]                         — List recent chats
 *   chat <chatId> [--top N]                 — Read messages from a chat
 *   chat-send <chatId> --message <text> --yes  — Send (needs TEAMS_ALLOW_SEND=1)
 *   channels <teamId>                       — List channels in a team
 *   channel <teamId> <channelId> [--top N]  — Read channel messages
 *   channel-send <teamId> <channelId> --message <text> --yes
 *   teams                                   — List joined teams
 *   presence [--user-id <id>]               — Get presence status
 *   users [--search X] [--top N]            — Search users in org
 *   me                                      — Profile info
 *   activity [--top N]                      — Activity feed
 *   calendar [--days N]                     — Calendar (same as outlook)
 *   search <query>                          — Search messages across Teams
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CREDS_DIR = join(homedir(), ".openclaw/credentials");
// Non-secret metadata (client id, tenant, scope, timestamps) lives here.
// The refresh token only lands here when NO OS keychain is available.
const META_FILE = join(CREDS_DIR, "outlook-msal.json");
const KEYCHAIN_SERVICE = "openclaw-teams-hack";
const KEYCHAIN_ACCOUNT = "msal-refresh-token";
const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_BETA = "https://graph.microsoft.com/beta";
// SAFETY: credentialed requests may reach these two hosts and nothing else.
const ALLOWED_HOSTS = new Set(["graph.microsoft.com", "login.microsoftonline.com"]);
// Server-side revoke — the only thing that actually kills a leaked refresh token.
const REVOKE_URL = "https://myaccount.microsoft.com/device-list";

mkdirSync(CREDS_DIR, { recursive: true });

// ─── Network allowlist ───
// Checked BEFORE the token is read, so a redirected/nextLink URL can never carry
// your credentials to another host.
function assertAllowedUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Refusing to request a malformed URL: ${url}`);
  }
  if (
    u.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  ) {
    throw new Error(
      `Refusing to send credentials to ${u.protocol}//${u.host} — allowed: ${[...ALLOWED_HOSTS].join(", ")} over https, no port, no userinfo`,
    );
  }
  return url;
}

// Graph ids (chat/team/channel/user) are interpolated into request paths, so they
// are restricted to Graph-safe characters — no slash, query, fragment or traversal.
const GRAPH_ID_RE = /^[A-Za-z0-9@._:|=+-]+$/;
function safeId(value, label) {
  if (typeof value !== "string" || !GRAPH_ID_RE.test(value) || value.includes("..")) {
    throw new Error(
      `Invalid ${label}: expected a Microsoft Graph id, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

// ─── Keychain (OS secret store) ───
function keychainBinName() {
  if (process.platform === "darwin") return "security";
  if (process.platform === "linux") return "secret-tool";
  return null;
}

// PATH lookup without spawning anything, so absence costs no subprocess.
function findBin(name) {
  if (!name) return null;
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function keychainAvailable() {
  return Boolean(findBin(keychainBinName()));
}

function keychainGet() {
  const bin = findBin(keychainBinName());
  if (!bin) return null;
  const args =
    process.platform === "darwin"
      ? ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]
      : ["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT];
  try {
    const v = execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

// Secret goes in on STDIN in both branches — never on argv, where `ps` would see it.
function keychainSet(secret) {
  const bin = findBin(keychainBinName());
  if (!bin) return false;
  const args =
    process.platform === "darwin"
      ? ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"]
      : [
          "store",
          "--label",
          "OpenClaw teams-hack MSAL refresh token",
          "service",
          KEYCHAIN_SERVICE,
          "account",
          KEYCHAIN_ACCOUNT,
        ];
  try {
    execFileSync(bin, args, { input: `${secret}\n`, stdio: ["pipe", "ignore", "ignore"] });
  } catch {
    return false;
  }
  return keychainGet() === secret; // read back: a silent no-op must not look like success
}

function keychainClear() {
  const bin = findBin(keychainBinName());
  if (!bin) return false;
  const args =
    process.platform === "darwin"
      ? ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]
      : ["clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT];
  try {
    execFileSync(bin, args, { stdio: "ignore" });
  } catch {
    return false;
  }
  return keychainGet() === null;
}

// ─── Credential storage ───
// Metadata file never holds an access token, and holds the refresh token only as
// the warned fallback.
function loadMeta() {
  if (!existsSync(META_FILE)) return {};
  try {
    return JSON.parse(readFileSync(META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveMeta(meta) {
  const clean = { ...meta };
  delete clean.access_token;
  delete clean.expires_at;
  writeFileSync(META_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  try {
    chmodSync(META_FILE, 0o600);
  } catch {}
}

function warnPlaintextToken() {
  console.error(
    `⚠️  SECURITY: your Teams refresh token is stored in PLAINTEXT at ${META_FILE} (mode 0600).`,
  );
  if (keychainAvailable()) {
    console.error("    An OS keychain IS available — re-run `teams token store` to move it there.");
  } else {
    console.error(
      `    No OS keychain found (${process.platform === "darwin" ? "expected `security`" : "install libsecret for `secret-tool`"}).`,
    );
  }
  console.error("    Anything running as your user can read it. Clear it with: teams token logout");
}

function loadRefreshToken() {
  const fromKeychain = keychainGet();
  if (fromKeychain) return fromKeychain;
  const meta = loadMeta();
  if (meta.refresh_token) {
    warnPlaintextToken();
    return meta.refresh_token;
  }
  return null;
}

// Keychain first; 0600 file only as a warned fallback. On keychain success any
// previous plaintext copy is stripped, so "moved to the keychain" is literally true.
function storeRefreshToken(secret, meta = loadMeta()) {
  if (keychainSet(secret)) {
    const clean = { ...meta };
    delete clean.refresh_token;
    saveMeta(clean);
    return "keychain";
  }
  saveMeta({ ...meta, refresh_token: secret });
  warnPlaintextToken();
  return "file";
}

let _accessToken = null;

async function refreshAccessToken() {
  const meta = loadMeta();
  const clientId = meta.client_id || "5e3ce6c0-2b1f-4285-8d4b-75ee78787346";
  const tenantId = meta.tenant_id || "common";
  const origin = meta.origin || "https://teams.cloud.microsoft";
  const scope = meta.scope || "https://graph.microsoft.com/.default offline_access";

  const rt = loadRefreshToken();
  if (!rt) throw new Error("No refresh token. Run: teams token extract-browser");

  const tokenUrl = assertAllowedUrl(
    `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
  );
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: rt,
    scope,
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);

  // Access token stays in memory for this run only — it is never written to disk.
  _accessToken = data.access_token;
  const updated = { ...meta, updated_at: new Date().toISOString() };
  if (data.refresh_token && data.refresh_token !== rt) {
    storeRefreshToken(data.refresh_token, updated); // rotation lands in the keychain too
  } else {
    saveMeta(updated);
  }
  return _accessToken;
}

async function getToken() {
  if (_accessToken) return _accessToken;
  return refreshAccessToken();
}

// ─── Graph API ───
async function graphGet(path, beta = false, retried = false) {
  const base = beta ? GRAPH_BETA : GRAPH;
  // Host is checked BEFORE the credential is read, so a hostile URL never sees a token.
  const url = assertAllowedUrl(path.startsWith("http") ? path : `${base}${path}`);
  const token = await getToken();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (resp.status === 401 && !retried) {
    _accessToken = null;
    await refreshAccessToken();
    return graphGet(path, beta, true);
  }
  if (!resp.ok) throw new Error(`Graph ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function graphPost(path, body, beta = false, retried = false) {
  const base = beta ? GRAPH_BETA : GRAPH;
  const url = assertAllowedUrl(path.startsWith("http") ? path : `${base}${path}`);
  const token = await getToken();
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 && !retried) {
    _accessToken = null;
    await refreshAccessToken();
    return graphPost(path, body, beta, true);
  }
  if (resp.status === 204 || resp.status === 201 || resp.status === 202) {
    const text = await resp.text();
    return text ? JSON.parse(text) : { status: "ok" };
  }
  if (!resp.ok) throw new Error(`Graph ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ─── Helpers ───
function parseArgs(argv) {
  const result = { _: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result.flags[key] = argv[++i];
      } else {
        result.flags[key] = true;
      }
    } else {
      result._.push(argv[i]);
    }
    i++;
  }
  return result;
}

// SAFETY: sending is a real message to real people and cannot be unsent.
// It needs BOTH an environment opt-in and a per-call --yes.
function assertSendAllowed(args, what) {
  if (process.env.TEAMS_ALLOW_SEND !== "1") {
    console.error(
      `Refusing to ${what}: message sending is opt-in. Set TEAMS_ALLOW_SEND=1 to enable it.`,
    );
    process.exit(1);
  }
  if (args.flags.yes !== true && args.flags.yes !== "true") {
    console.error(
      `Refusing to ${what}: add --yes to confirm. This posts to real people and cannot be undone.`,
    );
    process.exit(1);
  }
}

async function readSecretFromStdin(what) {
  if (process.stdin.isTTY) {
    throw new Error(
      `Pipe the ${what} on stdin; command-line secrets are refused because they appear in \`ps\` and shell history`,
    );
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (!value) throw new Error(`No ${what} received on stdin`);
  return value;
}

function out(data) {
  console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

function formatMsg(m) {
  return {
    id: m.id,
    from: m.from?.user?.displayName || m.from?.application?.displayName || "?",
    date: m.createdDateTime?.slice(0, 19).replace("T", " "),
    body: m.body?.content
      ?.replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500),
    type: m.messageType,
    importance: m.importance,
    hasAttachments: (m.attachments?.length || 0) > 0,
  };
}

// ─── Commands ───

async function cmdTokenExtractBrowser() {
  console.log(`// Run this in the browser console on teams.cloud.microsoft:
// Or let the agent run it via browser(action=act, evaluate)

(() => {
  const keys = Object.keys(localStorage).filter(k => 
    k.includes('refreshtoken') || k.includes('RefreshToken')
  );
  if (keys.length === 0) return { error: 'No refresh tokens found in localStorage' };
  
  const results = keys.map(k => {
    try {
      const parsed = JSON.parse(localStorage.getItem(k));
      return {
        key: k,
        secret: parsed.secret,
        home_account_id: parsed.home_account_id,
        environment: parsed.environment,
        credential_type: parsed.credential_type,
        client_id: parsed.client_id,
      };
    } catch(e) {
      return { key: k, raw: localStorage.getItem(k)?.slice(0, 100) };
    }
  });
  
  // Also get tenant info
  const accountKeys = Object.keys(localStorage).filter(k => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v?.tenantId; } catch { return false; }
  });
  let tenantId = null;
  for (const k of accountKeys) {
    try { tenantId = JSON.parse(localStorage.getItem(k)).tenantId; break; } catch {}
  }
  
  return { tokens: results, tenantId };
})();`);
}

async function cmdTokenStore(args) {
  if (args.flags["refresh-token"]) {
    console.error(
      "Refusing a token on the command line — it would be visible in `ps` and your shell history.",
    );
    console.error(
      "Use:  printf '%s' \"$TEAMS_REFRESH_TOKEN\" | teams token store [--tenant-id <id>]",
    );
    process.exit(1);
  }

  const rt = await readSecretFromStdin("refresh token");
  const tenantId = args.flags["tenant-id"] || loadMeta().tenant_id || "common";
  const where = storeRefreshToken(rt, {
    client_id: "5e3ce6c0-2b1f-4285-8d4b-75ee78787346",
    tenant_id: tenantId,
    origin: "https://teams.cloud.microsoft",
    scope: "https://graph.microsoft.com/.default offline_access",
    api: "graph",
    updated_at: new Date().toISOString(),
  });
  console.error(
    where === "keychain"
      ? "✅ Token stored in the OS keychain. Testing..."
      : `✅ Token stored at ${META_FILE} (0600). Testing...`,
  );
  try {
    await refreshAccessToken();
    const me = await graphGet("/me?$select=displayName,mail");
    out({ status: "ok", stored_in: where, user: me.displayName, email: me.mail });
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

// The off switch. Clears BOTH stores, then names the only action that revokes
// the token at Microsoft — deleting a local copy does not.
async function cmdTokenLogout() {
  const hadKeychain = Boolean(keychainGet());
  const clearedKeychain = hadKeychain ? keychainClear() : false;
  let removedFile = false;
  if (existsSync(META_FILE)) {
    unlinkSync(META_FILE);
    removedFile = true;
  }
  _accessToken = null;

  out({
    status: "logged_out",
    keychain_entry_cleared: clearedKeychain,
    keychain_entry_found: hadKeychain,
    credentials_file_deleted: removedFile,
    credentials_file: META_FILE,
  });
  console.error("");
  console.error(
    "Local credentials are gone. The refresh token is STILL VALID at Microsoft until you revoke it:",
  );
  console.error(`  ${REVOKE_URL}   →  "Sign out everywhere"`);
  console.error(
    "  (Entra ID admins can also revoke sessions for the account from the Microsoft Entra admin center.)",
  );
}

async function cmdTokenTest() {
  const me = await graphGet("/me?$select=displayName,mail,userPrincipalName");
  out({ status: "ok", user: me.displayName, email: me.mail || me.userPrincipalName });
}

async function cmdMe() {
  const me = await graphGet(
    "/me?$select=displayName,mail,userPrincipalName,jobTitle,department,officeLocation,mobilePhone,businessPhones",
  );
  out(me);
}

async function cmdTeams() {
  const data = await graphGet("/me/joinedTeams?$select=id,displayName,description");
  out(
    (data.value || []).map((t) => ({
      id: t.id,
      name: t.displayName,
      description: t.description,
    })),
  );
}

async function cmdChats(args) {
  const top = parseInt(args.flags.top) || 20;
  const data = await graphGet(
    `/me/chats?$top=${top}&$expand=members($select=displayName)&$orderby=lastMessagePreview/createdDateTime desc&$select=id,topic,chatType,lastMessagePreview,createdDateTime`,
  );
  out(
    (data.value || []).map((c) => ({
      id: c.id,
      type: c.chatType,
      topic: c.topic || c.members?.map((m) => m.displayName).join(", "),
      lastMessage: c.lastMessagePreview?.body?.content?.replace(/<[^>]*>/g, "").slice(0, 100),
      lastDate: c.lastMessagePreview?.createdDateTime?.slice(0, 19).replace("T", " "),
      members: c.members?.map((m) => m.displayName),
    })),
  );
}

async function cmdChatMessages(args) {
  const chatId = args._[0];
  if (!chatId) {
    console.error("Usage: teams chat <chatId> [--top N]");
    process.exit(1);
  }
  const top = parseInt(args.flags.top) || 30;

  const data = await graphGet(
    `/me/chats/${safeId(chatId, "chatId")}/messages?$top=${top}&$orderby=createdDateTime desc`,
  );
  out((data.value || []).map(formatMsg));
}

async function cmdChatSend(args) {
  const chatId = args._[0];
  const message = args.flags.message;
  if (!chatId || !message) {
    console.error("Usage: teams chat-send <chatId> --message <text> --yes");
    process.exit(1);
  }
  assertSendAllowed(args, "send a chat message");

  const result = await graphPost(`/me/chats/${safeId(chatId, "chatId")}/messages`, {
    body: { content: message, contentType: "text" },
  });
  out({ status: "sent", id: result.id, date: result.createdDateTime });
}

async function cmdChannels(args) {
  const teamId = args._[0];
  if (!teamId) {
    console.error("Usage: teams channels <teamId>");
    process.exit(1);
  }

  const data = await graphGet(
    `/teams/${safeId(teamId, "teamId")}/channels?$select=id,displayName,description,membershipType`,
  );
  out(
    (data.value || []).map((c) => ({
      id: c.id,
      name: c.displayName,
      description: c.description,
      type: c.membershipType,
    })),
  );
}

async function cmdChannelMessages(args) {
  const teamId = args._[0];
  const channelId = args._[1];
  if (!teamId || !channelId) {
    console.error("Usage: teams channel <teamId> <channelId> [--top N]");
    process.exit(1);
  }
  const top = parseInt(args.flags.top) || 20;

  const data = await graphGet(
    `/teams/${safeId(teamId, "teamId")}/channels/${safeId(channelId, "channelId")}/messages?$top=${top}`,
  );
  out((data.value || []).map(formatMsg));
}

async function cmdChannelSend(args) {
  const teamId = args._[0];
  const channelId = args._[1];
  const message = args.flags.message;
  if (!teamId || !channelId || !message) {
    console.error("Usage: teams channel-send <teamId> <channelId> --message <text> --yes");
    process.exit(1);
  }
  assertSendAllowed(args, "post to a channel");

  const result = await graphPost(
    `/teams/${safeId(teamId, "teamId")}/channels/${safeId(channelId, "channelId")}/messages`,
    {
      body: { content: message, contentType: "text" },
    },
  );
  out({ status: "sent", id: result.id, date: result.createdDateTime });
}

async function cmdPresence(args) {
  const userId = args.flags["user-id"];
  const path = userId ? `/users/${safeId(userId, "user-id")}/presence` : "/me/presence";
  const data = await graphGet(path);
  out({
    availability: data.availability,
    activity: data.activity,
    statusMessage: data.statusMessage?.message?.content,
  });
}

async function cmdUsers(args) {
  const top = parseInt(args.flags.top) || 25;
  const search = args.flags.search;
  // SAFETY: an unfiltered listing is a bulk read of your org's directory.
  if (!search && args.flags.yes !== true && args.flags.yes !== "true") {
    console.error(
      "Refusing an unfiltered org directory dump. Pass --search <name>, or --yes to accept a bulk read.",
    );
    process.exit(1);
  }

  let url = `/users?$top=${top}&$select=id,displayName,mail,jobTitle,department,officeLocation`;
  if (search) url += `&$search=${encodeURIComponent(`"displayName:${search}"`)}`;

  // Search requires ConsistencyLevel header
  const target = assertAllowedUrl(`${GRAPH}${url}`);
  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (search) headers["ConsistencyLevel"] = "eventual";

  const resp = await fetch(target, { headers });
  if (!resp.ok) throw new Error(`Graph ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();

  out(
    (data.value || []).map((u) => ({
      id: u.id,
      name: u.displayName,
      email: u.mail,
      title: u.jobTitle,
      department: u.department,
      office: u.officeLocation,
    })),
  );
}

async function cmdActivity(args) {
  const top = parseInt(args.flags.top) || 20;
  // Activity feed requires beta API
  try {
    const data = await graphGet(`/me/teamwork/installedApps?$expand=teamsApp`, true);
    out({ note: "Activity feed listed installed apps", count: data.value?.length });
  } catch {
    // Fallback: list recent notifications
    console.error("Activity feed requires specific permissions. Showing recent chats instead.");
    await cmdChats({ _: [], flags: { top: String(top) } });
  }
}

async function cmdCalendar(args) {
  const days = parseInt(args.flags.days) || 7;
  const start = new Date().toISOString();
  const end = new Date(Date.now() + days * 86400000).toISOString();

  const data = await graphGet(
    `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$top=50&$select=subject,start,end,location,organizer,isAllDay,isCancelled,showAs,isOnlineMeeting,onlineMeeting&$orderby=start/dateTime`,
  );
  out(
    (data.value || []).map((e) => ({
      subject: e.subject,
      start: e.start?.dateTime?.slice(0, 16),
      end: e.end?.dateTime?.slice(0, 16),
      location: e.location?.displayName,
      organizer: e.organizer?.emailAddress?.address,
      isAllDay: e.isAllDay,
      showAs: e.showAs,
      isOnlineMeeting: e.isOnlineMeeting,
      joinUrl: e.onlineMeeting?.joinUrl,
    })),
  );
}

async function cmdSearch(args) {
  const query = args._[0];
  if (!query) {
    console.error('Usage: teams search "<query>"');
    process.exit(1);
  }

  // Use /search/query endpoint
  const result = await graphPost("/search/query", {
    requests: [
      {
        entityTypes: ["chatMessage"],
        query: { queryString: query },
        from: 0,
        size: 25,
      },
    ],
  });

  const hits = result.value?.[0]?.hitsContainers?.[0]?.hits || [];
  out(
    hits.map((h) => ({
      summary: h.summary,
      from: h.resource?.from?.emailAddress?.name,
      date: h.resource?.createdDateTime,
      body: h.resource?.body?.content?.replace(/<[^>]*>/g, "").slice(0, 200),
    })),
  );
}

// ─── Router ───
const args = parseArgs(process.argv.slice(2));
// `--logout` / `--revoke` anywhere on the line is the documented off switch.
if (args.flags.logout || args.flags.revoke) {
  args._ = ["token", "logout"];
}
const [cmd, sub, ...rest] = args._;
const subArgs = { _: sub ? [sub, ...rest] : rest, flags: args.flags };

try {
  switch (cmd) {
    case "token":
      if (sub === "extract-browser") await cmdTokenExtractBrowser();
      else if (sub === "store") await cmdTokenStore({ _: rest, flags: args.flags });
      else if (sub === "test") await cmdTokenTest();
      else if (sub === "logout" || sub === "revoke") await cmdTokenLogout();
      else console.error("Usage: teams token [extract-browser|store|test|logout]");
      break;
    case "me":
      await cmdMe();
      break;
    case "teams":
      await cmdTeams();
      break;
    case "chats":
      await cmdChats(subArgs);
      break;
    case "chat":
      await cmdChatMessages(subArgs);
      break;
    case "chat-send":
      await cmdChatSend(subArgs);
      break;
    case "channels":
      await cmdChannels(subArgs);
      break;
    case "channel":
      await cmdChannelMessages(subArgs);
      break;
    case "channel-send":
      await cmdChannelSend(subArgs);
      break;
    case "presence":
      await cmdPresence(subArgs);
      break;
    case "users":
      await cmdUsers(subArgs);
      break;
    case "activity":
      await cmdActivity(subArgs);
      break;
    case "calendar":
      await cmdCalendar(subArgs);
      break;
    case "search":
      await cmdSearch(subArgs);
      break;
    default:
      console.log(`teams — Microsoft Teams via Graph API

Token (stored in the OS keychain; 0600 file only if no keychain exists):
  token extract-browser              Print JS to extract token from Teams tab
  token store [--tenant-id <id>]     Store it — token is read from STDIN, never argv
  token test                         Verify token works
  token logout                       Clear keychain + file, print the revoke URL

Messaging:
  chats [--top 20]                   List recent chats
  chat <chatId> [--top 30]           Read chat messages
  chat-send <chatId> --message <txt> --yes   Send (needs TEAMS_ALLOW_SEND=1)
  search "<query>"                   Search messages

Teams & Channels:
  teams                              List joined teams
  channels <teamId>                  List channels
  channel <teamId> <channelId>       Read channel messages
  channel-send <teamId> <channelId> --message <txt> --yes

People & Status:
  me                                 Your profile
  users --search X [--top 25]        Search org directory (--yes for an unfiltered dump)
  presence [--user-id <id>]          Presence status

Calendar:
  calendar [--days 7]                Upcoming meetings

Consent:
  TEAMS_ALLOW_SEND=1                 Required before any message can be sent
  --yes                              Required per send, and per unfiltered user listing

Off switch:
  teams token logout                 Deletes local credentials, prints ${REVOKE_URL}`);
      break;
  }
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
