/**
 * FORK: All custom wiring for system-prompt.ts lives here.
 *
 * - personaBlock injection
 * - isMinimal skills suppression
 */

// Currently these are small enough to be inline params.
// This file exists as the designated hook point so that on merge,
// any expansion of system-prompt customization goes here.

/**
 * Determine whether to suppress the skills section.
 * Sub-agent (minimal) sessions don't need skills eating their context window.
 */
export function shouldSuppressSkills(isMinimal: boolean): boolean {
  return isMinimal;
}
