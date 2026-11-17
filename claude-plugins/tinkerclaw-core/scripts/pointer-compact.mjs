#!/usr/bin/env node
/**
 * Claude Code PreCompact + SessionStart (compact) hook: make the claude CLI's own compaction leave a
 * pointer instead of a story (J1 §5, "Compaction That Leaves Pointers").
 *
 * FORK 2026-11-03 — on the claude-code lane the gateway cannot evict: the CLI keeps its own
 * transcript and resumes it, so the only compaction that shrinks what the model reads is the CLI's,
 * and by default it writes a narrative summary (context-window-panel.md F1/F2). One script, two
 * events, turns that summary into a J1 marker:
 *   - PreCompact (manual | auto): the CLI appends this hook's stdout to its compaction instructions
 *     on exit 0. Exit 2 would BLOCK the compaction, so this script never exits 2. The instructions ask
 *     for the marker's fields in J1 §5.1's order and forbid narrative.
 *   - SessionStart, source "compact": the pointer. The CLI keeps every compacted entry in the same
 *     JSONL transcript, before its compact_boundary line, so the record is still whole on disk; this
 *     names that file so the model searches it instead of rebuilding a detail from the summary.
 *     Silent when the input names no transcript file that exists: no record, no pointer.
 *     delivery-parts.test.ts runs every SessionStart command with no transcript and expects silence.
 *
 * Fails open: any error prints nothing and exits 0, and the CLI compacts as it would have.
 * No dependencies, by design: it runs on every compaction.
 */
import fs from "node:fs";
import { claim, harnessSide, readStdin } from "./hook-common.mjs";

const OPEN = '<compaction_pointer source="tinkerclaw-core">';
const CLOSE = "</compaction_pointer>";

/** Appended to the CLI's compaction instructions: J1 §5.1's marker, field by field. */
const MARKER_INSTRUCTIONS = `Write this summary as a pointer marker, not a narrative. Every compacted message stays on disk word for word, so the summary only keeps what the next turn needs to act and to search with. Use these sections in this order and skip any that would be empty:
1. Range: which part of the conversation this covers, first and last request.
2. The user's words: every instruction, preference and correction the user gave, quoted verbatim. Never paraphrase them.
3. Exact strings: file paths, commit hashes, IDs, host names, URLs, numbers and error lines, copied character for character, most-used first.
4. Decisions and failed attempts: one line each ("chose X over Y", "tried Z: failed with E"), each carrying the exact command or error text.
5. Open items: what was started and not finished, one line each.
6. Current task: one line on what the user asked for last and where it stands.
Leave out the assistant's reasoning, its replies and tool output: the record keeps them. No line about mood or progress ("good progress was made"); every line is a quote or points at one.`;

/** The pointer shown after a compaction: where the full record is and how to search it. */
function pointer(transcriptPath, side) {
  const recall =
    side === "worker"
      ? " In a TinkerClaw chat the recall tool also searches the gateway's copy of this conversation."
      : "";
  return `${OPEN}
The conversation before this point was compacted. The summary is a pointer, not the record. Every compacted message is still on disk, word for word, in this session's transcript:
${transcriptPath}
It is JSONL, one entry per line; the compacted entries come before the last line whose subtype is "compact_boundary". When you need an exact earlier detail (a path, a command, an error, what the user said), search that file for a string from the summary, for example grep -n "<string>" "${transcriptPath}", instead of rebuilding it from the summary.${recall}
${CLOSE}`;
}

try {
  const input = readStdin();
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (input.hook_event_name === "PreCompact") {
    if (claim("pointer-compact", sessionId, `pre-${input.trigger ?? "unknown"}`, 1)) {
      process.stdout.write(MARKER_INSTRUCTIONS);
    }
  } else if (input.hook_event_name === "SessionStart" && input.source === "compact") {
    const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
    if (
      transcript &&
      fs.existsSync(transcript) &&
      claim("pointer-compact", sessionId, "compact", 1)
    ) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: pointer(transcript, harnessSide()),
          },
        }),
      );
    }
  }
} catch {
  // fail open: the CLI compacts exactly as it would without this hook
}
process.exit(0);
