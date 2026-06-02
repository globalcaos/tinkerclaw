import path from "node:path";
import Ajv from "ajv";
import {
  PrefrontalPlanSetParamsSchema,
  PrefrontalPlanStepParamsSchema,
  PrefrontalPlanGetParamsSchema,
  PrefrontalPlanCloseParamsSchema,
  type PrefrontalPlanSetParams,
  type PrefrontalPlanStepParams,
  type PrefrontalPlanGetParams,
  type PrefrontalPlanCloseParams,
} from "../../src/gateway/protocol/schema/prefrontal-plan.js";
import { PlanStore } from "./plan-store.js";

// ajv-formats is not a project dependency; the input param schemas (set/step/get/close)
// do not use date-time format (that only appears on the output Plan type), so no addFormats needed.
const ajv = new Ajv({ allErrors: true });

const vSet = ajv.compile(PrefrontalPlanSetParamsSchema);
const vStep = ajv.compile(PrefrontalPlanStepParamsSchema);
const vGet = ajv.compile(PrefrontalPlanGetParamsSchema);
const vClose = ajv.compile(PrefrontalPlanCloseParamsSchema);

type Validator = ReturnType<typeof ajv.compile>;

function validateOrThrow<T>(validator: Validator, params: unknown, name: string): T {
  if (!validator(params)) {
    const msg = (validator.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
      .join("; ");
    throw new Error(`${name}: invalid params: ${msg}`);
  }
  return params as T;
}

export interface PlanRpcsDeps {
  store: PlanStore;
  ownRecipesDir?: string;
  recipeInstallSandbox?: string;
}

export function createPlanRpcs(deps: PlanRpcsDeps) {
  return {
    "prefrontal.plan.set": async (raw: unknown) => {
      // Pre-validate kitRef-only shape: allow empty steps[] when kitRef is provided.
      // Do this BEFORE running the schema validator (which requires minItems:1).
      const rawObj = raw as any; // oxlint-disable-line typescript-eslint/no-explicit-any
      if (
        rawObj &&
        typeof rawObj === "object" &&
        rawObj.kitRef &&
        Array.isArray(rawObj.steps) &&
        rawObj.steps.length === 0
      ) {
        const seeded = await readStepsFromKit(rawObj.kitRef as string, deps);
        if (seeded.length === 0) {
          throw new Error(
            `prefrontal.plan.set: kit ${rawObj.kitRef} has no parsable steps in body`,
          );
        }
        rawObj.steps = seeded;
      }
      const p = validateOrThrow<PrefrontalPlanSetParams>(vSet, raw, "prefrontal.plan.set");
      const plan = await deps.store.set({
        sessionKey: p.sessionKey,
        intent: p.intent,
        runId: p.runId ?? cryptoRandomId(),
        recipe: p.recipe,
        kitRef: p.kitRef,
        steps: p.steps,
      });
      return { planId: plan.runId, path: deps.store.filePathPublic(p.sessionKey) };
    },
    "prefrontal.plan.step": async (raw: unknown) => {
      const p = validateOrThrow<PrefrontalPlanStepParams>(vStep, raw, "prefrontal.plan.step");
      await deps.store.step(p);
      return { ok: true } as const;
    },
    "prefrontal.plan.get": async (raw: unknown) => {
      const p = validateOrThrow<PrefrontalPlanGetParams>(vGet, raw, "prefrontal.plan.get");
      const plan = await deps.store.get(p.sessionKey);
      return { plan };
    },
    "prefrontal.plan.close": async (raw: unknown) => {
      const p = validateOrThrow<PrefrontalPlanCloseParams>(vClose, raw, "prefrontal.plan.close");
      return await deps.store.close(p);
    },
  };
}

function cryptoRandomId(): string {
  return `run-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

async function readStepsFromKit(
  kitRef: string,
  deps: { ownRecipesDir?: string; recipeInstallSandbox?: string },
): Promise<Array<{ title: string }>> {
  const fs = await import("node:fs/promises");
  const [owner, slug] = kitRef.split("/");
  const candidates: string[] = [];
  if (deps.ownRecipesDir) candidates.push(path.join(deps.ownRecipesDir, slug, "kit.md"));
  if (deps.recipeInstallSandbox)
    candidates.push(path.join(deps.recipeInstallSandbox, owner, slug, "kit.md"));
  for (const p of candidates) {
    try {
      const text = await fs.readFile(p, "utf-8");
      const steps = parseStepsFromKitBody(text);
      if (steps.length > 0) return steps;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`prefrontal.plan.set: kit ${kitRef} not found in ${candidates.join(" or ")}`);
}

function parseStepsFromKitBody(text: string): Array<{ title: string }> {
  // Strip frontmatter, then collect step lines.
  // Handles two formats:
  //   1. Plain numbered list:  "1. Explore"
  //   2. Heading-style steps:  "### 1. Explore"  (used by all migrated kits)
  const body = text.replace(/^---\n[\s\S]+?\n---\n/, "");
  const steps: Array<{ title: string }> = [];
  for (const line of body.split("\n")) {
    // Match "### 1. Title" or "## 1. Title" (heading-style, real kits)
    const headingMatch = /^#{1,6}\s+\d+\.\s+(.+)$/.exec(line);
    if (headingMatch) {
      steps.push({ title: headingMatch[1].trim() });
      continue;
    }
    // Match plain numbered list "1. Title" (used in tests / simple kits)
    const listMatch = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (listMatch) {
      steps.push({ title: listMatch[1].trim() });
    }
  }
  return steps;
}
