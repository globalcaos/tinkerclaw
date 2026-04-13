/**
 * FORK: shim restoring the upstream path `packages/memory-host-sdk/src/host/manager-search.ts`
 * that was dropped in the 2796-commit upstream merge. The only consumer in this
 * package is the (currently unwired) `storage/sqlite-store.ts`. Re-exports the
 * live implementation from `src/memory/manager-search.ts`.
 */
export { searchVector, searchKeyword } from "../../../../src/memory/manager-search.js";
