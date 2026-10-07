/**
 * The Jev key file: where a token lives on disk, how setup writes it, and the one line that says what happens without it.
 *
 * Why a file and not config: `openclaw.json` can sit in a git repo with a remote, so a token there can be committed. The
 * key file is outside the config, owner-only, and the gateway re-reads it without a restart (see `availability.ts`).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { JEV_ENABLES, parseTokenText } from "./availability.js";

export function jevTokenFilePath(): string {
  return join(resolveStateDir(), "jev", "token");
}

/** A pasted token reduced to the bare value, or undefined when it is empty or not a single token. */
export function normalizeJevToken(input: string): string | undefined {
  const token = parseTokenText(input.trim());
  return token && !/\s/.test(token) ? token : undefined;
}

/** Writes the token owner-only (directory 0700, file 0600) and returns the path. */
export function writeJevTokenFile(token: string, path: string = jevTokenFilePath()): string {
  const clean = normalizeJevToken(token);
  if (!clean) {
    throw new Error("not a Jev token: expected one value without spaces");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${clean}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** What a setup that skipped the token step tells the owner. One line, no URL: the pointer is the owner's choice. */
export function jevDormantNote(tokenFile: string = jevTokenFilePath(), helpUrl?: string): string {
  const help = helpUrl ? ` Get a token: ${helpUrl}.` : "";
  return (
    `Jev is off: no token. ${JEV_ENABLES.join(", ")} stay off until one exists; everything else works. ` +
    `To turn it on, put the token in ${tokenFile} (picked up without a restart).${help}`
  );
}
