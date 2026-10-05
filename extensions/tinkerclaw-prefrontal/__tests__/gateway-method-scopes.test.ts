// Every gateway method this plugin registers must carry an explicit operator.admin
// scope, and every registered name must appear in the README's method table.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import register from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));

function collectRegistrations() {
  const methods: Array<{ name: string; scope: string | undefined }> = [];
  const noop = () => {};
  const api = new Proxy(
    {
      config: {},
      registrationMode: "setup-runtime",
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      registerGatewayMethod: (name: string, _h: unknown, opts?: { scope?: string }) => {
        methods.push({ name, scope: opts?.scope });
      },
    } as Record<string, unknown>,
    { get: (t, k: string) => (k in t ? t[k] : noop) },
  );
  register(api as never);
  return methods;
}

describe("prefrontal gateway method scopes", () => {
  const methods = collectRegistrations();

  it("registers the known method set", () => {
    expect(methods.length).toBeGreaterThanOrEqual(20);
    expect(methods.map((m) => m.name)).toEqual(
      expect.arrayContaining(["prefrontal.config", "prefrontal.orcaBias", "prefrontal.plan.set"]),
    );
  });

  it("pins every method to operator.admin", () => {
    const unscoped = methods.filter((m) => m.scope !== "operator.admin").map((m) => m.name);
    expect(unscoped).toEqual([]);
  });

  it("documents every method in the README", () => {
    const readme = readFileSync(join(here, "..", "README.md"), "utf-8");
    const missing = methods
      .map((m) => m.name.replace(/^prefrontal\./, "").replace(/^kit\./, "recipe."))
      .filter((n) => !readme.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });
});
