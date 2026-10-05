import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyEffect, resolveTargets } from "../src/effect-class.js";
import type { EffectClass } from "../src/types.js";

const table: [string, EffectClass][] = [
  ["rm -rf ~/x", "delete"],
  ["rm foo.txt", "delete"],
  ["rmdir build", "delete"],
  ["unlink a", "delete"],
  ["shred -u secret", "delete"],
  ["trash old", "delete"],
  ["find . -delete", "delete"],
  ["find . -name '*.tmp' -delete", "delete"],
  ["git clean -fdx", "delete"],
  ["git reset --hard HEAD~1", "delete"],
  ["python -c \"shutil.rmtree('/x')\"", "delete"],
  ["python3 -c \"import os; os.remove('/x')\"", "delete"],
  ["git push origin main", "send"],
  ["sendmail bob@example.com", "send"],
  ["scp a.txt host:/tmp/", "send"],
  ["rsync -av dir/ user@host:/backup/", "send"],
  ["curl -X POST https://example.com/api", "send"],
  ["gh pr create --fill", "send"],
  ["wacli send --to x hi", "send"],
  ["lpr file.pdf", "send"],
  ["systemctl --user stop openclaw-gateway", "restart-own-system"],
  ["systemctl restart openclaw-gateway.service", "restart-own-system"],
  ["pkill -f openclaw", "restart-own-system"],
  ["systemctl stop nginx", "other"],
  ["kill 1234", "other"],
  ["cat a.txt", "read"],
  ["ls -la", "read"],
  ["grep -rn foo src", "read"],
  ["rg foo", "read"],
  ["head -n 5 f", "read"],
  ["tail -f log", "read"],
  ["stat f", "read"],
  ["find . -name x", "read"],
  ["git log --oneline", "read"],
  ["git status", "read"],
  ["git diff HEAD", "read"],
  ["git show abc", "read"],
  ["pwd", "read"],
  ["which node", "read"],
  ['echo "rm -rf /"', "read"],
  ["printf hi", "read"],
  ["cp a b", "local-write"],
  ["mv a b", "local-write"],
  ["mkdir -p d", "local-write"],
  ["touch f", "local-write"],
  ["tee out.txt", "local-write"],
  ["sed -i s/a/b/ f", "local-write"],
  ["sed -n 1p f", "read"],
  ["echo hi > out.txt", "local-write"],
  ["echo hi >> out.txt", "local-write"],
  ["echo hi > /dev/null", "read"],
  ["ls 2>&1", "read"],
  ["make build", "other"],
  ["curl https://api.stripe.com/v1/charges", "spend"],
  ["ls; rm x", "delete"],
  ["cat a && git push", "send"],
  ["ls | grep x", "read"],
  ["cp a b || rm b", "delete"],
  ["bash -c 'rm -rf x'", "delete"],
  ["FOO=1 sudo rm x", "delete"],
];

describe("classifyEffect", () => {
  it.each(table)("%s -> %s", (cmd, expected) => {
    const f = classifyEffect("Bash", cmd);
    expect(f.origin).toBe("derived");
    expect(f.value).toBe(expected);
  });

  it("classifies by tool name", () => {
    expect(classifyEffect("Read", null).value).toBe("read");
    expect(classifyEffect("Grep", null).value).toBe("read");
    expect(classifyEffect("Glob", null).value).toBe("read");
    expect(classifyEffect("WebFetch", null).value).toBe("read");
    expect(classifyEffect("Write", null).value).toBe("local-write");
    expect(classifyEffect("Edit", null).value).toBe("local-write");
    expect(classifyEffect("NotebookEdit", null).value).toBe("local-write");
    expect(classifyEffect("mcp__x__y", null).value).toBe("other");
  });

  it("is missing when the tool is unknown", () => {
    expect(classifyEffect(null, "rm x")).toEqual({ value: null, origin: "missing" });
  });

  it("is missing for a shell tool with no command", () => {
    expect(classifyEffect("Bash", null).origin).toBe("missing");
  });
});

describe("resolveTargets", () => {
  const home = "/home/u";
  const cwd = "/work/proj";
  const paths = (cmd: string): string[] =>
    (resolveTargets(cmd, undefined, cwd, home).value ?? []).map((t) => t.path);

  it("expands ~ and $HOME literally", () => {
    expect(paths("rm -rf ~/x")).toEqual(["/home/u/x"]);
    expect(paths("rm $HOME/y ${HOME}/z")).toEqual(["/home/u/y", "/home/u/z"]);
    expect(paths("ls ~")).toEqual(["/home/u"]);
  });

  it("resolves relative paths against cwd", () => {
    expect(paths("rm a/b.txt ../c")).toEqual(["/work/proj/a/b.txt", "/work/c"]);
  });

  // 2026-10-02, live shadow data: build-worker steps like `cd /tmp/sv2-m5/sv2 && cp a b` named files under the
  // workspace, `export URL=redis://…` became a path, and heredoc bodies became targets. Those wrong targets fed
  // excess-scope (102 asks in a day), the danger level and weakens-own-check.
  it("follows cd: later relative paths resolve against the new folder, and cd itself is no target", () => {
    expect(paths("cd /tmp/sv2/ui && rm src/zz.test.ts")).toEqual(["/tmp/sv2/ui/src/zz.test.ts"]);
    expect(paths("cd ~/p; cp a.txt b/c.txt")).toEqual(["/home/u/p/a.txt", "/home/u/p/b/c.txt"]);
    expect(paths("cd sub && cd ../other && rm x/y")).toEqual(["/work/proj/other/x/y"]);
  });

  it("an unknown cd keeps the folder it had", () => {
    expect(paths('cd "$(mktemp -d)" && rm a/b')).toEqual(["/work/proj/a/b"]);
  });

  it("a NAME=value word is a setting, never a path", () => {
    expect(paths("export DB_URL=sqlite:///w/db REDIS=redis://h:1/0 && ls /tmp")).toEqual(["/tmp"]);
  });

  it("a heredoc body is the input of a command, not more commands", () => {
    const cmd =
      "cd /w && python3 - <<'EOF'\np='e2e/x.spec.ts'\nprint(\"it's / done\")\nEOF\nrm a/b";
    expect(paths(cmd)).toEqual(["/w/a/b"]);
    expect(paths("cat > /w/out.sh <<-END\n\trm -rf /etc/x\n\tEND\nls /w/y")).toEqual([
      "/w/out.sh",
      "/w/y",
    ]);
  });

  it("keeps quoted paths with spaces as one target", () => {
    expect(paths('rm "my file.txt"')).toEqual(["/work/proj/my file.txt"]);
    expect(paths("rm 'a b/c d'")).toEqual(["/work/proj/a b/c d"]);
  });

  it("ignores flags", () => {
    expect(paths("rm -rf -v x")).toEqual(["/work/proj/x"]);
  });

  it("never expands globs", () => {
    expect(paths("rm *.log")).toEqual(["/work/proj/*.log"]);
  });

  it("never executes substitutions", () => {
    const marker = `/tmp/amygdala-b4-${process.pid}-${Date.now()}`;
    resolveTargets(`rm $(touch ${marker})`, undefined, cwd, home);
    resolveTargets(`rm \`touch ${marker}\``, undefined, cwd, home);
    classifyEffect("Bash", `rm $(touch ${marker})`);
    expect(existsSync(marker)).toBe(false);
  });

  it("reads targets from tool args and redirects", () => {
    const f = resolveTargets(null, { file_path: "src/a.ts" }, cwd, home);
    expect(f.value?.[0]).toMatchObject({ path: "/work/proj/src/a.ts", kind: "file" });
    expect(paths("echo hi > out.txt")).toEqual(["/work/proj/out.txt"]);
  });

  it("marks urls and addresses", () => {
    const t = resolveTargets("curl https://example.com/x", undefined, cwd, home).value ?? [];
    expect(t[0].kind).toBe("url");
    const a = resolveTargets("sendmail bob@example.com", undefined, cwd, home).value ?? [];
    expect(a[0].kind).toBe("address");
  });

  it("is missing with neither command nor args", () => {
    expect(resolveTargets(null, undefined, cwd, home).origin).toBe("missing");
  });
});
