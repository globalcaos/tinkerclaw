// tinker-ui/src/panels/aa-effort-index.ts
// MOVED 2026-09-02 to src/shared/aa-effort-index.ts so the gateway router (THALAMUS)
// reads the same per-effort table the chart draws. This path stays as a re-export so
// the panel imports and tests keep working; edit the shared file.
export * from "../../../src/shared/aa-effort-index.js";
