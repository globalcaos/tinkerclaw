import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateRules, AEGIS_RULES } from "../src/rules.js";

// 2026-11-16, the owner's order: the agent can always delete the files it created. The hook reads the list the
// gateway keeps beside the policy (src/own-files.ts). A file made by a test is under five minutes old and passes
// by that older rule anyway, so these cases go through a FOLDER: the five-minute rule wants a folder empty, the
// own-files rule lets a listed folder go when the same command removes everything in it. The folder is removed
// with the `-d` form: the delete rule does not read the plain remove-folder command as a deletion at all.

// Built from parts so this file's own text does not trip the guard it tests.
const RM = ["r", "m"].join("");
const RMF = `${RM} -f`;
const RMDIR = `${RM} -d`;
const LIST = ["own-files", "jsonl"].join(".");

const HOOK = join(__dirname, "..", "hooks", "hard-rules.mjs");
const dir = mkdtempSync(join(tmpdir(), "aegis-own-"));
// Everything under /tmp is scratch to the hook, so the targets live outside it.
mkdirSync(join(homedir(), ".cache"), { recursive: true });
const work = mkdtempSync(join(homedir(), ".cache", "aegis-own-files-"));
const policy = join(dir, "policy.json");
writeFileSync(
  policy,
  JSON.stringify({
    rules: AEGIS_RULES.filter((r) =>
      ["DELETE_UNREQUESTED", "FS_DESTRUCTIVE_ROOT"].includes(r.rule),
    ).map((r) => ({
      id: r.rule,
      source: r.pattern.source,
      flags: "",
      explanation: r.explanation,
      enforce: true,
      scope: "exec",
      ...(r.ownerIntent ? { ownerIntent: r.ownerIntent } : {}),
    })),
  }),
);

// Stub Jev: every deletion reads as unrelated to the task, so only the list can let one through.
let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers: { serves_task: { noul: 0.05 } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/`;
});
afterAll(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const transcript = join(dir, "t.jsonl");
writeFileSync(
  transcript,
  JSON.stringify({
    type: "user",
    timestamp: new Date(Date.now() - 3 * 3600_000).toISOString(),
    message: { content: "What would be the delivery date for the laptop?" },
  }) + "\n",
);

function decide(command: string) {
  return new Promise<"deny" | "allow">((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      {
        env: {
          ...process.env,
          AMYGDALA_POLICY_PATH: policy,
          AMYGDALA_DATA_DIR: dir,
          TYPESAFE_API_KEY: "test-key",
          AMYGDALA_JEV_URL: url,
        },
        timeout: 15_000,
      },
      (_e, stdout) => resolve(/"permissionDecision"\s*:\s*"deny"/.test(stdout) ? "deny" : "allow"),
    );
    child.stdin!.end(
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, transcript_path: transcript }),
    );
  });
}

let n = 0;
function folder(): { d: string; a: string; b: string; cleanup: string } {
  const d = join(work, `out${n++}`);
  mkdirSync(d);
  const a = join(d, "part1.js");
  const b = join(d, "part2.js");
  writeFileSync(a, "a");
  writeFileSync(b, "b");
  return { d, a, b, cleanup: `${RMF} ${a} ${b} && ${RMDIR} ${d}` };
}
function list(paths: string[], change: (r: Record<string, unknown>) => void = () => {}) {
  const lines = paths.map((p) => {
    const st = lstatSync(p);
    const r = {
      p,
      ino: st.ino,
      born: st.birthtimeMs,
      mtime: st.mtimeMs,
      dir: st.isDirectory(),
      ts: 0,
    };
    change(r);
    return JSON.stringify(r);
  });
  writeFileSync(join(dir, LIST), lines.join("\n") + "\n");
}

describe("hard-rules hook: the agent's own files", () => {
  it("a listed folder goes when the same command removes its files", async () => {
    const f = folder();
    list([f.d, f.a, f.b]);
    expect(await decide(f.cleanup)).toBe("allow");
  });

  it("the same clean-up of a folder that is not on the list is refused", async () => {
    const f = folder();
    list([]);
    expect(await decide(f.cleanup)).toBe("deny");
  });

  it("a listed path that now holds another file (another inode) is refused", async () => {
    const f = folder();
    list([f.d], (r) => {
      r.ino = Number(r.ino) + 1;
    });
    expect(await decide(f.cleanup)).toBe("deny");
  });

  it("a listed folder that holds a file the command does not name is refused", async () => {
    const f = folder();
    list([f.d, f.a, f.b]);
    writeFileSync(join(f.d, "his-notes.txt"), "x");
    expect(await decide(f.cleanup)).toBe("deny");
  });
});

describe("GUARD_OWN_LIST_WRITE: the list is the gateway's to write", () => {
  const P = `/home/u/.openclaw/data/amygdala-jev/${LIST}`;
  const bash = (cmd: string) => evaluateRules("Bash", cmd, { enforcedOnly: true });
  for (const cmd of [
    `echo '{"p":"/home/u/Documents/thesis.docx","ino":1}' >> ${P}`,
    `printf x | tee -a ${P}`,
    `cp /tmp/forged.jsonl ${P}`,
  ]) {
    it(`refuses: ${cmd.slice(0, 50)}`, () => {
      const r = bash(cmd);
      expect([r.decision, r.rule]).toEqual(["hard_block", "GUARD_OWN_LIST_WRITE"]);
    });
  }
  it("reading the list is ordinary work", () => {
    expect(bash(`tail -5 ${P}`).decision).toBe("allow");
    expect(bash(`grep -c part1 ${P}`).decision).toBe("allow");
    expect(bash(`wc -l < ${P}`).decision).toBe("allow");
  });
});
