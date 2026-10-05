/**
 * FORK 2026-09-25 (TINKER_UI_DESIGN_BIBLE/context-window-panel.md §6.1 A6 (i), §6.0 c) — a turn
 * whose user text IS a claude CLI command reaches the CLI as that command, and nothing else.
 *
 * WHY. On the claude-code lane the model reads the CLI's own transcript, so the only compaction that
 * shrinks its context is the CLI's (F2). The CLI registers `/compact` as a `local` command with
 * `supportsNonInteractive: true` and the argument hint `<optional custom summarization
 * instructions>` (read out of the installed CLI, §6.0 c). It runs a slash command only when the user
 * line STARTS with it, and takes everything after the name as the summarization instructions. So
 * whatever this fork puts around the owner's `/compact` decides whether it compacts at all (the
 * moral-code prefix, worker.ts, moves the slash off position 0) and what it summarises by (the UI's
 * fractal doctrine, or the bridge's chat-row contract, would become the instructions).
 *
 * THE WRAPPERS, each read from its producer and removed by an exact rule:
 *   1. the gateway's stamp `[Fri 2026-09-25 10:00 GMT+2] ` (injectTimestamp,
 *      src/gateway/server-methods/agent-timestamp.ts: chat.send, the agent RPC, the TUI), matched by
 *      core's own strip regex (LEADING_TIMESTAMP_PREFIX_RE, src/auto-reply/reply/strip-inbound-meta.ts);
 *   2. a block appended after a `---` rule (the Tinker UI's fractal doctrine or briefing, from
 *      tinker-ui/src/app.ts buildInjectedPrompt, or a matched recipe), cut only when RECOGNISED by the
 *      sentinels the UI itself classifies such blocks by (tinker-ui/src/injected-prompt.ts), never
 *      merely because it follows a `---`;
 *   3. this bridge's own chat-row contract (stream.ts NARRATION_USER_DIRECTIVE), from the marker
 *      exported below, which stream.ts writes, so the literal exists once.
 * Measured 2026-09-25 on the 12 latest human-typed Tinker rows of the gateway transcripts: each is
 * `[<Dow> <stamp>] <typed text>` + exactly one `---` + the fractal doctrine, with nothing after it.
 *
 * THE RULE THAT OUTRANKS COVERAGE. `/compact` rewrites the owner's context, so every branch is
 * biased to null, and null is today's behaviour (the text reaches the model as prose):
 *   - a CLOSED allowlist of one command; every other slash text stays prose;
 *   - a `---` rule that SURVIVES the unwrapping is a block this module does not recognise, so the
 *     turn is refused rather than handing an unknown block to the CLI as instructions;
 *   - nothing is stripped that this fork did not put around text the owner typed into this
 *     session: a channel envelope (`[WhatsApp …]`), inbound-metadata blocks, a provenance receipt
 *     or an `⟦AGENT⟧` marker stay, so text another agent or channel sent never compacts his context.
 * The grammar follows the gateway's own `/compact` handler (src/auto-reply/reply/commands-compact.ts):
 * any case, an optional `:` after the name, instructions to the end of the text.
 *
 * Pure and dependency-free. worker.ts (the stdin line; steer's refusal) and stream.ts (skip the
 * chat-row contract, spare the fast-fail, word the outcome) all ask this one predicate.
 */

/** The closed set of CLI commands a turn may carry. Widen it only with a reason in the bible (A6). */
const CLI_COMMAND_NAMES: ReadonlySet<string> = new Set(["compact"]);

/** Opens the chat-row contract stream.ts appends to every prose turn (NARRATION_USER_DIRECTIVE). */
export const CHAT_ROW_CONTRACT_MARKER = "<!-- TINKERCLAW chat-row contract -->";

/** The injectTimestamp stamp, `[<Dow> YYYY-MM-DD HH:MM <TZ>] ` — core's own strip regex. */
const LEADING_TIMESTAMP_STAMP = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;

/**
 * The rule an injector writes before its block, as leniently as the UI matches it
 * (tinker-ui/src/injected-prompt.ts SEPARATOR). The /g twin is only ever driven by exec from
 * lastIndex 0; the plain twin answers "is one left?".
 */
const SEPARATOR_ALL = /\n[ \t]*-{3,}[ \t]*\n/g;
const SEPARATOR = /\n[ \t]*-{3,}[ \t]*\n/;

/** What marks an appended block as machine-authored: the UI's own labels (injected-prompt.ts). */
const INJECTED_BLOCK_SENTINELS = [
  "append a \u{1F33F} FRACTAL reflection section",
  "FRACTAL reflection section",
  "Structure this turn's reply as labelled sections",
  "Execute the morning briefing NOW",
  "Read and follow whichever of these briefing files exists",
];
const INJECTED_BLOCK_PATTERNS = [
  /<active_recipe\b/,
  /\bkind:\s*["']?(?:kit|recipe)\/1\.0/,
  /^\s*#{1,3}\s*RECIPE\b/im,
  /\bBROCA recipe\b/i,
];

function isInjectedBlock(block: string): boolean {
  return (
    INJECTED_BLOCK_SENTINELS.some((sentinel) => block.includes(sentinel)) ||
    INJECTED_BLOCK_PATTERNS.some((pattern) => pattern.test(block)) ||
    block.trimStart().startsWith("[System]")
  );
}

/** Where the LAST recognised block begins (its `---` rule), or null. Tried last-first, as the UI does. */
function lastInjectedCut(text: string): number | null {
  const cuts: Array<{ index: number; end: number }> = [];
  SEPARATOR_ALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEPARATOR_ALL.exec(text)) !== null) {
    cuts.push({ index: match.index, end: match.index + match[0].length });
  }
  for (let i = cuts.length - 1; i >= 0; i--) {
    if (isInjectedBlock(text.slice(cuts[i].end))) {
      return cuts[i].index;
    }
  }
  return null;
}

/** Cut every trailing recognised block, one at a time, so stacked injections all come off. */
function stripInjectedBlocks(text: string): string {
  let body = text;
  let cut = lastInjectedCut(body);
  while (cut !== null) {
    body = body.slice(0, cut);
    cut = lastInjectedCut(body);
  }
  return body;
}

/**
 * The CLI command line this turn's user text IS — `/compact`, or `/compact <instructions>` with the
 * owner's own instructions — or null when it is anything else. The injected doctrine and the
 * chat-row contract are never carried through as instructions. Idempotent: worker.ts asks again on
 * the bare line stream.ts already unwrapped.
 */
export function extractCliCommand(userText: unknown): string | null {
  if (typeof userText !== "string" || userText.length === 0) {
    return null;
  }
  let body = userText.trim().replace(LEADING_TIMESTAMP_STAMP, "");
  const contract = body.lastIndexOf(CHAT_ROW_CONTRACT_MARKER);
  if (contract !== -1) {
    body = body.slice(0, contract);
  }
  body = stripInjectedBlocks(body).trim();
  if (SEPARATOR.test(body)) {
    return null;
  }
  const head = /^\/([A-Za-z][\w-]*)/.exec(body);
  if (!head) {
    return null;
  }
  const name = head[1].toLowerCase();
  if (!CLI_COMMAND_NAMES.has(name)) {
    return null;
  }
  let rest = body.slice(head[0].length);
  if (rest !== "" && !/^[\s:]/.test(rest)) {
    return null;
  }
  rest = rest.trimStart();
  if (rest.startsWith(":")) {
    rest = rest.slice(1).trimStart();
  }
  rest = rest.trimEnd();
  return rest ? `/${name} ${rest}` : `/${name}`;
}

/**
 * What stream.ts heard of the CLI's compaction during a command turn: the A1 `end` event of
 * createCompactionLineReader, structurally (this module imports nothing).
 */
export type CliCompactionEnd = {
  completed: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
};

/**
 * The one visible line a command turn answers with. The CLI answers `/compact` with protocol lines
 * and at most a short status text, possibly none, and a text-less assistant message is not a
 * successful turn downstream: the embedded runner reads it as an EMPTY RESPONSE
 * (src/agents/embedded-agent-runner/run/incomplete-turn.ts), re-prompts the model to produce a
 * visible answer (a full turn on the context that was just compacted) and then shows "Agent
 * couldn't generate a response". So the turn always gets one line, built only from what the CLI
 * itself reported: the boundary's own figures, else its result text, else the honest absence of
 * both. Nothing is estimated, and a figure the boundary did not carry is not claimed.
 *
 * `/compact` is the only allowlisted command, so the wording is compaction's; a new command in the
 * allowlist needs its own arm here.
 */
export function describeCliCommandOutcome(args: {
  command: string;
  compaction: CliCompactionEnd | null;
  resultText: string;
  isError: boolean;
}): string {
  const said = args.resultText.trim();
  const name = args.command.split(/\s/, 1)[0];
  const end = args.compaction;
  if (end?.completed) {
    const figures: string[] = [];
    if (end.tokensBefore !== undefined && end.tokensAfter !== undefined) {
      figures.push(
        `${formatTokenCount(end.tokensBefore)} → ${formatTokenCount(end.tokensAfter)} tokens`,
      );
    } else if (end.tokensBefore !== undefined) {
      figures.push(`${formatTokenCount(end.tokensBefore)} tokens before`);
    }
    if (end.durationMs !== undefined) {
      figures.push(formatDuration(end.durationMs));
    }
    return `⚙️ Compacted the Claude CLI's context${figures.length > 0 ? ` (${figures.join(", ")})` : ""}.`;
  }
  if (end) {
    return said
      ? `⚙️ The Claude CLI's compaction failed: ${said}`
      : "⚙️ The Claude CLI's compaction failed.";
  }
  if (said) {
    return `⚙️ ${name}: ${said}`;
  }
  return args.isError
    ? `⚙️ ${name} failed in the Claude CLI, which returned no detail.`
    : `⚙️ ${name} finished, but the Claude CLI reported no compaction.`;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(count);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
