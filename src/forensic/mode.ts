/**
 * Forensic mode — global toggle.
 * When enabled, the agent runner dumps the full LLM payload to disk
 * instead of calling the model, so you can inspect token usage.
 */

let enabled = false;

export function isForensicMode(): boolean {
  return enabled;
}

export function setForensicMode(value: boolean): void {
  enabled = value;
}
