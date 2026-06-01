/**
 * ENGRAM — Skill library (Upgrade 6, J5 Voyager skill-library-as-code).
 *
 * Versioned, never-delete registry of extracted Skills, modeled on
 * artifact-store.ts / recipe-archive.ts (ULID skillIds, JSON sidecars, factory).
 * A skill is the addressable, first-class form of transferable procedural
 * knowledge: stored once, ranked by empirical success rate, and retrieved on
 * future tasks so competence compounds (Voyager's growing skill library).
 *
 * Layout under <baseDir>/skill-library/:
 *   library.json                       — { skillId -> SkillLibraryIndexEntry }
 *   skill-<skillId>/v<n>.json          — the full Skill body for version n
 *
 * NEVER deletes — `deprecate()` marks a skill obsolete while `read()` still
 * returns its body (the never-delete invariant; an obsolete skill stays
 * recoverable and auditable). A re-extracted same-named skill bumps `version`;
 * a near-identical skill (Jaccard > 0.8 over its text, the phase-2 dedup
 * convention) is treated as the same skill, not a duplicate (library-bloat
 * mitigation, risk #3).
 *
 * SEARCH reuses the existing retrieval machinery rather than reinventing it:
 *   - semantic: the recall-tool embedding path (an injected EmbedFn embeds the
 *     query AND all live skill texts in ONE batch — no N+1), cosine-ranked.
 *   - keyword:  a token-overlap fallback when no EmbedFn is wired (and used to
 *     merge with the semantic ranking), matching textSimilarity in recall-tool.
 *
 * The Cerebellum owns the library + fitness; the Prefrontal kit-runner owns
 * execution (skill-invocation.ts records the outcome back here) — the same
 * split as Upgrade 1's recipe archive.
 *
 * FORK-ISOLATED: unique to our fork (Sleep Consolidation paper, Upgrade 6).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Skill, SkillRef } from "../storage/types.js";
import type { EmbedFn } from "./embedding-worker.js";
import { laplaceSkillRate } from "./skill-extraction.js";

/** Jaccard threshold above which two skills are considered the same (phase-2 convention). */
export const SKILL_DEDUP_JACCARD = 0.8;

export interface SkillLibraryOptions {
  baseDir: string;
  /** Optional embedding fn for semantic search; falls back to keyword overlap when absent. */
  embedFn?: EmbedFn;
}

export interface SkillSearchOptions {
  /** Exclude deprecated skills from results (default true). */
  excludeDeprecated?: boolean;
}

export interface SkillLibrary {
  /**
   * Store a skill. If a live skill with the same `name` exists, this becomes a
   * new VERSION of it (not a duplicate). If an existing skill (same name OR
   * Jaccard > 0.8 over the body text) already covers it, the existing skill's
   * sourceEpisodeIds are merged and its ref returned (semantic-near dedup).
   */
  put(skill: Skill): Promise<SkillRef>;
  /** Read a skill's full body (latest version), even if deprecated. */
  read(skillId: string): Skill | undefined;
  /** Semantic (embedding) + keyword search; returns top-k SkillRefs by relevance. */
  search(query: string, k?: number, opts?: SkillSearchOptions): Promise<SkillRef[]>;
  /** Rank live skills by successRate, tie-broken by recency (created). */
  rank(useCase?: string): SkillRef[];
  /** Record an execution outcome into a skill's successMetrics (monotonic counters). */
  recordOutcome(skillId: string, success: boolean, atISO?: string): void;
  /** Mark a skill deprecated — never deletes the body. */
  deprecate(skillId: string): void;
  /** List all live (non-deprecated) skill refs. */
  list(opts?: SkillSearchOptions): SkillRef[];
}

interface SkillLibraryIndexEntry {
  skillId: string;
  name: string;
  versions: number[];
}

function slugify(skillId: string): string {
  return skillId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** The text used for dedup + keyword/semantic matching of a skill. */
export function skillText(skill: Skill | Pick<Skill, "name" | "description" | "steps">): string {
  return [skill.name, skill.description, ...skill.steps].join(" ");
}

/** Tokenize for Jaccard / keyword overlap (lowercased word set). */
function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
}

/** Jaccard similarity over token sets (phase-2 dedup convention). */
export function jaccard(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) {
      inter++;
    }
  }
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Cosine similarity between two embedding vectors. */
function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function toRef(skill: Skill, score?: number): SkillRef {
  const ref: SkillRef = {
    skillId: skill.skillId,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    successRate: skill.successMetrics.successRate,
    deprecated: skill.deprecated,
  };
  if (score !== undefined) {
    ref.score = score;
  }
  return ref;
}

export function createSkillLibrary(options: SkillLibraryOptions): SkillLibrary {
  const root = join(options.baseDir, "skill-library");
  const indexPath = join(root, "library.json");
  const embedFn = options.embedFn;
  mkdirSync(root, { recursive: true });

  function loadIndex(): Record<string, SkillLibraryIndexEntry> {
    if (!existsSync(indexPath)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(indexPath, "utf-8"));
    } catch {
      return {};
    }
  }

  function saveIndex(idx: Record<string, SkillLibraryIndexEntry>): void {
    // Atomic write: tmp + rename so a crash mid-write never corrupts the index
    // (curiosity-store atomic-write convention).
    const tmp = `${indexPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2));
    // node:fs rename is atomic on the same filesystem.
    renameSync(tmp, indexPath);
  }

  function bodyPath(skillId: string, version: number): string {
    return join(root, `skill-${slugify(skillId)}`, `v${version}.json`);
  }

  function readVersion(skillId: string, version: number): Skill | undefined {
    const p = bodyPath(skillId, version);
    if (!existsSync(p)) {
      return undefined;
    }
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as Skill;
    } catch {
      return undefined;
    }
  }

  function writeVersion(skill: Skill): void {
    const dir = join(root, `skill-${slugify(skill.skillId)}`);
    mkdirSync(dir, { recursive: true });
    const p = bodyPath(skill.skillId, skill.version);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(skill, null, 2));
    renameSync(tmp, p);
  }

  function latestVersion(skillId: string): Skill | undefined {
    const idx = loadIndex();
    const entry = idx[skillId];
    if (!entry || entry.versions.length === 0) {
      return undefined;
    }
    return readVersion(skillId, entry.versions[entry.versions.length - 1]);
  }

  function allLatest(opts?: SkillSearchOptions): Skill[] {
    const excludeDeprecated = opts?.excludeDeprecated ?? true;
    const idx = loadIndex();
    const out: Skill[] = [];
    for (const skillId of Object.keys(idx)) {
      const s = latestVersion(skillId);
      if (!s) {
        continue;
      }
      if (excludeDeprecated && s.deprecated) {
        continue;
      }
      out.push(s);
    }
    return out;
  }

  /** Find an existing live skill that matches by name OR Jaccard > threshold. */
  function findExisting(skill: Skill): Skill | undefined {
    const idx = loadIndex();
    const candidateText = skillText(skill);
    for (const skillId of Object.keys(idx)) {
      const latest = latestVersion(skillId);
      if (!latest || latest.deprecated) {
        continue;
      }
      if (latest.name === skill.name) {
        return latest;
      }
      if (jaccard(candidateText, skillText(latest)) > SKILL_DEDUP_JACCARD) {
        return latest;
      }
    }
    return undefined;
  }

  return {
    async put(skill) {
      const existing = findExisting(skill);
      if (existing) {
        // Same skill recurring → new VERSION carrying merged provenance, keeping
        // the existing skillId + accumulated successMetrics (never reset fitness).
        const mergedEpisodeIds = [
          ...new Set([...existing.sourceEpisodeIds, ...skill.sourceEpisodeIds]),
        ];
        const nextVersion = existing.version + 1;
        const newVersion: Skill = {
          ...existing,
          version: nextVersion,
          // Adopt the freshly-extracted procedure text/code (the newer wording),
          // but keep id + metrics + created.
          name: existing.name,
          description: skill.description || existing.description,
          prerequisites: skill.prerequisites.length ? skill.prerequisites : existing.prerequisites,
          steps: skill.steps.length ? skill.steps : existing.steps,
          testCases: skill.testCases.length ? skill.testCases : existing.testCases,
          sourceEpisodeIds: mergedEpisodeIds,
          deprecated: false,
          ...(skill.verifiedCode !== undefined
            ? { verifiedCode: skill.verifiedCode }
            : existing.verifiedCode !== undefined
              ? { verifiedCode: existing.verifiedCode }
              : {}),
        };
        writeVersion(newVersion);
        const idx = loadIndex();
        const entry = idx[existing.skillId];
        if (entry && !entry.versions.includes(nextVersion)) {
          entry.versions.push(nextVersion);
          entry.versions.sort((a, b) => a - b);
          saveIndex(idx);
        }
        return toRef(newVersion);
      }

      // Brand-new skill.
      writeVersion(skill);
      const idx = loadIndex();
      idx[skill.skillId] = {
        skillId: skill.skillId,
        name: skill.name,
        versions: [skill.version],
      };
      saveIndex(idx);
      return toRef(skill);
    },

    read(skillId) {
      return latestVersion(skillId);
    },

    async search(query, k = 5, opts) {
      const skills = allLatest(opts);
      if (skills.length === 0) {
        return [];
      }

      let scored: { skill: Skill; score: number }[];

      if (embedFn) {
        // ONE batch embed: [query, ...skillTexts] — no N+1 (recall-tool path).
        const texts = [query, ...skills.map((s) => skillText(s))];
        const vectors = await embedFn(texts);
        const queryVec = vectors[0];
        scored = skills.map((s, i) => ({
          skill: s,
          score: cosine(queryVec, vectors[i + 1]),
        }));
      } else {
        // Keyword fallback: token-overlap relevance (matches recall-tool textSimilarity).
        scored = skills.map((s) => ({
          skill: s,
          score: jaccard(query, skillText(s)),
        }));
      }

      return scored
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((x) => toRef(x.skill, x.score));
    },

    rank(_useCase) {
      const skills = allLatest({ excludeDeprecated: true });
      return skills
        .sort((a, b) => {
          const ds = b.successMetrics.successRate - a.successMetrics.successRate;
          if (ds !== 0) {
            return ds;
          }
          // tie-break: more recent first.
          return new Date(b.created).getTime() - new Date(a.created).getTime();
        })
        .map((s) => toRef(s));
    },

    recordOutcome(skillId, success, atISO = new Date().toISOString()) {
      const latest = latestVersion(skillId);
      if (!latest) {
        return;
      }
      const invocations = latest.successMetrics.invocations + 1;
      const successes = latest.successMetrics.successes + (success ? 1 : 0);
      const updated: Skill = {
        ...latest,
        successMetrics: {
          invocations,
          successes,
          successRate: laplaceSkillRate(successes, invocations),
          lastInvoked: atISO,
        },
      };
      writeVersion(updated);
    },

    deprecate(skillId) {
      const latest = latestVersion(skillId);
      if (!latest) {
        return;
      }
      writeVersion({ ...latest, deprecated: true });
    },

    list(opts) {
      return allLatest(opts).map((s) => toRef(s));
    },
  };
}
