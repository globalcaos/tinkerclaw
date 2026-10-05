/**
 * Messages the amygdala sends to the AGENT (design doc §3 M6, §8). Each is a one-line template filled by code with
 * observed values: the finding, the judge's probability and the verified fact behind it. The judge never writes text.
 * This is code wording, not question wording: the wording of a question lives only in questions/<family>/<id>.md.
 */

export type Slots = Record<string, string | number>;

const T = {
  "assumed-reading": "amygdala: this step assumes the request means {reading}.",
  "relevant-fact": "amygdala: {fact}.",
  "proof-required":
    "Held: {what}. To proceed, show: {needs}. Rephrasing the step does not release it; evidence does.",
  "hard-rule": "Blocked by hard rule {rule}: {explanation}.",
  "hold-kept": "The user kept this step held. Nothing was run.",
  "hold-timeout":
    "The user did not answer in time. Nothing was run; say so and ask whether to proceed.",
  "user-picked": "The user picked this reading: {reading}. Redo the step with it.",
  "send-back-claim":
    "Your reply says {claim}; the tool record for this task shows {missing}. Correct, complete or withdraw it.",
  "send-back-dodged": "Your reply {problem}. Complete it, or say plainly what blocks it.",
  surprise:
    "You expected {expected}; the result was {observed}. Look at that before the next step.",
  futility:
    "The same error {n} times with nothing new. Say what you learned and change approach, or stop and report what blocks you.",
  "stop-task":
    "Stopped: no progress after a warning. Write a short summary of what was tried and what blocks you.",
  "standing-facts": "Standing facts: {facts}.",
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
