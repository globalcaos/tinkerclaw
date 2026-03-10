import type { FailoverReason } from "./pi-embedded-helpers.js";

export type ModelCandidate = {
  provider: string;
  model: string;
};

export type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
  failedProfileId?: string; // FORK: auth profile that triggered this fallback attempt
};
