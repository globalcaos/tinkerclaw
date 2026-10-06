import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTurnOutcome, type TurnOutcome } from "../fork/turn-outcome.js";
import {
  __claudeCliTranscriptCacheTesting as cache,
  readClaudeCliSessionMessages,
} from "./cli-session-history.claude.js";

/**
 * FORK 2026-09-29 — typed outcomes for Claude CLI failure rows (plan:
 * 2026-09-29-chat-usage-chips-and-typed-outcomes.md, unit U4).
 *
 * The CLI writes a failed turn as a SYNTHETIC assistant row whose typed fields
 * (`isApiErrorMessage`, `error`, `apiErrorStatus`) sit at the TOP level of the
 * JSONL entry, and a refused turn as `message.stop_reason:"refusal"` with
 * `message.stop_details`. Both used to import as ordinary answers, so 1,457
 * `isApiErrorMessage` rows and 23 refusal stop reasons (7 of them on those same
 * rows) in ~/.claude/projects rendered as plain replies after a reload (census
 * 2026-09-29, every row JSON-parsed).
 *
 * Fixtures are the REAL strings from that census, not synthetic tokens. Two of
 * them are the whole point of the unit: "You've hit your weekly limit · resets
 * 6pm" and "Failed to authenticate: OAuth session expired" both classify as a
 * plain `error` from their prose alone (measured), so the structured `error`
 * code has to win.
 */

const ORIGINAL_HOME = process.env.HOME;
const TS = "2026-09-29T09:00:00.000Z";

let root = "";
let homeDir = "";
let projectsDir = "";

function apiErrorLine(opts: {
  uuid: string;
  error: string;
  text: string;
  apiErrorStatus?: number | null;
  stopReason?: string;
}): string {
  return JSON.stringify({
    parentUuid: "00000000-0000-4000-8000-0000000000aa",
    isSidechain: false,
    type: "assistant",
    uuid: opts.uuid,
    timestamp: TS,
    requestId: `req_${opts.uuid}`,
    error: opts.error,
    isApiErrorMessage: true,
    apiErrorStatus: opts.apiErrorStatus ?? null,
    message: {
      id: `msg_${opts.uuid}`,
      model: "<synthetic>",
      role: "assistant",
      type: "message",
      stop_reason: opts.stopReason ?? "stop_sequence",
      content: [{ type: "text", text: opts.text }],
    },
  });
}

function refusalLine(uuid: string, answer: string, explanation: string): string {
  return JSON.stringify({
    isSidechain: false,
    type: "assistant",
    uuid,
    timestamp: TS,
    message: {
      id: `msg_${uuid}`,
      model: "claude-opus-5",
      role: "assistant",
      type: "message",
      content: [{ type: "text", text: answer }],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation },
    },
  });
}

function assistantLine(uuid: string, text: string): string {
  return JSON.stringify({
    isSidechain: false,
    type: "assistant",
    uuid,
    timestamp: TS,
    message: {
      id: `msg_${uuid}`,
      model: "claude-opus-5",
      role: "assistant",
      type: "message",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
  });
}

function userLine(uuid: string, text: string): string {
  return JSON.stringify({
    isSidechain: false,
    type: "user",
    uuid,
    timestamp: TS,
    message: { role: "user", content: text },
  });
}

function metaLine(uuid: string, text: string): string {
  return JSON.stringify({
    isSidechain: false,
    isMeta: true,
    type: "user",
    uuid,
    timestamp: TS,
    message: { role: "user", content: text },
  });
}

type Served = Record<string, unknown>;

function readTranscript(sessionId: string, lines: string[]): Served[] {
  fs.writeFileSync(path.join(projectsDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf-8");
  cache.reset();
  return readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir }) as Served[];
}

function outcomeOf(message: Served): TurnOutcome {
  expect(isTurnOutcome(message.outcome)).toBe(true);
  return message.outcome as TurnOutcome;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-history-outcome-"));
  homeDir = path.join(root, "home");
  projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  fs.mkdirSync(projectsDir, { recursive: true });
  process.env.HOME = homeDir;
  cache.reset();
});

afterEach(() => {
  cache.reset();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("claude-cli import — isApiErrorMessage rows become typed outcomes", () => {
  it("rate_limit: the structured code wins over prose that carries no keyword", () => {
    const text = "You've hit your weekly limit · resets 6pm (Europe/Madrid)";
    // The whole reason the `error` code has to win: this copy matches nothing.
    expect(text).not.toMatch(/rate.?limit|\b429\b|too many requests/i);

    const [message] = readTranscript("sess-rate-limit", [
      apiErrorLine({ uuid: "err-rate", error: "rate_limit", text, apiErrorStatus: 429 }),
    ]);
    expect(message.role).toBe("assistant");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(text);

    const outcome = outcomeOf(message);
    expect(outcome.kind).toBe("rate_limit");
    // FORK 2026-10-05: the code names the kind; the prose names the WEEKLY window, which no
    // retry can outlast (src/shared/usage-window.ts). Marked recoverable, this row re-armed the
    // client ladder and one prompt was re-sent 169 times on 2026-10-03.
    expect(outcome.recoverable).toBe(false);
    expect(outcome.retryAfter).toBeUndefined();
    expect(outcome.headline).toBe("Rate limited");
    expect(outcome.detail).toBe(text);
    expect(outcome.source).toBe("cli");
  });

  it("rate_limit: the reset clock is parsed although the prose is not rate-limit-shaped", () => {
    // A burst limit, which a retry can outlast. (Until 2026-10-05 this fixture read "weekly limit ·
    // Try again in 30 seconds", a window that cannot clear in 30 s.)
    const [message] = readTranscript("sess-rate-limit-retry", [
      apiErrorLine({
        uuid: "err-retry",
        error: "rate_limit",
        text: "You've hit your limit · Try again in 30 seconds.",
        apiErrorStatus: 429,
      }),
    ]);
    expect(outcomeOf(message).recoverable).toBe(true);
    expect(outcomeOf(message).retryAfter).toBe(30);
  });

  it("authentication_failed: the code wins over prose the auth rule cannot match", () => {
    const text = "Failed to authenticate: OAuth session expired and could not be refreshed";
    const [message] = readTranscript("sess-auth", [
      apiErrorLine({ uuid: "err-auth", error: "authentication_failed", text }),
    ]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(text);

    const outcome = outcomeOf(message);
    expect(outcome.kind).toBe("auth");
    expect(outcome.recoverable).toBe(false);
    expect(outcome.headline).toBe("Authentication failed");
    expect(outcome.retryAfter).toBeUndefined();
  });

  it("billing_error: code and prose agree", () => {
    const text = "Credit balance is too low";
    const [message] = readTranscript("sess-billing", [
      apiErrorLine({ uuid: "err-bill", error: "billing_error", text, apiErrorStatus: 400 }),
    ]);
    expect(message.stopReason).toBe("error");
    const outcome = outcomeOf(message);
    expect(outcome.kind).toBe("billing");
    expect(outcome.recoverable).toBe(false);
    expect(outcome.headline).toBe("Billing problem");
  });

  it("safeguards: an invalid_request row that stopped on refusal is a refusal", () => {
    const text =
      "API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). " +
      "Claude Code can't respond to this message with Opus 5.";
    const [message] = readTranscript("sess-safeguards", [
      apiErrorLine({
        uuid: "err-safeguards",
        error: "invalid_request",
        text,
        stopReason: "refusal",
      }),
    ]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(text);
    const outcome = outcomeOf(message);
    expect(outcome.kind).toBe("refusal");
    expect(outcome.recoverable).toBe(false);
    expect(outcome.headline).toBe("The model refused to answer");
  });

  it("model_not_found maps to the generic error kind, not a guessed one", () => {
    const text =
      "There's an issue with the selected model (not-a-model-xyz). It may not exist or you may " +
      "not have access to it. Run --model to pick a different model.";
    const [message] = readTranscript("sess-model", [
      apiErrorLine({ uuid: "err-model", error: "model_not_found", text, apiErrorStatus: 404 }),
    ]);
    expect(message.stopReason).toBe("error");
    const outcome = outcomeOf(message);
    expect(outcome.kind).toBe("error");
    expect(outcome.recoverable).toBe(false);
  });

  it("an unmapped code falls through to the text classifier (529 → overload)", () => {
    const text =
      "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again " +
      "in a moment. If it persists, check https://status.claude.com.";
    const [message] = readTranscript("sess-server-error", [
      apiErrorLine({ uuid: "err-529", error: "server_error", text, apiErrorStatus: 529 }),
    ]);
    const outcome = outcomeOf(message);
    expect(outcome.kind).toBe("overload");
    expect(outcome.recoverable).toBe(true);
  });
});

describe("claude-cli import — refusal stop reasons", () => {
  it("keeps the partial answer and puts the block explanation in errorMessage", () => {
    const answer = "Loading the Outlook CLI and searching the last few days of mail.";
    const explanation =
      "This request triggered restrictions on violative cyber content and was blocked under " +
      "Anthropic's Usage Policy.";
    const [message] = readTranscript("sess-refusal", [refusalLine("ref-1", answer, explanation)]);

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe(explanation);
    // The answer that streamed before the block is untouched — the UI draws it
    // above the outcome bubble.
    expect(message.content).toEqual([{ type: "text", text: answer }]);

    const outcome = outcomeOf(message);
    expect(outcome.kind).toBe("refusal");
    expect(outcome.recoverable).toBe(false);
    expect(outcome.detail).toBe(explanation);
    expect(outcome.source).toBe("cli");
  });
});

describe("claude-cli import — every other row is unchanged", () => {
  it("a normal assistant answer carries no outcome and keeps its stop reason", () => {
    const served = readTranscript("sess-plain", [
      userLine("u-1", "hola"),
      metaLine("m-1", "injected skill body that must never render as a user bubble"),
      assistantLine("a-1", "Here is the answer. It mentions a rate limit in passing."),
    ]);

    expect(served).toHaveLength(2);
    expect(served[0].role).toBe("user");
    expect(served[0].outcome).toBeUndefined();

    const assistant = served[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.stopReason).toBe("end_turn");
    expect(assistant.errorMessage).toBeUndefined();
    expect(assistant.outcome).toBeUndefined();
    expect(assistant.provider).toBe("claude-cli");
  });
});
