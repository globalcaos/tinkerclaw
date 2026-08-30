/**
 * FORK: the overseer loop-budget derivation, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * `extensions/tinkerclaw-prefrontal/overseer-budget.ts` is a shim: it re-exports the core
 * implementation so that `recipe-runner.ts` can keep importing `./overseer-budget.js`
 * locally while the logic lives in `src/fork/overseer-budget.ts` and stays single-owner.
 *
 * The shim is the right shape, but it was re-exporting across the package boundary with a
 * relative path, which resolves in this monorepo and nowhere else. A re-export is an
 * import: the specifier has to survive installation just the same.
 *
 * A pure function over a signals object and its parameter type. It reads nothing, writes
 * nothing, and holds no state — the narrowest kind of surface there is.
 */

export { deriveOverseerLoopBudget } from "../fork/overseer-budget.js";
export type { OverseerLoopSignals } from "../fork/overseer-budget.js";
