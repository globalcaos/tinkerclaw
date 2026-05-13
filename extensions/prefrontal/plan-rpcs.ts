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
}

export function createPlanRpcs(deps: PlanRpcsDeps) {
  return {
    "prefrontal.plan.set": async (raw: unknown) => {
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
