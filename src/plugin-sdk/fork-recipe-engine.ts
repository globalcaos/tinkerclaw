/**
 * FORK: the skill library and recipe-evolution primitives, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * The fork's recipe machinery — store a skill, score it, propose a rewrite of one of its
 * steps — lives in core under `memory/engram/**`, but the extension that drives it is
 * `tinkerclaw-prefrontal`. It was reaching in by relative path, which cannot resolve once
 * the plugin is installed outside this tree.
 *
 * This is a genuine capability surface, not just types: `createSkillLibrary` opens the
 * skill store and `proposeStepRewrites` mutates recipe content. It is published because
 * the fork's whole recipe programme is built on extensions doing exactly this, and an
 * extension that must reach around the SDK to do its job means the SDK is wrong, not the
 * extension. All four source modules are fork-owned.
 */

export { createSkillLibrary } from "../memory/engram/skill-library.js";
export type { SkillLibrary } from "../memory/engram/skill-library.js";

export { proposeStepRewrites } from "../memory/engram/recipe-evolution.js";
export type { MutationProposal } from "../memory/engram/recipe-evolution.js";

export { makeFitnessLookup } from "../memory/engram/recipe-fitness.js";

export type { Skill } from "../memory/storage/types.js";
