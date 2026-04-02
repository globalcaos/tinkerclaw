export type AuthProfileConfig = {
  provider: string;
  /**
   * Credential type expected in auth-profiles.json for this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   */
  mode: "api_key" | "oauth" | "token";
  email?: string;
  /**
   * FORK: Path to an external JSON file containing credentials for this profile.
   * Supports `~` expansion. When set, credentials are read from this file instead
   * of the default auth-profiles.json store (used for Claude Code credential sync).
   */
  credentialFile?: string;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for overloaded
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    overloadedProfileRotations?: number;
    /**
     * Fixed delay before retrying an overloaded provider/profile rotation.
     * Default: 0.
     */
    overloadedBackoffMs?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for rate-limit
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    rateLimitedProfileRotations?: number;
  };
};
