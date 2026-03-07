import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type SessionResumePayload = {
  ts: number;
  sessionKey: string;
  channel?: string;
  userMessage: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
};

export type SessionResume = {
  version: 1;
  payload: SessionResumePayload;
};

const RESUME_FILENAME = "session-resume.json";

export function resolveSessionResumePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), RESUME_FILENAME);
}

export async function writeSessionResume(
  payload: SessionResumePayload,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveSessionResumePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: SessionResume = { version: 1, payload };
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function clearSessionResume(
  _sessionKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const filePath = resolveSessionResumePath(env);
  await fs.unlink(filePath).catch(() => {});
}

export async function consumeSessionResume(
  ttlSeconds = 60,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionResume | null> {
  const filePath = resolveSessionResumePath(env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  // Always remove the file once read
  await fs.unlink(filePath).catch(() => {});

  let parsed: SessionResume | undefined;
  try {
    parsed = JSON.parse(raw) as SessionResume | undefined;
  } catch {
    return null;
  }

  if (!parsed || parsed.version !== 1 || !parsed.payload) {
    return null;
  }

  // TTL check — if too old, discard
  if (Date.now() - parsed.payload.ts > ttlSeconds * 1000) {
    return null;
  }

  return parsed;
}
