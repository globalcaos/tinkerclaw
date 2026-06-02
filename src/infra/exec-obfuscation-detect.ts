/**
 * FORK STUB: Command obfuscation detection.
 * Upstream implementation removed during merge.
 * Always allows execution but detects obvious obfuscation patterns
 * and logs a warning for audit trail.
 * Real implementation will arrive with next upstream merge.
 */
// No subsystem logger import — this stub runs at module load time inside the
// embedded-agent chunk where createSubsystemLogger may not yet be available
// (jiti CJS circular dependency). Use console.warn instead.

export function detectCommandObfuscation(command: string): {
  detected: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

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
    console.warn(
      `[exec-obfuscation] Potential obfuscation (stub): ${command.slice(0, 100)} — ${reasons.join(", ")}`,
    );
  }

  return { detected: reasons.length > 0, reasons };
}
