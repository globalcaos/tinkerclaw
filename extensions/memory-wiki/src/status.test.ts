import { describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

describe("resolveMemoryWikiStatus", () => {
  it("reports missing vault and missing requested obsidian cli", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vault: { path: "/tmp/wiki" },
        obsidian: { enabled: true, useOfficialCli: true },
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => false,
      resolveCommand: async () => null,
    });

    expect(status.vaultExists).toBe(false);
    expect(status.obsidianCli.requested).toBe(true);
    expect(status.warnings.map((warning) => warning.code)).toEqual([
      "vault-missing",
      "obsidian-cli-missing",
    ]);
  });

  it("warns when unsafe-local is selected without explicit private access", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "unsafe-local",
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => "/usr/local/bin/obsidian",
    });

    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });
});

describe("renderMemoryWikiStatus", () => {
  it("includes warnings in the text output", () => {
    const rendered = renderMemoryWikiStatus({
      vaultMode: "isolated",
      renderMode: "native",
      vaultPath: "/tmp/wiki",
      vaultExists: false,
      bridge: {
        enabled: false,
        readMemoryCore: true,
        indexDreamReports: true,
        indexDailyNotes: true,
        indexMemoryRoot: true,
        followMemoryEvents: true,
      },
      obsidianCli: {
        enabled: true,
        requested: true,
        available: false,
        command: null,
      },
      unsafeLocal: {
        allowPrivateMemoryCoreAccess: false,
        pathCount: 0,
      },
      warnings: [{ code: "vault-missing", message: "Wiki vault has not been initialized yet." }],
    });

    expect(rendered).toContain("Wiki vault mode: isolated");
    expect(rendered).toContain("Warnings:");
    expect(rendered).toContain("Wiki vault has not been initialized yet.");
  });
});
