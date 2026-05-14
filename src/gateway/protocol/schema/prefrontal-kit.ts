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

export type PrefrontalKitSearchParams = Static<typeof PrefrontalKitSearchParamsSchema>;
export type PrefrontalKitGetParams = Static<typeof PrefrontalKitGetParamsSchema>;
export type PrefrontalKitInstallParams = Static<typeof PrefrontalKitInstallParamsSchema>;
export type PrefrontalKitPublishParams = Static<typeof PrefrontalKitPublishParamsSchema>;
export type PrefrontalKitListParams = Static<typeof PrefrontalKitListParamsSchema>;
export type PrefrontalKitRunParams = Static<typeof PrefrontalKitRunParamsSchema>;
