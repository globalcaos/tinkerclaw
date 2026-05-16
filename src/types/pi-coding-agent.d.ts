export type OpenClawPiCodingAgentSkillSourceAugmentation = never;

declare module "@mariozechner/pi-coding-agent" {
  interface Skill {
    // OpenClaw relies on the source identifier returned by pi skill loaders.
    source: string;
  }

  // FORK 2026-05-16 (owner of 962b1622fd): the compaction-visibility commit
  // reads `entry.tokensAfter` in src/gateway/session-utils.fs.ts to render
  // the "before -> after tok" diff in the UI compaction banner (Bible §5.80).
  // The fork's compaction writer DOES persist this field
  // (src/agents/pi-embedded-runner/compaction-hooks.ts:274), but upstream's
  // CompactionEntry<T> only declares summary + tokensBefore — not
  // tokensAfter. esbuild/tsdown skips typecheck so the runtime always
  // worked, but `pnpm build:plugin-sdk:dts` (strict tsgo) failed with
  // TS2339. Declaration-merge the missing field here — same pattern as the
  // Skill.source augmentation above. Optional: older JSONL entries written
  // before the field existed won't carry it, and the read site already
  // guards with `typeof === "number" && Number.isFinite(...)`.
  interface CompactionEntry<T = unknown> {
    tokensAfter?: number;
  }
}
