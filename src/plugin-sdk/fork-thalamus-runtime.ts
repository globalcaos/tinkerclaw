/**
 * FORK 2026-09-30: the parts of THALAMUS v4 that read the live gateway (design doc section 11.2 and 13A.5).
 *
 * Split from `fork-thalamus` so that importing the pure logic and the provider registry (the amygdala does) does not
 * load the model catalog, the session store and the plugin registry. Only the Thalamus extension imports this.
 * WHAT IS PUBLISHED: the live board (rungs, supplies, windows, dial), the hand-picked check, and use attribution.
 */
export { readThalamusBoard, isHandPicked, type ThalamusBoard } from "../infra/thalamus-board.js";
export {
  attributeToolUsage,
  getUsageRegistry,
  type UsageListing,
  type UsageMark,
} from "../fork/usage-attribution.js";
// FORK 2026-10-02: the picker's writer for the dial stops' suggestions (`prefrontal.thalamusDefaults`), kept in core so
// the extension that registers the method and the router that reads the file share one parser and one writer.
export {
  applyThalamusDefaultsRequest,
  type ThalamusDefaultsReply,
} from "../infra/thalamus-tier-defaults.js";
