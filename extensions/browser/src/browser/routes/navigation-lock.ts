import type { BrowserResponse } from "./types.js";

export const NAVIGATION_FORBIDDEN_REASON =
  "Programmatic navigation is disabled. The agent cannot change the URL of a tab. Ask the user to navigate via the Chrome extension if you need a different page, then resume.";

export interface NavigationForbiddenBody {
  status: "forbidden";
  action: "navigate" | "open";
  reason: string;
}

export function buildNavigationForbiddenBody(action: "navigate" | "open"): NavigationForbiddenBody {
  return {
    status: "forbidden",
    action,
    reason: NAVIGATION_FORBIDDEN_REASON,
  };
}

export function sendNavigationForbidden(res: BrowserResponse, action: "navigate" | "open"): void {
  res.status(403).json(buildNavigationForbiddenBody(action));
}
