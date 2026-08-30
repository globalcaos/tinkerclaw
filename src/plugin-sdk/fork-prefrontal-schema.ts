/**
 * FORK: the prefrontal plan/kit RPC schemas, as a declared plugin-SDK surface.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tinkerclaw-prefrontal` is the fork's planning and recipe extension. It speaks the
 * `prefrontal.plan.*` and `prefrontal.kit.*` gateway RPCs, so it needs the parameter
 * types and their zod schemas — the same ones the gateway validates against. It was
 * reaching them by relative path (`../../src/gateway/protocol/schema/...`), which
 * resolves inside this monorepo and nowhere else: a plugin installed the normal way
 * lives under `~/.openclaw/plugins/<name>/`, where `../../src/` does not exist.
 *
 * No capability is granted. An extension that can name a plan step cannot do anything
 * with that name it could not already do by calling the RPC; publishing the schema is
 * publishing the wire contract it is already allowed to speak.
 *
 * Both source modules are fork-owned, so this surface is ours to define; it does not
 * commit upstream to anything.
 *
 * ⚠️  THE `*Schema` SYMBOLS ARE VALUES, NOT TYPES — DO NOT "TIDY" THEM INTO THE `export
 * type` BLOCK.
 * They are TypeBox consts, and the consumer feeds them to `ajv.compile()` at module load:
 *
 *     const vSet = ajv.compile(PrefrontalPlanSetParamsSchema);   // plan-rpcs.ts:19
 *
 * The first version of this file exported all 32 names with `export type`, because the
 * check that produced the list asked whether each NAME was exported and never asked
 * whether it was a value or a type. Under `verbatimModuleSyntax` that erases them at
 * compile time: `ajv.compile(undefined)` at startup, from a file that reads correctly and
 * whose every name genuinely exists. It was caught before it shipped only because the
 * agent doing the rewrite refused to apply a mapping it could not make typecheck.
 *
 * The failure class is worth naming: A SUBPATH CAN CARRY THE NAME AND NOT THE VALUE.
 * `lint:plugins:plugin-sdk-subpaths-exported` checks that referenced subpaths export the
 * names — it cannot see this, and it stayed green throughout.
 */

// VALUES — TypeBox schema consts, compiled at runtime by consumers.
export {
  PrefrontalPlanCloseParamsSchema,
  PrefrontalPlanGetParamsSchema,
  PrefrontalPlanSetParamsSchema,
  PrefrontalPlanStepParamsSchema,
} from "../gateway/protocol/schema/prefrontal-plan.js";

export {
  PrefrontalKitAuthorParamsSchema,
  PrefrontalKitComposeParamsSchema,
  PrefrontalKitGetParamsSchema,
  PrefrontalKitInstallParamsSchema,
  PrefrontalKitListParamsSchema,
  PrefrontalKitMatchParamsSchema,
  PrefrontalKitOrchestrateParamsSchema,
  PrefrontalKitPublishParamsSchema,
  PrefrontalKitReadParamsSchema,
  PrefrontalKitRunParamsSchema,
  PrefrontalKitSearchParamsSchema,
} from "../gateway/protocol/schema/prefrontal-kit.js";

// TYPES — erased at compile time, correctly.
export type {
  Plan,
  PlanStep,
  PrefrontalPlanCloseParams,
  PrefrontalPlanGetParams,
  PrefrontalPlanSetParams,
  PrefrontalPlanStepParams,
} from "../gateway/protocol/schema/prefrontal-plan.js";

export type {
  PrefrontalKitAuthorParams,
  PrefrontalKitComposeParams,
  PrefrontalKitGetParams,
  PrefrontalKitInstallParams,
  PrefrontalKitListParams,
  PrefrontalKitMatchParams,
  PrefrontalKitOrchestrateParams,
  PrefrontalKitPublishParams,
  PrefrontalKitReadParams,
  PrefrontalKitRunParams,
  PrefrontalKitSearchParams,
} from "../gateway/protocol/schema/prefrontal-kit.js";
