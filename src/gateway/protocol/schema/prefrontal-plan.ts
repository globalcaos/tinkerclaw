import { Type, type Static } from "typebox";

export const StepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("error"),
]);

export const PlanStatusSchema = Type.Union([
  Type.Literal("in_progress"),
  Type.Literal("done"),
  Type.Literal("aborted"),
  // BROCA P1.1 (ask-for-missing): durable pause while the agent waits on the
  // human to supply a missing required input. Additive — existing plans validate
  // unchanged; Plan/PlanStep Static types widen automatically.
  Type.Literal("blocked-awaiting-input"),
]);

export const PlanStepSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    status: StepStatusSchema,
    note: Type.Optional(Type.String({ maxLength: 4000 })),
    // Human-readable ≤500-char prose digest (display only; unchanged behavior).
    artifact: Type.Optional(Type.String({ maxLength: 500 })),
    // SS1: the full validated typed output when the step declared an `out:` schema.
    // Not length-bounded — this is the canonical value downstream steps bind to.
    output: Type.Optional(Type.Unknown()),
    outputKind: Type.Optional(Type.Literal("json")),
    // SS5a: a step's ClassifiedError, persisted durably (mirrors `output`).
    // `kind` is a free Type.String (NOT a literal union) to keep prefrontal-plan
    // decoupled from recipe-types' ErrorKind.
    error: Type.Optional(
      Type.Object({
        kind: Type.String({ maxLength: 64 }),
        message: Type.String({ maxLength: 4000 }),
        recoverable: Type.Boolean(),
        details: Type.Optional(Type.Unknown()),
      }),
    ),
    startedAt: Type.Optional(Type.String({ format: "date-time" })),
    completedAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);

export const PlanSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    intent: Type.String({ minLength: 1, maxLength: 500 }),
    recipe: Type.Optional(Type.String()),
    kitRef: Type.Optional(Type.String()),
    started: Type.String({ format: "date-time" }),
    updated: Type.String({ format: "date-time" }),
    status: PlanStatusSchema,
    currentStep: Type.Integer({ minimum: 0 }),
    steps: Type.Array(PlanStepSchema, { minItems: 1, maxItems: 50 }),
  },
  { additionalProperties: false },
);

export const PrefrontalPlanSetParamsSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1 }),
    intent: Type.String({ minLength: 1, maxLength: 500 }),
    recipe: Type.Optional(Type.String()),
    kitRef: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    steps: Type.Array(Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }) }), {
      minItems: 1,
      maxItems: 50,
    }),
  },
  { additionalProperties: false },
);

export const PrefrontalPlanStepParamsSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1 }),
    stepIndex: Type.Integer({ minimum: 0 }),
    status: StepStatusSchema,
    note: Type.Optional(Type.String({ maxLength: 4000 })),
    artifact: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);

export const PrefrontalPlanGetParamsSchema = Type.Object(
  { sessionKey: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const PrefrontalPlanCloseParamsSchema = Type.Object(
  {
    sessionKey: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("done"), Type.Literal("aborted")]),
  },
  { additionalProperties: false },
);

export const PrefrontalPlanStateEventSchema = Type.Object(
  { sessionKey: Type.String(), plan: Type.Union([PlanSchema, Type.Null()]) },
  { additionalProperties: false },
);

export type Plan = Static<typeof PlanSchema>;
export type PlanStep = Static<typeof PlanStepSchema>;
export type PrefrontalPlanSetParams = Static<typeof PrefrontalPlanSetParamsSchema>;
export type PrefrontalPlanStepParams = Static<typeof PrefrontalPlanStepParamsSchema>;
export type PrefrontalPlanGetParams = Static<typeof PrefrontalPlanGetParamsSchema>;
export type PrefrontalPlanCloseParams = Static<typeof PrefrontalPlanCloseParamsSchema>;
