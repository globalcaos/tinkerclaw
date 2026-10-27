// Pure, DOM-free: USER-ROLE ROWS THE HUMAN DID NOT WRITE.
//
// FORK 2026-09-23 (the architect: "In the work tab, I see an injection of the ethical rules
// as if it was my prompt … I have been seeing these long 'quasi prompts' and sometimes it is a
// recipe, sometimes something else").
//
// The model's input is a list of user/assistant turns, so everything the SYSTEM tells the model —
// the moral code a resumed Claude session receives, the summary that replaces a compacted
// conversation, the fractal triage judge's brief, a cron reminder, the WhatsApp reply-mode frame, a
// background-task notification — is stored as a USER turn. The claude-cli transcript import then
// serves it to the chat, and it rendered as a right-hand bubble in the human's voice. Measured on
// the bridge's own transcripts (7 days, 579 forwarded messages): 88 cron reminders, 35 fractal
// triage briefs, 34 reply-mode frames, 11 task notifications, 6 compaction summaries, and the
// 40,331-char moral code that opened this report.
//
// The role stays what it is (the model did read it as input); only the RENDERING changes, exactly
// as system-notice.ts does for the `[System]` restart wake-up: a labelled, collapsed card that says
// what the thing is and how big it is, with the full text one click away. Recognition is by the
// fixed opening each producer writes — never by length or by similarity to anything else.

export type InjectedContext = {
  /** Stable id of the producer, for the card's class and for tests. */
  kind:
    | "moral-code"
    | "compaction-summary"
    | "fractal-triage"
    | "scheduled-reminder"
    | "reply-mode"
    | "task-notification";
  /** Badge text: what this is, in the reader's terms. */
  label: string;
  /** One line a human needs. */
  headline: string;
  /** The full text as stored, shown only when expanded. */
  body: string;
};

type Rule = {
  kind: InjectedContext["kind"];
  label: string;
  test: (t: string) => boolean;
  headline: (t: string) => string;
};

const kchars = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k chars` : `${n} chars`;

const firstLine = (t: string): string => {
  const line = t.trim().split("\n", 1)[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
};

const MORAL_CODE_OPEN = '<moral_code source="tinkerclaw">';
const MORAL_CODE_CLOSE = "</moral_code>";

const RULES: Rule[] = [
  {
    kind: "moral-code",
    label: "🛡️ Moral code · sent to the model",
    test: (t) => t.startsWith(MORAL_CODE_OPEN),
    headline: (t) => {
      const end = t.indexOf(MORAL_CODE_CLOSE);
      const packLen = end < 0 ? t.length : end + MORAL_CODE_CLOSE.length;
      const tail = end < 0 ? "" : t.slice(packLen).trim();
      return tail
        ? `Delivered once to this Claude session (${kchars(packLen)}), ahead of the prompt above.`
        : `Delivered once to this Claude session (${kchars(packLen)}).`;
    },
  },
  {
    kind: "compaction-summary",
    label: "🗜️ Conversation summary · after compaction",
    test: (t) => t.startsWith("This session is being continued from a previous conversation"),
    headline: (t) =>
      `The model's summary of the earlier conversation, which replaced it in its context (${kchars(t.length)}).`,
  },
  {
    kind: "fractal-triage",
    label: "🌿 Fractal triage · reflection brief",
    test: (t) => t.startsWith("# FRACTAL TRIAGE"),
    headline: (t) => `${firstLine(t).replace(/^#\s*/, "")} (${kchars(t.length)})`,
  },
  {
    kind: "scheduled-reminder",
    label: "⏰ Scheduled reminder",
    test: (t) => t.startsWith("A scheduled reminder has been triggered"),
    headline: firstLine,
  },
  {
    kind: "reply-mode",
    label: "📨 Reply mode · message framing",
    test: (t) => t.startsWith("[reply-mode]"),
    headline: firstLine,
  },
  {
    kind: "task-notification",
    label: "🔔 Background task notification",
    test: (t) => t.startsWith("<task-notification>"),
    headline: (t) => {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim();
      const status = /<status>([\s\S]*?)<\/status>/.exec(t)?.[1]?.trim();
      return summary || (status ? `Task ${status}` : "A background task reported back.");
    },
  },
];

/** The injected context this user-role text is, or null when it reads as something a person wrote. */
export function detectInjectedContext(text: unknown): InjectedContext | null {
  if (typeof text !== "string") {
    return null;
  }
  const t = text.trimStart();
  for (const rule of RULES) {
    if (rule.test(t)) {
      return { kind: rule.kind, label: rule.label, headline: rule.headline(t), body: t };
    }
  }
  return null;
}
