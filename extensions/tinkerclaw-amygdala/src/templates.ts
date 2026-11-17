/**
 * Messages the amygdala sends to the AGENT (design doc §3 M6, §8). Each is a one-line template filled by code with
 * observed values: the finding, the judge's probability and the verified fact behind it. The judge never writes text.
 * This is code wording, not question wording: the wording of a question lives only in questions/<family>/<id>.md.
 */

export type Slots = Record<string, string | number>;

const T = {
  "assumed-reading": "amygdala: this step assumes the request means {reading}.",
  "relevant-fact": "amygdala: {fact}.",
  // 2026-10-29: the owner's own request counts as the user-request evidence (the next try of the same step is judged
  // with it), and he can release the step with one click under the reply instead of copying a code.
  "proof-required":
    "Held: {what}. To proceed, show: {needs}. Rephrasing the step does not release it; evidence does. If the owner's own message in this turn already asks for this step, run the identical step once more and it is judged with that message. Otherwise stop and say what is held: the owner can allow it with one click under your reply.",
  "hard-rule": "Blocked by hard rule {rule}: {explanation}.",
  "hold-kept": "The user kept this step held. Nothing was run.",
  "hold-timeout":
    "The user did not answer in time. Nothing was run; say so, and say the Allow under your reply still releases this step.",
  "hold-subagent":
    "Held, and nothing was run. The owner does not read this session, so nobody can release it here. Do not try it another way: finish the rest, and name this step in your report so the agent that started you can take it to him.",
  "report-defect-how":
    "If the test itself is wrong, leave it as it is and end your reply with one line: `report-defect: <file>: <why it is wrong>`. That reaches the owner and is not sent back.",
  "defect-reported": "The agent says a check is wrong: {what}.",
  "user-picked": "The user picked this reading: {reading}. Redo the step with it.",
  "send-back-claim":
    "Your reply says {claim}; the tool record for this task shows {missing}. Correct, complete or withdraw it.",
  "send-back-dodged": "Your reply {problem}. Complete it, or say plainly what blocks it.",
  // 2026-10-24: "say plainly what blocks it" let a false "it is encrypted, I can't" pass. The user's own device did it.
  "send-back-blocker":
    "Your reply says this can't be done, yet the user does it with the same account, data or device, so a way exists. Find how the tool that already does it works (its own code, an open-source client, the official docs) and do the same. A blocker is real only when the user can't get past it either.",
  // 2026-11-10: a reply that admits it did not check something goes back once, to be checked.
  // 2026-11-11: "check it now with a tool" was taken as leave to test by a live step: on 11-10 at 20:31 a WhatsApp
  // line was sent and deleted to check an undo. A check reads or runs on this machine; an outside effect is named.
  "send-back-unchecked":
    "Your reply says you did not check this: {what}. Check it now with a tool that only reads or runs on this machine, then give the result in one or two lines; do not repeat the rest of the reply. If only a step that sends, deletes, publishes or spends could check it, do not take it: name it.",
  // 2026-11-13: a subagent's parent receives only its last message, so "do not repeat the rest of the reply" made the
  // one-or-two-line check result the subagent's whole report (11-11 06:50, 11-12 23:19). There the reply comes again.
  "send-back-unchecked-subagent":
    "Your reply says you did not check this: {what}. Check it now with a tool that only reads or runs on this machine. If only a step that sends, deletes, publishes or spends could check it, do not take it: name it. Then give your whole reply again with the result in it: only your last message reaches the agent that started you.",
  // 2026-11-14 (fact-check.ts): a statement given as fact that the turn's own evidence does not carry. It arrives after
  // the turn, as a job's message in the same chat, so the reply it questions stays as it was.
  "fact-check-wake":
    "Your last reply stated as fact what the evidence of that task does not carry: {what}. Check it now with a tool that only reads or runs on this machine, or say it as a hypothesis. Answer in one or two lines and do not repeat the rest of the reply. If only a step that sends, deletes, publishes or spends could check it, do not take it: name it.",
  "unsupported-note": "Not confirmed by the record: {what}.",
  surprise:
    "You expected {expected}; the result was {observed}. Look at that before the next step.",
  futility:
    "The same error {n} times with nothing new. Say what you learned and change approach, or stop and report what blocks you.",
  // 2026-11-01: "write a short summary" read as a tool call, and every tool is off here: 66 denied writes in one run.
  "stop-task":
    "Stopped: the same error kept coming back, and every tool is off for the rest of this turn. End the turn now with a plain reply saying what you tried and what blocks you.",
  "standing-facts": "Standing facts: {facts}.",
  // 2026-11-13, ambiguity redesign (second-opinion): the screen read the request with the conversation and still found
  // two readings. Stage 2 asks for redundant evidence; stage 3 (`reading-proof`) holds a changing step until it comes.
  "reading-evidence":
    "Even with the conversation in view, this request can mean more than one thing. Before any step that changes something: list the readings as `- reading: …` lines, name the one you act on as `- pick: …`, and cite two independent sources that point to it as `- source: <file or message> — <what it shows>`. At least one must be a memory file or document you open in this turn; a message counts only as a quote in double quotes. Reads and searches never wait. If the sources do not settle it, stop and ask which reading is meant.",
  "reading-proof":
    "Held: it is not settled which reading of the request this step serves (pick: {pick}; sources that check out: {sources} of 2, at least one an opened file). Open one more independent source in memory and cite it as `- source: <file> — <what it shows>`, then run the step again; or stop and ask which reading is meant. Rephrasing the step does not release it.",
  "reading-list":
    "This request may be read more than one way: {readings}. Look things up before acting; a meaning not listed is possible.",
  procedure: "amygdala: recipe {id} fits this request (p={p}).",
  novelty: "New this session: {what}. Worth a look, not a stop.",
} as const;

export type TemplateId = keyof typeof T;

export function isTemplateId(id: string): id is TemplateId {
  return Object.prototype.hasOwnProperty.call(T, id);
}

/** Fill a template. A missing slot or an unknown id throws: a silent blank would reach the agent as a garbled note. */
export function renderTemplate(id: string, slots: Slots = {}): string {
  if (!isTemplateId(id)) throw new Error(`unknown template id: ${id}`);
  return T[id].replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in slots)) throw new Error(`template ${id}: missing slot ${name}`);
    return String(slots[name]);
  });
}

export const TEMPLATE_IDS = Object.keys(T) as TemplateId[];
