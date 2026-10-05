import { describe, expect, it } from "vitest";
import {
  ROLES,
  roleLetters,
  rolesAtEffort,
  rolesOfModel,
  suggestionLine,
  suggestionsFromReply,
} from "./thalamus-roles.js";

const name = (id: string) => id.split("/")[1] ?? id;
const o = { modelName: name, effortWord: (l: string) => l };

describe("thalamus roles", () => {
  it("reads the new suggestions shape, effort kept", () => {
    const s = suggestionsFromReply({
      suggestions: {
        smart: { model: "claude-code/claude-opus-5-5", effort: "high" },
        default: { model: "claude-code/claude-sonnet-5-5" },
      },
      defaults: { high: "x/y" },
    });
    expect(s).toEqual({
      smart: { model: "claude-code/claude-opus-5-5", effort: "high" },
      default: { model: "claude-code/claude-sonnet-5-5" },
    });
  });

  it("maps an old gateway's high / medium / low view to smart / default / budget with no effort", () => {
    const s = suggestionsFromReply({ defaults: { high: "a/b", medium: "c/d", low: "e/f" } });
    expect(s).toEqual({
      smart: { model: "a/b" },
      default: { model: "c/d" },
      budget: { model: "e/f" },
    });
  });

  it("drops anything that is not provider/model, and tolerates an empty or odd reply", () => {
    expect(
      suggestionsFromReply({ suggestions: { smart: { model: "nope" }, bogus: { model: "a/b" } } }),
    ).toEqual({});
    expect(suggestionsFromReply(null)).toEqual({});
    expect(suggestionsFromReply({ suggestions: [] })).toEqual({});
  });

  it("a model that holds two stops shows both letters, strongest first", () => {
    const s = suggestionsFromReply({
      suggestions: { budget: { model: "a/b" }, smart: { model: "a/b" } },
    });
    expect(roleLetters(rolesOfModel(s, "a/b"))).toBe("SB");
    expect(rolesOfModel(s, "a/other")).toEqual([]);
  });

  it("the effort letter sits on the level the role was assigned, only for that model", () => {
    const s = suggestionsFromReply({
      suggestions: {
        smart: { model: "a/b", effort: "high" },
        default: { model: "a/b", effort: "low" },
      },
    });
    expect(rolesAtEffort(s, "a/b", "high")).toEqual(["smart"]);
    expect(rolesAtEffort(s, "a/b", "low")).toEqual(["default"]);
    expect(rolesAtEffort(s, "a/b", "max")).toEqual([]);
    expect(rolesAtEffort(s, "c/d", "high")).toEqual([]);
  });

  it("the suggestion line names the stop, the model and the effort, or says there is none", () => {
    const s = suggestionsFromReply({
      suggestions: { default: { model: "p/sonnet", effort: "low" }, smart: { model: "p/opus" } },
    });
    expect(suggestionLine(s, "default", o)).toBe("Default: sonnet · low");
    expect(suggestionLine(s, "smart", o)).toBe("Smart: opus");
    expect(suggestionLine(s, "budget", o)).toBe("Budget: no suggestion yet, Thalamus picks");
  });

  it("the three letters are S, D and B", () => {
    expect(ROLES.map((r) => r.letter)).toEqual(["S", "D", "B"]);
  });
});
