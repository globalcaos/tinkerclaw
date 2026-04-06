/**
 * FORK STUB: Command obfuscation detection.
 * Upstream implementation removed during merge.
 * Always allows execution but detects obvious obfuscation patterns
 * and logs a warning for audit trail.
 * Real implementation will arrive with next upstream merge.
 */
import { createSubsystemLogger } from "../logging/diagnostic.js";

const log = createSubsystemLogger("exec-obfuscation");

export function detectCommandObfuscation(command: string): {
  detected: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  // Basic pattern checks for obvious obfuscation
  if (/\\x[0-9a-f]{2}/i.test(command)) {
    reasons.push("hex-escape-sequence");
  }
  if (/\\u[0-9a-f]{4}/i.test(command)) {
    reasons.push("unicode-escape-sequence");
  }
  if (/\$\(.*base64/i.test(command)) {
    reasons.push("base64-subshell");
  }
  if (/eval\s*\(/i.test(command)) {
    reasons.push("eval-call");
  }
  if (/\\[0-7]{3}/.test(command)) {
    reasons.push("octal-escape-sequence");
  }

  if (reasons.length > 0) {
    log.warn(
      `Potential obfuscation detected in command (stub check): ${command.slice(0, 100)} — reasons: ${reasons.join(", ")}`,
    );
    return { detected: true, reasons };
  }

  return { detected: false, reasons: [] };
}
