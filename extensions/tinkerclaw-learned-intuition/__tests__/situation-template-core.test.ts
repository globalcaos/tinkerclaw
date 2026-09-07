// Ported 2026-08-02 from src/amygdala/__tests__/situation-template.test.ts when the dead
// src/amygdala twin was deleted (it had ZERO production importers; the live copy is this
// extension). Kept BESIDE situation-template.test.ts rather than merged: the two suites
// share no test names at all — this one covers the core lookup tables and the live entry
// point, the sibling covers 19 different behaviours.
// ============================================================
// src/amygdala/__tests__/situation-template.test.ts
// Unit tests for all 16 slots of the SituationTemplate system
// ============================================================

// `vi` is imported explicitly: this suite came from src/amygdala/__tests__, whose vitest config
// enables globals. The extension config does not, so the bare `vi.fn()` calls below threw
// "ReferenceError: vi is not defined" until this import was added.
import { describe, it, expect, vi } from "vitest";
import type { GitCache } from "../src/git-cache.js";
import {
  buildSituation,
  serializeSituation,
  classifyActionType,
  classifyTargetType,
  getTargetAgeHours,
  getTargetSize,
  getLastHumanReference,
  crossCheckEffort,
  crossCheckEmotion,
  getReversibility,
  getBlastRadius,
  cosineSimilarity,
  type ActionRequest,
  type SessionContext,
} from "../src/situation-template.js";
import type { AmygdalaConfig } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<AmygdalaConfig>): AmygdalaConfig {
  return {
    enabled: true,
    trust: {
      alpha_prudence: 0.1,
      alpha_personality: 0.1,
      alpha_max: 0.15,
      alpha_min: 0.0,
      phase: 1,
      ramp_eta: 0.01,
      reward_threshold: 0.5,
    },
    embedding: {
      encoder_model_path: "models/encoder.onnx",
      projection_model_path: "models/projection.onnx",
      internal_dim: 512,
      input_dim: 384,
      window_size: 32,
    },
    prudence: {
      model_paths: { a: "", b: "", c: "", d: "", e: "" },
      meta_weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      conservative_override_threshold: 0.9,
      disagreement_threshold: 0.3,
    },
    personality: {
      model_paths: { a: "", b: "", c: "", d: "", e: "" },
      meta_weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      target_vector: [],
      embedding_dim: 64,
    },
    conformal: {
      epsilon: 0.05,
      calibration_window_days: 30,
      calibration_db_path: "",
    },
    git_cache: { enabled: false, watch_paths: [], ttl_seconds: 120 },
    training_log: { db_path: "", max_entries: 10000, rolling_window_days: 90 },
    action_type_map: {},
    target_type_map: {},
    reversibility_map: {},
    blast_radius_map: {} as AmygdalaConfig["blast_radius_map"],
    ...overrides,
  };
}

function makeSessionContext(overrides?: Partial<SessionContext>): SessionContext {
  return {
    topic: "unit testing",
    emotionalState: "calm",
    effortHoursEstimate: 1.0,
    correctionCount24h: 0,
    automationDepth: 0,
    confirmationEnabled: true,
    confirmationLevel: "soft",
    sessionDuration: 1.0,
    actionCount: 5,
    topicCentroid: null,
    recentTranscripts: [],
    ...overrides,
  };
}

function makeMockGitCache(commits = 0, authors = 0): GitCache {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getRecentCommits: vi.fn().mockResolvedValue(commits),
    getRecentAuthors: vi.fn().mockResolvedValue(authors),
    invalidate: vi.fn(),
  } as unknown as GitCache;
}

// Stub embedFn — returns predictable 4d vector for testing
async function stubEmbed(text: string): Promise<Float32Array> {
  // Encode differently based on text to test topic drift
  if (text.includes("database")) {
    return new Float32Array([1, 0, 0, 0]);
  }
  if (text.includes("README")) {
    return new Float32Array([0, 1, 0, 0]);
  }
  return new Float32Array([0.5, 0.5, 0, 0]);
}

// ── Tests: buildSituation (full template) ─────────────────────

describe("buildSituation", () => {
  it("should fill all 16 slots for a file overwrite action", async () => {
    const action: ActionRequest = { type: "write", target: "/tmp/test_readme.md" };
    const context = makeSessionContext({
      topic: "documentation",
      effortHoursEstimate: 2.5,
      correctionCount24h: 1,
    });
    const config = makeConfig();
    const gitCache = makeMockGitCache(3, 2);

    const template = await buildSituation(action, context, config, gitCache, stubEmbed);

    // Slot 1: action_type
    expect(template.action_type).toBe("overwrite");
    // Slot 2: target_type
    expect(template.target_type).toBe("file");
    // Slot 3: target_id
    expect(template.target_id).toBe("/tmp/test_readme.md");
    // Slot 4: age_hours — file doesn't exist so should be -1
    expect(template.target_metadata.age_hours).toBe(-1);
    // Slot 5: size — file doesn't exist so should be 0
    expect(template.target_metadata.size).toBe(0);
    // Slot 6: recent_commits (from mock)
    expect(template.target_metadata.recent_commits).toBe(3);
    // Slot 7: recent_authors (from mock)
    expect(template.target_metadata.recent_authors).toBe(2);
    // Slot 8: effort_hours (LLM-estimated, cross-checked)
    expect(template.target_metadata.effort_hours).toBeGreaterThanOrEqual(0);
    // Slot 9: last_human_ref — not mentioned in empty transcripts
    expect(template.target_metadata.last_human_ref).toBe(999);
    // Slot 10: session_topic (LLM-estimated)
    expect(template.context.session_topic).toBe("documentation");
    // Slot 11: recent_corrections
    expect(template.context.recent_corrections).toBe(1);
    // Slot 12: emotional_signals (LLM-estimated, cross-checked)
    expect(template.context.emotional_signals).toBe("calm");
    // Slot 13: automation_depth
    expect(template.context.automation_depth).toBe(0);
    // Slot 14: topic_drift — no centroid, should be 0
    expect(template.context.topic_drift).toBe(0.0);
    // Slot 15: reversible
    expect(template.scope.reversible).toBe("true");
    // Slot 16: blast_radius
    expect(template.scope.blast_radius).toBe("persistent");
    // Extra slots
    expect(template.scope.human_in_loop).toBe(true);
    expect(template.scope.confirmation).toBe("soft");
    expect(template.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("should mark LLM-estimated slots in _slot_sources", async () => {
    const template = await buildSituation(
      { type: "write", target: "/tmp/foo.txt" },
      makeSessionContext(),
      makeConfig(),
      makeMockGitCache(),
      stubEmbed,
    );

    expect(template._slot_sources).toBeDefined();
    expect(template._slot_sources!.effort_hours).toBe("llm_estimated");
    expect(template._slot_sources!.session_topic).toBe("llm_estimated");
    expect(template._slot_sources!.emotional_signals).toBe("llm_estimated");
    expect(template._slot_sources!.action_type).toBe("programmatic");
    expect(template._slot_sources!.recent_commits).toBe("programmatic");
    expect(template._slot_sources!.topic_drift).toBe("programmatic");
  });

  it("should compute topic_drift when topicCentroid is provided", async () => {
    // Topic centroid about "README" — action is about "database schema"
    const topicCentroid = new Float32Array([0, 1, 0, 0]); // README direction
    const context = makeSessionContext({ topicCentroid });

    const template = await buildSituation(
      { type: "overwrite", target: "/db/schema.sqlite" },
      context,
      makeConfig(),
      makeMockGitCache(),
      stubEmbed,
    );

    // stubEmbed('overwrite file /db/schema.sqlite') → contains 'database' → [1,0,0,0]
    // topicCentroid = [0,1,0,0]
    // cosine([1,0,0,0], [0,1,0,0]) = 0 → topic_drift = 1.0
    expect(template.context.topic_drift).toBeGreaterThan(0.5);
  });

  it("should handle non-file targets gracefully (email)", async () => {
    const template = await buildSituation(
      { type: "send_email", target: "user@example.com" },
      makeSessionContext(),
      makeConfig(),
      makeMockGitCache(),
      stubEmbed,
    );

    expect(template.action_type).toBe("send");
    expect(template.target_type).toBe("email");
    expect(template.target_metadata.age_hours).toBe(-1); // Not applicable
    expect(template.target_metadata.size).toBe(0); // Not applicable
    expect(template.scope.reversible).toBe("false"); // Emails can't be unsent
    expect(template.scope.blast_radius).toBe("external");
  });
});

// ── Tests: classifyActionType ─────────────────────────────────

describe("classifyActionType", () => {
  const config = makeConfig();

  it.each([
    ["write", "overwrite"],
    ["write_file", "overwrite"],
    ["create_file", "create"],
    ["delete_file", "delete"],
    ["rm", "delete"],
    ["send_message", "send"],
    ["send_email", "send"],
    ["git_merge", "merge"],
    ["git_push", "deploy"],
    ["exec", "execute"],
    ["run", "execute"],
    ["mv", "move"],
    ["cp", "copy"],
    ["edit", "modify"],
    ["patch", "modify"],
  ])('should map "%s" → "%s"', (input, expected) => {
    expect(classifyActionType(input, config)).toBe(expected);
  });

  it('should default unknown actions to "execute"', () => {
    expect(classifyActionType("unknown_action_xyz", config)).toBe("execute");
    expect(classifyActionType("do_something", config)).toBe("execute");
  });

  it("should respect config action_type_map overrides", () => {
    const customConfig = makeConfig({ action_type_map: { custom_op: "deploy" } });
    expect(classifyActionType("custom_op", customConfig)).toBe("deploy");
  });

  it("should be case-insensitive", () => {
    expect(classifyActionType("WRITE", config)).toBe("overwrite");
    expect(classifyActionType("Write_File", config)).toBe("overwrite");
  });
});

// ── Tests: classifyTargetType ─────────────────────────────────

describe("classifyTargetType", () => {
  const config = makeConfig();

  it.each([
    ["/home/user/file.txt", "file"],
    ["./relative/path.md", "file"],
    ["~/Documents/README.md", "file"],
    ["user@example.com", "email"],
    ["admin@company.org", "email"],
    ["+1234567890", "message"],
    ["whatsapp_group_id", "message"],
    ["telegram_channel", "message"],
    ["https://api.example.com/v1/users", "api_call"],
    ["http://localhost:8080/endpoint", "api_call"],
    ["/db/training.sqlite", "database"], // .sqlite extension → database
  ] as const)('should classify "%s" as "%s"', (target, expected) => {
    expect(classifyTargetType(target, config)).toBe(expected);
  });

  it("should respect config target_type_map overrides", () => {
    const customConfig = makeConfig({ target_type_map: { mydb: "database" } });
    expect(classifyTargetType("/data/mydb/schema", customConfig)).toBe("database");
  });
});

// ── Tests: getTargetAgeHours ──────────────────────────────────

describe("getTargetAgeHours", () => {
  it("should return -1 for non-file target types", async () => {
    expect(await getTargetAgeHours("user@example.com", "email")).toBe(-1);
    expect(await getTargetAgeHours("+1234567890", "message")).toBe(-1);
    expect(await getTargetAgeHours("https://api.example.com", "api_call")).toBe(-1);
  });

  it("should return -1 for non-existent files", async () => {
    const result = await getTargetAgeHours("/tmp/definitely_does_not_exist_xyz.txt", "file");
    expect(result).toBe(-1);
  });

  it("should return a positive number for existing files", async () => {
    // Use a file that definitely exists
    const result = await getTargetAgeHours("/etc/hostname", "file");
    // hostname file exists on Linux — should have a positive age
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

// ── Tests: getTargetSize ──────────────────────────────────────

describe("getTargetSize", () => {
  it("should return 0 for non-file target types", async () => {
    expect(await getTargetSize("user@example.com", "email")).toBe(0);
    expect(await getTargetSize("+1234567890", "message")).toBe(0);
  });

  it("should return 0 for non-existent files", async () => {
    const result = await getTargetSize("/tmp/definitely_does_not_exist_xyz.txt", "file");
    expect(result).toBe(0);
  });

  it("should return positive size for existing files", async () => {
    const result = await getTargetSize("/etc/hostname", "file");
    expect(result).toBeGreaterThan(0);
  });
});

// ── Tests: getLastHumanReference ─────────────────────────────

describe("getLastHumanReference", () => {
  it("should return 999 when target is never mentioned", () => {
    const transcripts = ["hello", "how are you", "lets do some work"];
    expect(getLastHumanReference("/src/obscure-file.ts", transcripts)).toBe(999);
  });

  it("should return 0 for the most recent transcript entry", () => {
    const transcripts = ["please update README.md"];
    // 1 entry, last entry (index 0), stepsBack = 0 → 0 * 5 / 60 = 0
    expect(getLastHumanReference("README.md", transcripts)).toBe(0);
  });

  it("should return hours proportional to how far back it was mentioned", () => {
    // 12 entries, target mentioned at index 6 → stepsBack = 5 → 5*5/60 hours
    const transcripts = [
      "other message 1",
      "other message 2",
      "other message 3",
      "other message 4",
      "other message 5",
      "other message 6",
      "please fix config.yaml", // index 6
      "other message 7",
      "other message 8",
      "other message 9",
      "other message 10",
      "latest message", // index 11
    ];
    const result = getLastHumanReference("config.yaml", transcripts);
    // stepsBack = 11 - 6 = 5 → 5 * 5 / 60 ≈ 0.417 hours
    expect(result).toBeCloseTo((5 * 5) / 60, 2);
  });

  it("should match by full path or basename", () => {
    const transcripts = ["edit /home/user/src/main.ts please"];
    // Should match both full path and basename
    expect(getLastHumanReference("/home/user/src/main.ts", transcripts)).toBe(0);
    expect(getLastHumanReference("main.ts", transcripts)).toBe(0);
  });
});

// ── Tests: crossCheckEffort ───────────────────────────────────

describe("crossCheckEffort", () => {
  it("should trust LLM estimate when it is higher than heuristic", () => {
    // LLM says 5h, heuristic says 1h → keep 5h
    const result = crossCheckEffort(5.0, 0.5, 5, 0);
    expect(result).toBe(5.0);
  });

  it("should override upward when LLM underestimates vs commits", () => {
    // LLM says 0.1h, but 10 recent commits (×0.5h each = 5h)
    const result = crossCheckEffort(0.1, 0, 0, 10);
    expect(result).toBeGreaterThan(0.1);
    // Should be around 0.7 * 5 = 3.5h from commit heuristic
    expect(result).toBeCloseTo(3.5, 0);
  });

  it("should override upward when LLM underestimates vs session duration", () => {
    // LLM says 0.5h, but sessionDuration=4h with 40 actions
    // heuristic = 4 * (40/10) = 16h (capped by plausibility)
    // 0.7 * 16 = 11.2h → overrides 0.5h
    const result = crossCheckEffort(0.5, 4, 40, 0);
    expect(result).toBeGreaterThan(0.5);
  });

  it("should never return negative effort", () => {
    const result = crossCheckEffort(0, 0, 0, 0);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

// ── Tests: crossCheckEmotion ──────────────────────────────────

describe("crossCheckEmotion", () => {
  it("should override calm with frustrated when many corrections", () => {
    const result = crossCheckEmotion("calm", 5, []);
    expect(result).toBe("frustrated");
  });

  it("should NOT override frustrated (non-calm estimates are preserved)", () => {
    const result = crossCheckEmotion("frustrated", 0, []);
    expect(result).toBe("frustrated");
  });

  it("should override calm with terse when messages are very short", () => {
    const shortMessages = ["ok", "no", "yes", "do it", "ok", "sure", "fine", "no", "ok", "hi"];
    const result = crossCheckEmotion("calm", 0, shortMessages);
    expect(result).toBe("terse");
  });

  it("should not override calm with terse when messages are normal length", () => {
    const normalMessages = [
      "Can you please update the README with the new configuration options?",
      "Also make sure to add tests for the new utility functions.",
      "The deployment should happen after the tests pass.",
    ];
    const result = crossCheckEmotion("calm", 0, normalMessages);
    expect(result).toBe("calm");
  });

  it("should respect 3-correction threshold boundary", () => {
    expect(crossCheckEmotion("calm", 2, [])).toBe("calm"); // 2 < 3 → no override
    expect(crossCheckEmotion("calm", 3, [])).toBe("frustrated"); // 3 >= 3 → override
    expect(crossCheckEmotion("calm", 4, [])).toBe("frustrated"); // 4 >= 3 → override
  });

  it("should return unknown signals unchanged", () => {
    expect(crossCheckEmotion("unknown", 0, [])).toBe("unknown");
    expect(crossCheckEmotion("excited", 0, [])).toBe("excited");
    expect(crossCheckEmotion("focused", 0, [])).toBe("focused");
  });
});

// ── Tests: getReversibility ───────────────────────────────────

describe("getReversibility", () => {
  const config = makeConfig();

  it.each([
    ["overwrite", "file", "true"],
    ["delete", "file", "partial"],
    ["send", "message", "false"],
    ["send", "email", "false"],
    ["merge", "git_operation", "true"],
    ["create", "file", "true"],
    ["modify", "file", "true"],
    ["execute", "system_command", "partial"],
    ["deploy", "deployment", "partial"],
    ["revert", "git_operation", "true"],
    ["move", "file", "true"],
    ["copy", "file", "true"],
  ] as const)("%s on %s should be %s", (action, target, expected) => {
    expect(getReversibility(action, target, config)).toBe(expected);
  });

  it("should respect config reversibility_map overrides", () => {
    const customConfig = makeConfig({
      reversibility_map: { "delete:database": "false" },
    });
    expect(getReversibility("delete", "database", customConfig)).toBe("false");
  });
});

// ── Tests: getBlastRadius ─────────────────────────────────────

describe("getBlastRadius", () => {
  const config = makeConfig();

  it.each([
    ["file", "persistent"],
    ["email", "external"],
    ["message", "external"],
    ["database", "persistent"],
    ["api_call", "external"],
    ["git_operation", "persistent"],
    ["system_command", "session"],
    ["configuration", "persistent"],
    ["deployment", "external"],
  ] as const)("%s should have blast radius %s", (target, expected) => {
    expect(getBlastRadius(target, config)).toBe(expected);
  });
});

// ── Tests: cosineSimilarity ───────────────────────────────────

describe("cosineSimilarity", () => {
  it("should return 1.0 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("should return 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("should return -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("should return 0 for zero vectors", () => {
    const z = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(z, v)).toBe(0);
    expect(cosineSimilarity(z, z)).toBe(0);
  });

  it("should return 0 for mismatched dimensions", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

// ── Tests: serializeSituation ─────────────────────────────────

describe("serializeSituation", () => {
  function makeTemplate() {
    return {
      action_type: "overwrite" as const,
      target_type: "file" as const,
      target_id: "README.md",
      target_metadata: {
        age_hours: 2160,
        size: 14200,
        recent_commits: 6,
        recent_authors: 4,
        effort_hours: 8.5,
        last_human_ref: 3,
      },
      context: {
        session_topic: "upstream merge automation",
        recent_corrections: 2,
        emotional_signals: "frustrated" as const,
        automation_depth: 2,
        topic_drift: 0.72,
      },
      scope: {
        reversible: "true" as const,
        blast_radius: "persistent" as const,
        human_in_loop: false,
        confirmation: "none" as const,
      },
      timestamp: "2026-03-22T20:00:00Z",
    };
  }

  it("should produce deterministic output for the same input", () => {
    const template = makeTemplate();
    const s1 = serializeSituation(template);
    const s2 = serializeSituation(template);
    expect(s1).toBe(s2);
  });

  it("should include action_type in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("overwrite");
  });

  it("should include target_type in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("file");
  });

  it("should include target_id in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("README.md");
  });

  it("should include size in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("14200");
  });

  it("should include age_hours in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("2160");
  });

  it("should include recent_commits in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("6 commits");
  });

  it("should include recent_authors in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("4 authors");
  });

  it("should include effort_hours in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("8.5");
  });

  it("should include emotional_signals in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("frustrated");
  });

  it("should include blast_radius in serialization", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("persistent");
  });

  it("should match the paper example format (README debacle §6.4)", () => {
    const s = serializeSituation(makeTemplate());
    // Verify format matches: 'Action: overwrite file "README.md". Target: 14200 bytes, 2160h old, ...'
    expect(s).toMatch(/^Action: overwrite file "README\.md"\./);
    expect(s).toContain("14200 bytes");
    expect(s).toContain("2160h old");
    expect(s).toContain("6 commits by 4 authors");
    expect(s).toContain("8.5h invested");
  });

  it("should include topic_drift with 2 decimal places", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("0.72");
  });

  it("should include human_in_loop status", () => {
    const s = serializeSituation(makeTemplate());
    expect(s).toContain("false");
  });
});
