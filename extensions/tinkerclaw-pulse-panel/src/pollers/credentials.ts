/**
 * FORK: tinkerclaw-pulse-panel — poller credential access.
 *
 * Pollers used to read well-known paths inside OTHER applications' config
 * directories (~/.config/gcloud, ~/.config/moltbook, ~/.config/youtube-cli).
 * That made a metrics panel a reader of unrelated credential stores by default,
 * which is not something an operator asks for by installing a graph tab.
 *
 * Now every credential is operator-supplied through plugin config (no
 * environment variables are read) and an unconfigured poller is SKIPPED rather than
 * falling back to a guessed location. `PollerNotConfiguredError` is the signal
 * for that: the poll loop treats it as a quiet skip, not a failure.
 */
import fs from "node:fs";
import type { PollerCredentialConfig } from "../paths.js";

/** Thrown when a poller has no credential configured. Quiet skip, not an error. */
export class PollerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollerNotConfiguredError";
  }
}

let CREDENTIALS: PollerCredentialConfig = {};

/** Install the resolved credentials. Called once from startPollerSubsystem. */
export function configurePollerCredentials(creds: PollerCredentialConfig): void {
  CREDENTIALS = creds;
}

/** Optional GitHub token; undefined means "call the public endpoints anonymously". */
export function githubToken(): string | undefined {
  return CREDENTIALS.githubToken;
}

/** Read a configured credential file, or throw PollerNotConfiguredError. */
export function readCredentialFile(
  which: keyof Omit<PollerCredentialConfig, "githubToken">,
): string {
  const filePath = CREDENTIALS[which];
  if (!filePath) {
    throw new PollerNotConfiguredError(
      `pulse-panel: no credential configured for "${which}" — set plugins.tinkerclaw-pulse-panel.credentials.${which}`,
    );
  }
  return fs.readFileSync(filePath, "utf8");
}
