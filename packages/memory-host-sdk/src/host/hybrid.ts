/**
 * FORK: shim restoring the upstream path `packages/memory-host-sdk/src/host/hybrid.ts`
 * that was dropped in the 2796-commit upstream merge. The only consumer in this
 * package is the (currently unwired) `storage/sqlite-store.ts`. Rather than
 * duplicating ~150 LOC we re-export from the live implementation in
 * `src/memory/hybrid.ts`.
 */
export {
  buildFtsQuery,
  bm25RankToScore,
  mergeHybridResults,
} from "../../../../src/memory/hybrid.js";
