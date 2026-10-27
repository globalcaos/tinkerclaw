export type SendTarget = Readonly<{ tabId: string; sessionKey: string }>;

/** Freeze the address of a send before any asynchronous prompt preparation can yield. */
export function captureSendTarget(tabId: string, sessionKey: string): SendTarget | null {
  if (!tabId || !sessionKey) {
    return null;
  }
  return Object.freeze({ tabId, sessionKey });
}

export function sendTargetIsActive(
  target: SendTarget,
  activeTabId: string,
  activeSessionKey: string,
  sessionKeysMatch: (a: string | undefined, b: string | undefined) => boolean,
): boolean {
  return target.tabId === activeTabId && sessionKeysMatch(target.sessionKey, activeSessionKey);
}
