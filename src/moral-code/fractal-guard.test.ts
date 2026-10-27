/**
 * FORK 2026-10-25 — the tinkerclaw-core Fractal guard. A background Fractal reflection (session `agent:<id>:fractal:<P>`,
 * whose worker the tinker-bridge starts with TC_FRACTAL_GUARD set) proposes sends, deletes, publishes, spends and
 * restarts instead of running them. The rules are tested on the classifier; the wiring black-box, as the CLI runs the
 * command hooks.json registers, with the tool call on stdin.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyCommand,
  classifyFractalCall,
  denyReason,
} from "../../claude-plugins/tinkerclaw-core/scripts/fractal-guard.mjs";

const PLUGIN_ROOT = path.resolve(__dirname, "../../claude-plugins/tinkerclaw-core");

type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
};

function preToolHooks(): HookEntry[] {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
  ) as { hooks: Record<string, HookEntry[]> };
  return cfg.hooks.PreToolUse ?? [];
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fractal-guard-"));
// Outside /tmp on purpose: everything under /tmp is scratch by rule, so the birth-time rule needs another disk path.
const outside = fs.mkdtempSync(path.join(PLUGIN_ROOT, "..", ".fractal-guard-test-"));
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const kindOf = (command: string, base = {}) => classifyCommand(command, base)?.kind ?? null;

describe("fractal guard: what a background reflection may not do on its own", () => {
  it.each([
    ["git push origin develop", "publish"],
    ["cd ~/src/tinkerclaw && git -C . push", "publish"],
    ["bash -lc 'git push'", "publish"],
    ["bash <<EOS\ngit push\nEOS", "publish"],
    ["gh pr create --fill", "publish"],
    ["gh api repos/o/r/issues -f title=x", "publish"],
    ["npx clawhub publish ./skill", "publish"],
    ["bash scripts/phone-door/pack-publish.sh", "publish"],
    ["openclaw message send --target +10000000000 --message hi", "send"],
    ["openclaw gateway call chat.send --params '{}'", "send"],
    ['jarvis "It works live"', "send"],
    ["node skills/teams-hack/scripts/chat-send.mjs --to x", "send"],
    ["curl -s https://hooks.slack.com/services/x -d '{}'", "send"],
    ["rm -f /etc/hostname", "delete"],
    ["sudo -u root rm /etc/hostname", "delete"],
    ["rm -f ./notes/old.md", "delete"],
    ["xargs rm < list.txt", "delete"],
    ["ssh -i key host 'rm -f ~/public_html/page.php'", "delete"],
    ["find . -name '*.log' -delete", "delete"],
    ["git reset --hard HEAD", "delete"],
    ["git checkout -- src/a.ts", "delete"],
    ["git restore src/a.ts", "delete"],
    ["git branch -D fix/x", "delete"],
    ["git stash drop", "delete"],
    ["pnpm store prune", "delete"],
    ["openclaw gateway restart", "restart"],
    ["systemctl --user restart openclaw-gateway", "restart"],
    ["systemctl --user stop longjob-x", "restart"],
    ["kill -USR1 4242", "restart"],
    ["pkill -f openclaw-gateway", "restart"],
    ["openclaw cron add --name nightly", "spend"],
    ["crontab /tmp/jarvis/c.txt", "spend"],
  ])("holds %j as %s", (command, kind) => {
    expect(kindOf(command)).toBe(kind);
  });

  it.each([
    "git commit -m 'rm the dead lane; git push later'",
    "git merge --no-edit fix/x",
    "git checkout -b fix/x",
    "git restore --staged a.ts",
    "git branch -d fix/x",
    "git worktree remove ~/src/tinkerclaw-wt/x",
    "git rm docs/old.md",
    "gh pr view 12",
    "pnpm test src/moral-code/fractal-guard.test.ts",
    "openclaw gateway call fractal.ledger",
    "openclaw message read --channel whatsapp",
    "systemctl --user status openclaw-gateway",
    "kill 4242",
    "pkill -f '[p]npm test extensions/x'",
    "rm -f /tmp/jarvis/task/a.txt /tmp/jarvis/task/*.png && rmdir /tmp/jarvis/task",
    "T=$(mktemp -d); git -C $T init -q; find $T -type f -delete",
    "trash ~/.openclaw/agent-memory/duplicate.md",
    "python3 - <<'PY'\nrm -rf /\nPY",
    "cat > /tmp/jarvis/x.md <<'EOF'\ngit push\nEOF",
    "echo done # then rm -rf ~ and git push",
    'jarvis --out /tmp/jarvis/t.wav "Speed test."',
    "python3 -I scripts/fractal-parent-trail.py",
    "node --check scripts/chat-send.mjs",
  ])("lets %j through", (command) => {
    expect(classifyCommand(command)).toBeNull();
  });

  it("lets the reflection delete what it made after its worker started, and symlinks, but not older files", () => {
    const since = Date.now() - 1_000;
    const fresh = path.join(outside, "probe.ts");
    fs.writeFileSync(fresh, "x");
    const link = path.join(outside, "node_modules");
    fs.symlinkSync(os.tmpdir(), link);
    const birth = fs.statSync(fresh).birthtimeMs;
    expect(kindOf(`rm -f ${link}`, { since })).toBeNull();
    expect(kindOf(`cd ${outside} && rm node_modules`, { since })).toBeNull();
    expect(kindOf(`W=${outside}; rm $W/node_modules`, { since })).toBeNull();
    // A tracked cwd that cannot be known (a variable never assigned) makes a relative target unknown: held.
    expect(kindOf(`cd $NOPE && rm node_modules`, { since })).toBe("delete");
    if (birth > 0) {
      // The filesystem records birth times (ext4, btrfs, tmpfs on current kernels).
      expect(kindOf(`rm -f ${fresh}`, { since })).toBeNull();
      expect(kindOf(`rm -f ${fresh}`, { since: birth + 60_000 })).toBe("delete");
    }
  });

  it("reads the gateway's tools: sends and paid generation are held, reads are not", () => {
    expect(classifyFractalCall("mcp__openclaw__message", { action: "send" })?.kind).toBe("send");
    expect(classifyFractalCall("mcp__openclaw__message", { action: "read" })).toBeNull();
    expect(classifyFractalCall("mcp__jarvis__tts", {})?.kind).toBe("send");
    expect(classifyFractalCall("mcp__claude_ai_Gmail__send_email", {})?.kind).toBe("send");
    expect(classifyFractalCall("mcp__jarvis__image_generate", {})?.kind).toBe("spend");
    expect(classifyFractalCall("mcp__x__cron", { action: "add" })?.kind).toBe("spend");
    expect(classifyFractalCall("mcp__x__cron", { action: "list" })).toBeNull();
    expect(classifyFractalCall("mcp__jarvis__web_search", { query: "x" })).toBeNull();
    expect(classifyFractalCall("Write", { file_path: "/x", content: "rm -rf /" })).toBeNull();
    expect(classifyFractalCall("Bash", { command: "git push" })?.kind).toBe("publish");
  });

  it("tells the model to write the call as a proposal, not to find another way", () => {
    const reason = denyReason({ kind: "publish", match: "git push" });
    expect(reason).toContain("git push");
    expect(reason).toContain("Proposed:");
    expect(reason).toContain("Do not retry it another way");
  });
});

describe("fractal guard hook: the command hooks.json registers", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "fractal-guard-state-"));
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), "fractal-guard-locks-"));
  afterAll(() => {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(locks, { recursive: true, force: true });
  });
  let uniq = 0;

  function run(toolName: string, toolInput: unknown, env: Record<string, string>): string {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("TC_")),
    );
    const cmd = preToolHooks()[0].hooks[0].command.replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
    return execFileSync("/bin/sh", ["-c", cmd], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: `toolu_${process.pid}_${uniq++}`,
        cwd: scratch,
      }),
      env: {
        ...inherited,
        OPENCLAW_STATE_DIR: state,
        TMPDIR: locks,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        ...env,
      },
      encoding: "utf8",
    });
  }

  const guardRows = (): Array<Record<string, unknown>> => {
    const file = path.join(state, "data", "fractal", "guard.jsonl");
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  };

  it("is one PreToolUse command for every tool, behind a shell test, with a 5 s budget", () => {
    const entries = preToolHooks();
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("*");
    expect(entries[0].hooks).toEqual([
      {
        type: "command",
        command:
          '[ -z "$TC_FRACTAL_GUARD" ] || exec node "${CLAUDE_PLUGIN_ROOT}/scripts/fractal-guard.mjs"',
        timeout: 5,
      },
    ]);
  });

  it("does nothing outside a Fractal worker (no TC_FRACTAL_GUARD)", () => {
    expect(run("Bash", { command: "git push" }, {})).toBe("");
    expect(run("Bash", { command: "git push" }, { TC_SESSION_KEY: "agent:main:main" })).toBe("");
    expect(guardRows()).toEqual([]);
  });

  it("denies a matched call in enforce mode and logs it without the command text", () => {
    const out = run(
      "Bash",
      { command: "git push origin develop # secret-ish words" },
      { TC_FRACTAL_GUARD: "enforce", TC_SESSION_KEY: "agent:main:fractal:run-1" },
    );
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Proposed:");
    const row = guardRows().at(-1);
    expect(row).toMatchObject({
      mode: "enforce",
      decision: "deny",
      kind: "publish",
      tool: "Bash",
      match: "git push",
      sessionKey: "agent:main:fractal:run-1",
    });
    expect(JSON.stringify(row)).not.toContain("secret-ish");
  });

  it("lets the call run in watch mode and logs what it would have denied", () => {
    const before = guardRows().length;
    expect(
      run(
        "mcp__openclaw__message",
        { action: "send", message: "hi" },
        { TC_FRACTAL_GUARD: "watch" },
      ),
    ).toBe("");
    expect(guardRows()).toHaveLength(before + 1);
    expect(guardRows().at(-1)).toMatchObject({
      mode: "watch",
      decision: "would-deny",
      kind: "send",
    });
  });

  it("prints nothing for a call that is the reflection's to make", () => {
    const before = guardRows().length;
    expect(run("Bash", { command: "git commit -m x" }, { TC_FRACTAL_GUARD: "enforce" })).toBe("");
    expect(run("Edit", { file_path: "/x" }, { TC_FRACTAL_GUARD: "enforce" })).toBe("");
    expect(guardRows()).toHaveLength(before);
  });
});
