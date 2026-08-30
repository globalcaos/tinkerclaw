import { describe, expect, it } from "vitest";
import { GENERATED_BASE_CONFIG_SCHEMA } from "./schema.base.generated.js";
import { validateConfigObject } from "./validation.js";

function configWithModelEntry(entry: Record<string, unknown>) {
  return {
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-5": entry,
        },
      },
    },
  };
}

describe("agents.defaults.models[].relCost", () => {
  // CONTROL. The model-entry object is `.strict()`, so an unrecognised key does
  // not merely get dropped: it fails validation of the WHOLE config, and the
  // gateway refuses to start. Without this control the acceptance case below
  // would pass just as happily against a permissive schema that silently eats
  // every key, proving nothing about relCost in particular.
  it("CONTROL: an unrecognised model-entry key fails the whole config", () => {
    const res = validateConfigObject(configWithModelEntry({ relCostt: 12.5 }));
    expect(res.ok).toBe(false);
  });

  it("accepts relCost on a model entry", () => {
    const res = validateConfigObject(configWithModelEntry({ relCost: 12.5 }));
    expect(res.ok).toBe(true);
  });

  it("accepts a near-zero relCost (prepaid-subscription token)", () => {
    const res = validateConfigObject(configWithModelEntry({ relCost: 0 }));
    expect(res.ok).toBe(true);
  });

  it("rejects a non-numeric relCost", () => {
    const res = validateConfigObject(configWithModelEntry({ relCost: "12.5" }));
    expect(res.ok).toBe(false);
  });

  it("rejects a non-finite relCost", () => {
    const res = validateConfigObject(configWithModelEntry({ relCost: Number.POSITIVE_INFINITY }));
    expect(res.ok).toBe(false);
  });

  it("exposes relCost as a number on the generated base config schema", () => {
    const modelEntry = (
      GENERATED_BASE_CONFIG_SCHEMA.schema as {
        properties?: {
          agents?: {
            properties?: {
              defaults?: {
                properties?: {
                  models?: {
                    additionalProperties?: {
                      properties?: Record<string, { type?: string }>;
                      additionalProperties?: boolean;
                    };
                  };
                };
              };
            };
          };
        };
      }
    ).properties?.agents?.properties?.defaults?.properties?.models?.additionalProperties;

    expect(modelEntry?.properties?.relCost).toEqual({ type: "number" });
    // The generated surface must stay strict too — this is what makes the
    // CONTROL above a real gate rather than a formality.
    expect(modelEntry?.additionalProperties).toBe(false);
  });
});
