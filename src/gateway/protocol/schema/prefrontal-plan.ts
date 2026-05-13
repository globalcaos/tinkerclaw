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
]);

export const PlanStepSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    status: StepStatusSchema,
    note: Type.Optional(Type.String({ maxLength: 4000 })),
    artifact: Type.Optional(Type.String({ maxLength: 500 })),
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
