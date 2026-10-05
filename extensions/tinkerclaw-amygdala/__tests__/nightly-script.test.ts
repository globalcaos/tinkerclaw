import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL("../scripts/nightly.mjs", import.meta.url).pathname;
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const WORKLIST = {
  online: { tighten: [], loosen: [] },
  worklist: [
    {
      questionId: "q-one",
      failing: [{ caseId: "c1", expected: "at most proceed", got: "note", answers: {} }],
    },
    {
      questionId: "q-two",
      failing: [{ caseId: "c2", expected: "at least hold", got: "proceed", answers: {} }],
    },
  ],
};

/** Stub `openclaw` and `claude` in a temp dir; every call is appended to calls.log. */
function stubs(o: { claudeOut?: string; hangOn?: string; failOn?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "amyg-nightly-"));
  tmps.push(dir);
  writeFileSync(join(dir, "worklist.json"), JSON.stringify(WORKLIST));
  writeFileSync(
    join(dir, "claude-out.txt"),
    o.claudeOut ?? '```json\n{"instructions":"test-wording"}\n```\n',
  );
  writeFileSync(
    join(dir, "openclaw"),
    `#!/bin/sh
echo "openclaw $3 $5" >> "${dir}/calls.log"
[ "$3" = "${o.hangOn ?? "none"}" ] && exec sleep 30
[ "$3" = "${o.failOn ?? "none"}" ] && { echo boom >&2; exit 3; }
case "$3" in
  amygdala2.nightly) cat "${dir}/worklist.json" ;;
  amygdala2.questionRecord) echo '{"id":"x","instructions":"test-record"}' ;;
  amygdala2.propose) echo '{"outcome":"applied"}' ;;
esac
`,
  );
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh
echo "claude $*" >> "${dir}/calls.log"
cat > "${dir}/claude-prompt.txt"
cat "${dir}/claude-out.txt"
`,
  );
  chmodSync(join(dir, "openclaw"), 0o755);
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
  } catch {
    // no call was made
  }
  return { status: r.status, out: r.stdout, err: r.stderr, calls };
}

describe("nightly.mjs", () => {
  it("full flow: worklist, record, claude, propose for each item", () => {
    const dir = stubs();
    const r = run(dir, []);
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("openclaw amygdala2.propose"))).toHaveLength(2);
    expect(r.calls.filter((c) => c.startsWith("claude"))).toEqual([
      "claude -p --model opus --output-format text",
      "claude -p --model opus --output-format text",
    ]);
    expect(r.out).toContain("q-one");
    expect(r.out).toContain('"outcome":"applied"');
    const prompt = readFileSync(join(dir, "claude-prompt.txt"), "utf8");
    expect(prompt).toContain("test-record");
    expect(prompt).toContain("q-two");
  });

  it("--model is passed to claude", () => {
    const r = run(stubs(), ["--model", "sonnet", "--max", "1"]);
    expect(r.calls.some((c) => c === "claude -p --model sonnet --output-format text")).toBe(true);
  });

  it("--dry-run calls nothing but the worklist and prints the prompts", () => {
    const r = run(stubs(), ["--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['openclaw amygdala2.nightly {"phase":"worklist"}']);
    expect(r.out).toContain("[dry-run] prompt for q-one");
    expect(r.out).toContain("would call amygdala2.propose for q-two");
  });

  it("--max limits the items", () => {
    const r = run(stubs(), ["--max", "1"]);
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith("claude"))).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith("openclaw amygdala2.propose"))).toHaveLength(1);
  });

  it("a hanging gateway call hits the script's timeout and fails hard", () => {
    const r = run(stubs({ hangOn: "amygdala2.nightly" }), [], {
      AMYGDALA_NIGHTLY_WORKLIST_MS: "400",
    });
    expect(r.status).toBe(1);
    expect(r.err).toContain("timed out");
  });

  it("a hanging claude fails hard with no propose", () => {
    const dir = stubs();
    writeFileSync(join(dir, "claude"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(dir, "claude"), 0o755);
    const r = run(dir, [], { AMYGDALA_NIGHTLY_CLAUDE_MS: "400" });
    expect(r.status).toBe(1);
    expect(r.err).toContain("claude timed out");
    expect(r.calls.some((c) => c.startsWith("openclaw amygdala2.propose"))).toBe(false);
  });

  it("non-JSON from claude skips the item with an error line and still exits 0", () => {
    const r = run(stubs({ claudeOut: "I would reword it like this, but no JSON.\n" }), []);
    expect(r.status).toBe(0);
    expect(r.err).toContain("q-one: skipped");
    expect(r.calls.some((c) => c.startsWith("openclaw amygdala2.propose"))).toBe(false);
  });

  it("a candidate of the wrong shape is skipped", () => {
    const r = run(stubs({ claudeOut: '{"fields": "not-an-array"}' }), ["--max", "1"]);
    expect(r.status).toBe(0);
    expect(r.err).toContain("fields must be an array");
  });

  it("a failing propose is a hard failure", () => {
    const r = run(stubs({ failOn: "amygdala2.propose" }), []);
    expect(r.status).toBe(1);
    expect(r.err).toContain("boom");
    expect(r.calls.filter((c) => c.startsWith("openclaw amygdala2.propose"))).toHaveLength(1);
  });
});
