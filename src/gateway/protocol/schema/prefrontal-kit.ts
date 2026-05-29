import { Type, type Static } from "typebox";

export const KitRiskAssessmentSchema = Type.Object(
  {
    source: Type.String(),
    level: Type.Union([
      Type.Literal("Safe"),
      Type.Literal("Low Risk"),
      Type.Literal("Med Risk"),
      Type.Literal("High Risk"),
      Type.Literal("Critical"),
    ]),
    alertCount: Type.Optional(Type.Integer({ minimum: 0 })),
    url: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PrefrontalKitSearchParamsSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  },
  { additionalProperties: false },
);

export const PrefrontalKitGetParamsSchema = Type.Object(
  {
    kitRef: Type.String({ pattern: "^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$" }),
    ref: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PrefrontalKitInstallParamsSchema = Type.Object(
  {
    kitRef: Type.String({ pattern: "^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$" }),
    ref: Type.Optional(Type.String()),
    runVerification: Type.Optional(Type.Boolean()),
    allowRisky: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PrefrontalKitPublishParamsSchema = Type.Object(
  {
    slug: Type.String({ pattern: "^[a-z0-9-]+$", minLength: 1, maxLength: 80 }),
    visibility: Type.Union([Type.Literal("public"), Type.Literal("private")]),
    orgId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PrefrontalKitListParamsSchema = Type.Object(
  {
    owner: Type.Optional(Type.String()),
    installed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PrefrontalKitRunParamsSchema = Type.Object(
  {
    kitRef: Type.String({ pattern: "^[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+$" }),
    sessionKey: Type.String({ minLength: 1, maxLength: 200 }),
    intent: Type.String({ minLength: 1, maxLength: 500 }),
    parameters: Type.Optional(Type.Record(Type.String(), Type.String(), { maxProperties: 50 })),
    dryRun: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// FORK 2026-05-29: author a kit on the fly (compose a recipe). slug doubles as
// the on-disk dir name, so it is constrained to a traversal-safe pattern.
export const PrefrontalKitAuthorParamsSchema = Type.Object(
  {
    slug: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{1,63}$" }),
    title: Type.String({ minLength: 1, maxLength: 120 }),
    summary: Type.String({ minLength: 1, maxLength: 400 }),
    tags: Type.Array(Type.String({ maxLength: 60 }), { minItems: 1, maxItems: 24 }),
    category: Type.Optional(
      Type.Union([
        Type.Literal("coding"),
        Type.Literal("writing"),
        Type.Literal("communication"),
        Type.Literal("analysis"),
        Type.Literal("operations"),
        Type.Literal("security"),
      ]),
    ),
    triggers: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 24 })),
    goal: Type.Optional(Type.String({ maxLength: 2000 })),
    whenToUse: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 24 })),
    steps: Type.Array(
      Type.Object(
        {
          title: Type.String({ minLength: 1, maxLength: 120 }),
          tools: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 16 })),
          doneWhen: Type.Optional(Type.String({ maxLength: 400 })),
          body: Type.String({ minLength: 1, maxLength: 4000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 24 },
    ),
    parallelismGroups: Type.Optional(Type.Array(Type.Array(Type.Integer({ minimum: 0 })))),
    parallelismNotes: Type.Optional(Type.String({ maxLength: 1000 })),
    constraints: Type.Optional(Type.Array(Type.String({ maxLength: 400 }), { maxItems: 24 })),
    safetyNotes: Type.Optional(Type.Array(Type.String({ maxLength: 400 }), { maxItems: 24 })),
    failuresOvercome: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 24 })),
    overwrite: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// FORK 2026-05-29: LLM-free best-fit lookup against the local catalog.
export const PrefrontalKitMatchParamsSchema = Type.Object(
  {
    prompt: Type.String({ minLength: 1, maxLength: 4000 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

export type PrefrontalKitAuthorParams = Static<typeof PrefrontalKitAuthorParamsSchema>;
export type PrefrontalKitMatchParams = Static<typeof PrefrontalKitMatchParamsSchema>;
export type PrefrontalKitSearchParams = Static<typeof PrefrontalKitSearchParamsSchema>;
export type PrefrontalKitGetParams = Static<typeof PrefrontalKitGetParamsSchema>;
export type PrefrontalKitInstallParams = Static<typeof PrefrontalKitInstallParamsSchema>;
export type PrefrontalKitPublishParams = Static<typeof PrefrontalKitPublishParamsSchema>;
export type PrefrontalKitListParams = Static<typeof PrefrontalKitListParamsSchema>;
export type PrefrontalKitRunParams = Static<typeof PrefrontalKitRunParamsSchema>;
