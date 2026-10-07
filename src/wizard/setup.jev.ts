import { jevAvailability } from "../infra/jev/availability.js";
import {
  jevDormantNote,
  jevTokenFilePath,
  normalizeJevToken,
  writeJevTokenFile,
} from "../infra/jev/token-file.js";
import type { WizardPrompter } from "./prompts.js";

/**
 * The optional Jev token step. A token goes to the key file (mode 0600), never to openclaw.json; skipping leaves Jev
 * dormant and says so in one line. Safe to skip: nothing else depends on it.
 */
export async function setupJevToken(prompter: WizardPrompter): Promise<void> {
  const existing = jevAvailability();
  if (existing.keySource) {
    await prompter.note(
      "A Jev token is already set up. Jev switches on by itself.",
      "Jev (optional judge)",
    );
    return;
  }
  const answer = await prompter.text({
    message: "Jev token (optional, press Enter to skip)",
    placeholder: "paste a token, or leave empty",
    validate: (value) =>
      value.trim() === "" || normalizeJevToken(value)
        ? undefined
        : "A token is one value without spaces. Leave it empty to skip.",
  });
  if (answer.trim() === "") {
    await prompter.note(jevDormantNote(jevTokenFilePath()), "Jev (optional judge)");
    return;
  }
  const path = writeJevTokenFile(answer);
  await prompter.note(
    `Saved to ${path} (owner-only). Jev checks it and switches on by itself, no restart.`,
    "Jev (optional judge)",
  );
}
