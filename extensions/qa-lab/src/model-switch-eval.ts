export function hasModelSwitchContinuityEvidence(text: string) {
  const lower = text.toLowerCase();
  const mentionsHandoff =
    lower.includes("handoff") || lower.includes("model switch") || lower.includes("switched");
  const mentionsKickoffTask =
    lower.includes("qa_kickoff_task") ||
    lower.includes("kickoff task") ||
    lower.includes("qa mission");
  return mentionsHandoff && mentionsKickoffTask;
}
