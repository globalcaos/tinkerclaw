// Pure per-spawn budget evaluator for the embedded-agent run loop.
// Returns true when a spawn has met-or-exceeded EITHER its token budget
// or its tool-call budget. Undefined caps are treated as "no limit".
//
// Kept side-effect free so it is trivially table-tested (no mocks) and can be
// called on every tool-result / assistant-message-start tick by attempt.ts.
export function evaluateSpawnBudget(s: {
  total: number;
  toolCalls: number;
  maxTokens?: number;
  maxToolCalls?: number;
}): boolean {
  return (
    (typeof s.maxTokens === "number" && s.total >= s.maxTokens) ||
    (typeof s.maxToolCalls === "number" && s.toolCalls >= s.maxToolCalls)
  );
}
