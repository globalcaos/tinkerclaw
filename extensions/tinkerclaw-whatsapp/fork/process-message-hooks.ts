/**
 * FORK: Re-export from src/fork/ for extensions/tinkerclaw-whatsapp/ import path compatibility.
 * The wiring script inserts a relative import to "../../../fork/process-message-hooks.js"
 * which resolves here. The actual implementation lives in src/fork/process-message-hooks.ts.
 */
export {
  annotateOfflineRecovery,
  createThinkingReaction,
} from "../../../src/fork/process-message-hooks.js";
