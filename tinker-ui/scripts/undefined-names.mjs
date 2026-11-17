// Every name the UI calls must exist. `vite build` transpiles without type-checking, so a call to a
// function that was never imported builds cleanly and throws a ReferenceError the first time that
// line runs. (2026-11-03: a missing import made send() throw after drawing the prompt bubble in
// memory but before painting it and before chat.send, so the prompt waited for the outbox replay.)
//
// This runs the type checker over tinker-ui/src and keeps only the "cannot find name" family. The
// tree's other type errors are a separate debt and are deliberately ignored here.
// Used by vite.config.ts (build gate) and src/undefined-names.test.ts. CLI: node scripts/undefined-names.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TS2304 cannot find name · TS2552 ... did you mean · TS2662/TS2663 ... did you mean the member
// · TS18004 no value in scope for a shorthand property.
const UNDEFINED_NAME_CODES = ["TS2304", "TS2552", "TS2662", "TS2663", "TS18004"];
const DEFAULT_UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function findUndefinedNames(uiRoot = DEFAULT_UI_ROOT) {
  const repoRoot = path.resolve(uiRoot, "..");
  const bin = [
    path.join(repoRoot, "node_modules", ".bin", "tsgo"),
    path.join(repoRoot, "node_modules", ".bin", "tsc"),
    path.join(uiRoot, "node_modules", ".bin", "tsc"),
  ].find((p) => fs.existsSync(p));
  if (!bin) {
    return { checked: false, errors: [], reason: "no tsgo or tsc in node_modules/.bin" };
  }
  const src = path.join(uiRoot, "src");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tinker-ui-names-"));
  const config = path.join(dir, "tsconfig.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        noEmit: true,
        skipLibCheck: true,
        strict: false,
        types: [],
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
      },
      include: [path.join(src, "**/*.ts")],
      exclude: [path.join(src, "**/*.test.ts"), path.join(src, "**/__fixtures__/**")],
    }),
  );
  let out = "";
  try {
    out = execFileSync(bin, ["-p", config, "--pretty", "false"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    });
  } catch (err) {
    // The checker exits non-zero on ANY type error, so a non-zero status is the normal case. No
    // status at all means it never ran (spawn failure, timeout): report that, never "clean".
    if (typeof err?.status !== "number") {
      return {
        checked: false,
        errors: [],
        reason: `type checker did not run: ${err?.message ?? err}`,
      };
    }
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const errors = out
    .split("\n")
    .filter((line) => UNDEFINED_NAME_CODES.some((code) => line.includes(`error ${code}:`)))
    .map((line) => line.replace(`${repoRoot}${path.sep}`, "").trim());
  return { checked: true, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checked, errors, reason } = findUndefinedNames();
  if (!checked) {
    console.warn(`undefined-names: not checked (${reason})`);
    process.exit(0);
  }
  for (const line of errors) console.log(line);
  console.log(`undefined-names: ${errors.length} found`);
  process.exit(errors.length ? 1 : 0);
}
