import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export async function maybeRepairUiProtocolFreshness(
  _runtime: RuntimeEnv,
  _prompter: DoctorPrompter,
) {
  // FORK 2026-09-10: stock Control UI retired. Tinker is the operator UI;
  // do not prompt to rebuild ui/ or treat missing dist/control-ui as a defect.
}
