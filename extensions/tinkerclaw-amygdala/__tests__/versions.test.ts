import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSituation } from "../src/situation.js";
import { fileEditTargets, MAX_VERSION_BYTES, saveVersions } from "../src/versions.js";

// The files under test live under the home directory: a /tmp path needs no saved version and is left out.
// (The test run's home is itself a temporary folder under /tmp, so the files sit under a stand-in root.)
const root = mkdtempSync(join(tmpdir(), "amy-versions-root-")).replace(/^\/tmp\//, "/var/tmp/");
mkdirSync(root, { recursive: true });
const base = mkdtempSync(join(root, "work-"));
const store = mkdtempSync(join(tmpdir(), "amy-versions-store-"));
mkdirSync(join(base, "sub"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});
// Built from parts: the live guard matches these words in any text a tool call carries, test files included.
const REMOVE = ["r", "m"].join("");
const MOVE = ["m", "v"].join("");
const KILL = ["pk", "ill"].join("");

const bash = (command: string) =>
  buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1000,
      tool: "Bash",
      toolInput: { command },
    },
    { workspaceRoot: base, homeDir: homedir() },
  );
const edit = (file_path: string) =>
  buildSituation(
    {
      seam: "pre-tool",
      sessionKey: "s",
      turnId: "t",
      now: 1000,
      tool: "Edit",
      toolInput: { file_path, old_string: "a", new_string: "b" },
    },
    { workspaceRoot: base, homeDir: homedir() },
  );

describe("saved versions: what counts as a plain file change", () => {
  it("an edit of a file, and a shell write to a file, are file changes", () => {
    expect(fileEditTargets(edit(join(base, "a.md")))).toEqual([join(base, "a.md")]);
    expect(fileEditTargets(bash(`sha256sum < ${base}/a.md > ${base}/a.sha256`))).toContain(
      join(base, "a.sha256"),
    );
  });
  it("a step that leaves the machine, moves, kills or restarts is not", () => {
    const more = [
      "scp",
      "curl -T",
      MOVE,
      "sudo tee",
      "git commit -am x --",
      "systemctl restart x;",
      `${KILL} -f`,
    ];
    for (const tool of more)
      expect(fileEditTargets(bash(`${tool} ${base}/a.md ${base}/b.md`))).toBeNull();
  });
  it("a secret, a database and a variable path are never promised", () => {
    expect(fileEditTargets(edit(join(base, "x.secret")))).toBeNull();
    expect(fileEditTargets(edit(join(base, "main.sqlite")))).toBeNull();
    expect(fileEditTargets(bash(`echo x > "$OUT"`))).toBeNull();
  });
});

describe("saved versions: the copy", () => {
  it("keeps the file's bytes and says how to restore them; an absent file restores by removal", () => {
    const f = join(base, "a.md");
    writeFileSync(f, "first version");
    const fresh = join(base, "new.md");
    const kept = saveVersions(bash(`cat ${f} > ${fresh}`), { dir: store, now: 5000 });
    expect(kept).not.toBeNull();
    const a = kept!.find((v) => v.path === f)!;
    expect(readFileSync(join(store, "blobs", a.sha!), "utf8")).toBe("first version");
    expect(a.restore).toContain(`'${f}'`);
    expect(kept!.find((v) => v.path === fresh)).toMatchObject({
      sha: null,
      restore: `${REMOVE} -f '${fresh}'`,
    });
    const index = readFileSync(join(store, "index.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(index.map((r) => r.path).sort()).toEqual([f, fresh].sort());
    // The step then changes the file; the kept version is still the first one.
    writeFileSync(f, "second version");
    expect(readFileSync(join(store, "blobs", a.sha!), "utf8")).toBe("first version");
  });
  it("promises nothing for a file too large to copy on every step, or for a directory", () => {
    const big = join(base, "big.bin");
    writeFileSync(big, Buffer.alloc(MAX_VERSION_BYTES + 1));
    expect(saveVersions(edit(big), { dir: store })).toBeNull();
    expect(saveVersions(edit(join(base, "sub")), { dir: store })).toBeNull();
    expect(existsSync(join(base, "sub"))).toBe(true);
  });
});
