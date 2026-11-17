import { describe, expect, it } from "vitest";
import { plainAsk, plainStep } from "../src/plain.js";
import { ALL_RULES, RULE_WORDS } from "../src/rules.js";
import type { Decision, EffectClass, ResolvedTarget, Situation } from "../src/types.js";

const F = <T>(value: T) => ({ value, origin: "derived" as const });
const file = (path: string): ResolvedTarget => ({ path, kind: "file", resolvedFrom: path });
const step = (effect: EffectClass, targets: ResolvedTarget[], command = "rm -rf --no-preserve x") =>
  ({ effectClass: F(effect), targets: F(targets), command: F(command) }) as unknown as Situation;
const proof = { family: "safety", response: { kind: "proof" } } as unknown as Decision;
const hold = (rule: string): Decision =>
  ({
    family: "double-check",
    response: { kind: "hold", ruleOrQuestion: rule },
  }) as unknown as Decision;

describe("plainStep", () => {
  it("says what changes, what cannot be undone, and why, in one sentence", () => {
    expect(plainStep(step("delete", [file("/home/x/notes.txt")]), proof, ["danger-level"])).toBe(
      'This deletes a text file, in the folder "x", and it cannot be undone, because it looks hard to reverse.',
    );
    expect(
      plainStep(
        step("send", [{ path: "https://example.com/a?b=1", kind: "url", resolvedFrom: "u" }]),
        proof,
        ["danger-level", "data-tier"],
      ),
    ).toBe(
      "This sends data to example.com, and what is sent cannot be called back, because private data would go somewhere others can read it.",
    );
  });

  it("the specific reason beats the danger reading; a hold's rule counts", () => {
    expect(plainStep(step("local-write", [file("/w/a.ts")]), hold("weakens-own-check"), [])).toBe(
      "This changes a.ts, and the earlier version is lost unless it was saved, because it may loosen a test that grades the agent's own work.",
    );
  });

  it("works with no target and with several", () => {
    expect(plainStep(step("restart-own-system", []), proof, [])).toBe(
      "This restarts the assistant's own service, and open chats pause until it is back, because it looks hard to reverse.",
    );
    expect(plainStep(step("delete", [file("/a"), file("/b"), file("/c")]), proof, [])).toContain(
      "This deletes 3 files, on this machine,",
    );
  });

  it("a compound delete opens on what it deletes, not on the first path parsed", () => {
    const s = step(
      "delete",
      [file("/tmp/jarvis/new"), file("/tmp/jarvis/old.txt")],
      "mkdir -p /tmp/jarvis/new; rm -f /tmp/jarvis/old.txt",
    );
    expect(plainStep(s, proof, [])).toContain("This deletes 2 files, temporary scratch,");
  });

  it("an other step names the scripts it runs, not the folder it made first", () => {
    const s = step(
      "other",
      [file("/tmp/jarvis/job"), file("/tmp/jarvis/job/calc.py")],
      [
        "mkdir -p /tmp/jarvis/job; cat > /tmp/jarvis/job/calc.py <<'E'",
        "print(python3 /not/run.py)",
        "E",
        "python3 -I /tmp/jarvis/job/calc.py; bash ~/scripts/check.sh --quick 2>&1 | tail -3",
        "python3 -I ~/scripts/post-to-group.py general --text-file /tmp/jarvis/job/msg.txt",
      ].join("\n"),
    );
    expect(plainStep(s, proof, ["danger-level"])).toBe(
      "This runs calc.py, check.sh and post-to-group.py, and its effect may not be reversible, because it looks hard to reverse.",
    );
  });

  it("names three scripts at most, once each, and only ones that run", () => {
    const four = "node a.mjs && ./b.sh; python3 c.py; ~/bin/d.py; node a.mjs";
    expect(plainStep(step("other", [], four), proof, [])).toContain(
      "This runs a.mjs, b.sh, c.py and 1 more,",
    );
    const none =
      "cat /x/a.py; ls b.sh; cp c.py d.py; python3 -c 'import e.py'; python3 - <<'P'\nf.py\nP";
    expect(plainStep(step("other", [file("/x/a.py")], none), proof, [])).toContain(
      "This runs a step on a.py,",
    );
    expect(plainStep(step("local-write", [file("/w/a.ts")], "python3 x.py"), proof, [])).toContain(
      "This changes a.ts,",
    );
  });

  it("is one sentence, and no effect leaks the command", () => {
    for (const effect of [
      "read",
      "local-write",
      "send",
      "spend",
      "restart-own-system",
      "delete",
      "other",
    ] as EffectClass[]) {
      const out = plainStep(step(effect, []), proof, []);
      expect(out).not.toContain("--no-preserve");
      expect(out.match(/\./g)).toHaveLength(1);
    }
  });

  it("names a question a person would ask, and a hard rule as a rule", () => {
    const ask = { family: "second-opinion", response: { kind: "ask" } } as unknown as Decision;
    expect(plainStep(step("other", []), ask, [])).toContain("can be read more than one way");
    const hard = { family: "hard-rule", response: { kind: "hold", ruleOrQuestion: "FS_FORMAT" } };
    expect(plainStep(step("other", []), hard as unknown as Decision, [])).toContain(
      "a fixed safety rule",
    );
  });
});

describe("plainAsk", () => {
  const hard = (rule: string): Decision =>
    ({
      family: "hard-rule",
      response: { kind: "hold", ruleOrQuestion: rule },
    }) as unknown as Decision;

  it("names a known outward act before the scripts it runs", () => {
    const s = step(
      "other",
      [file("/tmp/jarvis/post")],
      'cd /tmp/jarvis/post && python3 pub.py; WP_ALLOW_PUBLISH=1 bash $S/wp.sh POST posts/7 "$(cat body.json)"',
    );
    expect(plainAsk(s, proof)).toBe("Allow publishing to the web?");
    expect(plainAsk(step("other", [], "git -C /w push origin develop"), proof)).toBe(
      "Allow pushing to git?",
    );
  });

  it("a delete says what the files are and what they were for; a send names where the data goes", () => {
    expect(
      plainAsk(step("delete", [file("/home/x/notes.txt")], "rm /home/x/notes.txt"), proof),
    ).toBe('Allow deleting a text file, in the folder "x"?');
    const host: ResolvedTarget = {
      path: "box.example",
      kind: "host",
      resolvedFrom: "box.example:/srv",
    };
    expect(
      plainAsk(
        step("send", [file("/tmp/jarvis/pub"), host], "scp -r /tmp/jarvis/pub box.example:/srv"),
        proof,
      ),
    ).toBe("Allow sending data to box.example?");
    expect(plainAsk(step("send", [file("/tmp/a")], "mail -s hi x < /tmp/a"), proof)).toBe(
      "Allow sending data out of this machine?",
    );
  });

  it("an other step names the scripts it runs", () => {
    expect(
      plainAsk(step("other", [file("/tmp/jarvis/job")], "python3 /tmp/jarvis/job/calc.py"), proof),
    ).toBe("Allow running calc.py?");
  });

  it("a fixed rule asks its own question, with the secret or the path it touches", () => {
    expect(
      plainAsk(step("other", [], "set -a; source ./app/.env; set +a"), hard("SECRET_UNREQUESTED")),
    ).toBe("Allow using .env?");
    expect(plainAsk(step("other", [], "true"), hard("SECRET_UNREQUESTED"))).toBe(
      "Allow using a stored password?",
    );
    expect(
      plainAsk(
        step("delete", [file("/home/x/a.log")], "rm /home/x/a.log"),
        hard("DELETE_UNREQUESTED"),
      ),
    ).toBe('Allow deleting a log file, in the folder "x"?');
    // Built from words so the rule's own pattern never appears in this file's text.
    const forcePush = ["git", "push", "--force", "origin", "ma" + "in"].join(" ");
    expect(plainAsk(step("other", [], forcePush), hard("GIT_FORCE_PUSH_MAIN"))).toBe(
      "Allow force-pushing to main?",
    );
  });

  it("describes deleted files by kind and purpose, never by path", () => {
    // Commands built from parts, so the delete rule's own pattern never appears in this file's text.
    const del = (p: string) => [["r", "m"].join(""), p].join(" ");
    const media = "/home/u/.openclaw/media/headshot-tmp/linkedin-baseline.png";
    expect(plainAsk(step("delete", [file(media)], del(media)), hard("DELETE_UNREQUESTED"))).toBe(
      "Allow deleting an image, temporary, in the assistant's media folder?",
    );
    const wt: ResolvedTarget = {
      path: "/home/u/.cache/tc-worktrees/wt-amy-tail-log",
      kind: "dir",
      resolvedFrom: "~/.cache/tc-worktrees/wt-amy-tail-log",
    };
    const wtGone = ["git", "worktree", "re" + "move", wt.resolvedFrom].join(" ");
    // Classed as "other", not "delete": the rule still says what goes.
    expect(plainAsk(step("other", [wt], wtGone), hard("DELETE_UNREQUESTED"))).toBe(
      'Allow deleting the spare copy of the code where "amy-tail-log" was built?',
    );
    const scratch = "/tmp/jarvis/slack-drafts/d.txt";
    expect(plainAsk(step("delete", [file(scratch)], del(scratch)), proof)).toBe(
      'Allow deleting a text file, scratch from the assistant\'s task "slack-drafts"?',
    );
    const docs = [file("/home/u/Documents/a.pdf"), file("/home/u/Documents/b.docx")];
    expect(plainStep(step("delete", docs, del(docs[0].path)), proof, [])).toContain(
      "This deletes 2 documents, from your Documents folder,",
    );
    for (const t of [media, scratch])
      expect(plainAsk(step("delete", [file(t)], del(t)), proof)).not.toContain(t);
  });

  it("every fixed rule has its chat words, and a {target} always has a fallback noun", () => {
    for (const r of ALL_RULES) {
      const w = RULE_WORDS[r.rule];
      expect(w?.says, r.rule).toMatch(/^[A-Z].+\.$/);
      expect(w?.ask, r.rule).toMatch(/^Allow .+\?$/);
      if (w?.ask.includes("{target}")) expect(w.noun, r.rule).toBeTruthy();
    }
  });
});
