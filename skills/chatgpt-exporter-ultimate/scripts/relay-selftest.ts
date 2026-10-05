/**
 * Regression tests for the browser-relay exporter's file-safety behaviour.
 *
 * These cover the three relay-side findings from the 1.9.0 scan:
 *   - files and directories got their private mode only at CREATION, so reusing an existing
 *     permissive path left conversation text world-readable;
 *   - redaction was applied to index.json and the per-conversation files but NOT to summary.md,
 *     so a "redacted" export still listed every conversation title in clear;
 *   - allowUnsafeDest let a caller switch the destination guard off.
 *
 * Plus the destination check itself, which must resolve symlinks before judging a path, and
 * (1.9.2) nested entries inside a reused export directory: a symlinked or hard-linked index.json,
 * summary.md, manifest or conversation file, a symlinked conversations/ directory, and a
 * symlinked destination leaf must all be refused without touching the link target. And the race
 * the scan asked about: the export directory swapped for a symlink between validation and the
 * open (and, on Linux, swapped back again right after the open).
 *
 * No network. The relay is driven with a stub browserEvaluate, so nothing contacts chatgpt.com
 * and no real conversation is ever read. Everything happens inside a throwaway HOME.
 *
 * Run:  node --experimental-strip-types scripts/relay-selftest.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, rmSync, symlinkSync, realpathSync, chmodSync, linkSync, readdirSync, renameSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";

import { destinationObjection, exportChatGPTConversations, _testing } from "./export-conversations.ts";

let pass = 0;
let fail = 0;

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`✓ PASS: ${name}`);
    pass++;
  } else {
    console.log(`✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

// A throwaway HOME. realpath it: on macOS $TMPDIR is under a symlinked /var, which would make
// every path look like the symlink bug under test.
const HOME = realpathSync(mkdtempSync(join(tmpdir(), "cge-relay-")));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), "cge-outside-")));
process.env.HOME = HOME;
delete process.env.CHATGPT_EXPORT_DISABLE;

const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);

async function main(): Promise<void> {
  const scriptDir = dirname(resolve(process.argv[1]));

// ---------------------------------------------------------------- destination vetting
mkdirSync(join(HOME, "Dropbox", "exports"), { recursive: true });
mkdirSync(join(HOME, "code", "project", ".git"), { recursive: true });
mkdirSync(join(HOME, "safe"), { recursive: true });

ok("a plain directory under home is accepted",
   destinationObjection(join(HOME, "safe", "2026-01-01")) === null);

ok("a literal path outside home is refused",
   (destinationObjection(join(OUTSIDE, "x")) ?? "").includes("outside your home"));

ok("a literal synced folder is refused",
   (destinationObjection(join(HOME, "Dropbox", "exports")) ?? "").includes("synced"));

ok("a literal git repository is refused",
   (destinationObjection(join(HOME, "code", "project", "exports")) ?? "").includes("git"));

// The 1.9.0 shape: a literal path that looks fine and resolves somewhere it is not.
symlinkSync(OUTSIDE, join(HOME, "escape"));
ok("a symlink under home pointing outside home is refused",
   (destinationObjection(join(HOME, "escape", "exports")) ?? "").includes("outside your home"));

symlinkSync(join(HOME, "Dropbox"), join(HOME, "notsynced"));
ok("a symlink whose name hides a synced target is refused",
   (destinationObjection(join(HOME, "notsynced", "exports")) ?? "").includes("synced"));

symlinkSync(join(HOME, "code", "project"), join(HOME, "plain"));
ok("a symlink into a git repository is refused",
   (destinationObjection(join(HOME, "plain", "exports")) ?? "").includes("git"));

mkdirSync(join(HOME, "a"), { recursive: true });
symlinkSync(OUTSIDE, join(HOME, "a", "link"));
ok("a symlinked ancestor with a not-yet-created tail is refused",
   (destinationObjection(join(HOME, "a", "link", "2026-01-01")) ?? "").includes("outside your home"));

// ---------------------------------------------------------------- relay stub
const TITLE_SECRET = "invoice for sk-abcdefghijklmnopqrstuvwx";
const ITEMS = [
  { id: "c1", title: TITLE_SECRET, create_time: 1, update_time: 2 },
];

const stubEvaluate = async (js: string): Promise<string> => {
  if (js.includes("conversations?offset")) {
    return JSON.stringify({ items: ITEMS, total: 1, limit: 100, offset: 0 });
  }
  return JSON.stringify({
    title: TITLE_SECRET,
    create_time: 1,
    update_time: 2,
    mapping: {
      m1: {
        id: "m1",
        message: {
          id: "m1",
          author: { role: "user" },
          create_time: 1,
          content: { content_type: "text", parts: ["my key is sk-abcdefghijklmnopqrstuvwx"] },
        },
        parent: null,
        children: [],
      },
    },
  });
};

// ---------------------------------------------------------------- reused permissive paths
// The exact failure the scanner named: the directory and the files already exist, wide open,
// from an earlier run or a careless mkdir. mkdir/writeFile `mode` is ignored when the target
// exists, so 1.9.0 left them at 0777/0666 while telling the caller 0700/0600.
const REUSED = join(HOME, "safe", "reused");
mkdirSync(join(REUSED, "conversations"), { recursive: true });
writeFileSync(join(REUSED, "index.json"), "stale");
writeFileSync(join(REUSED, "summary.md"), "stale");
chmodSync(REUSED, 0o777);
chmodSync(join(REUSED, "conversations"), 0o777);
chmodSync(join(REUSED, "index.json"), 0o666);
chmodSync(join(REUSED, "summary.md"), 0o666);

const result = await exportChatGPTConversations({
  browserEvaluate: stubEvaluate,
  confirmed: true,
  outputDir: REUSED,
  indexOnly: false,
  redact: true,
});

ok("export into a reused directory succeeds", result.exported === 1,
   `exported=${result.exported} errors=${result.errors.join("|")}`);

ok("a reused output directory is forced back to 0700", mode(REUSED) === "700",
   `mode is ${mode(REUSED)}`);
ok("a reused conversations directory is forced back to 0700",
   mode(join(REUSED, "conversations")) === "700",
   `mode is ${mode(join(REUSED, "conversations"))}`);
ok("a reused index.json is forced back to 0600", mode(join(REUSED, "index.json")) === "600",
   `mode is ${mode(join(REUSED, "index.json"))}`);
ok("a reused summary.md is forced back to 0600", mode(join(REUSED, "summary.md")) === "600",
   `mode is ${mode(join(REUSED, "summary.md"))}`);
ok("a freshly written conversation file is 0600",
   mode(join(REUSED, "conversations", "c1.json")) === "600",
   `mode is ${mode(join(REUSED, "conversations", "c1.json"))}`);
ok("the manifest is 0600",
   mode(join(REUSED, ".chatgpt-export-manifest.json")) === "600");

// ---------------------------------------------------------------- summary redaction
const summary = readFileSync(join(REUSED, "summary.md"), "utf8");
ok("summary.md is redacted like every other file",
   !summary.includes("sk-abcdefghijklmnopqrstuvwx"),
   "the secret in the conversation title survived into summary.md");
ok("summary.md still lists the conversation", summary.includes("REDACTED"),
   "expected a redaction marker where the title was");

const index = readFileSync(join(REUSED, "index.json"), "utf8");
ok("index.json is still redacted", !index.includes("sk-abcdefghijklmnopqrstuvwx"));

const convMd = readFileSync(
  join(REUSED, "conversations", `c1_${summarySlug()}.md`),
  "utf8",
);
ok("conversation markdown is still redacted", !convMd.includes("sk-abcdefghijklmnopqrstuvwx"));

function summarySlug(): string {
  return TITLE_SECRET.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

// ---------------------------------------------------------------- nested symlinks (1.9.1 finding)
// A reused export directory that passes the top-level check but holds a symlinked child. Every
// case must refuse, write nothing through the link, and leave the link target's content AND mode
// untouched (chmod used to follow the link too).
async function expectNestedRefusal(
  name: string,
  plant: (dir: string, victim: string) => void,
  indexOnly = false,
): Promise<void> {
  const dir = join(HOME, "safe", `nested-${name.replace(/[^a-z0-9]+/gi, "-")}`);
  mkdirSync(dir, { recursive: true });
  const victim = join(OUTSIDE, `victim-${name.replace(/[^a-z0-9]+/gi, "-")}`);
  writeFileSync(victim, "ORIGINAL");
  chmodSync(victim, 0o644);
  plant(dir, victim);
  let refused = false;
  let message = "";
  try {
    await exportChatGPTConversations({
      browserEvaluate: stubEvaluate,
      confirmed: true,
      outputDir: dir,
      indexOnly,
      redact: true,
    });
  } catch (e) {
    message = String(e);
    refused = message.includes("Refusing");
  }
  ok(`a planted ${name} is refused`, refused, message || "export completed");
  ok(`a planted ${name} leaves the link target's content untouched`,
     readFileSync(victim, "utf8") === "ORIGINAL");
  ok(`a planted ${name} leaves the link target's mode untouched`, mode(victim) === "644",
     `mode is ${mode(victim)}`);
}

await expectNestedRefusal("index.json symlink", (d, v) => symlinkSync(v, join(d, "index.json")), true);
await expectNestedRefusal("summary.md symlink", (d, v) => symlinkSync(v, join(d, "summary.md")));
await expectNestedRefusal("manifest symlink", (d, v) =>
  symlinkSync(v, join(d, ".chatgpt-export-manifest.json")), true);
await expectNestedRefusal("conversation-file symlink", (d, v) => {
  mkdirSync(join(d, "conversations"), { recursive: true });
  symlinkSync(v, join(d, "conversations", "c1.json"));
});
await expectNestedRefusal("dangling conversation-file symlink", (d, v) => {
  mkdirSync(join(d, "conversations"), { recursive: true });
  symlinkSync(`${v}-does-not-exist-yet`, join(d, "conversations", "c1.json"));
});
await expectNestedRefusal("index.json hard link", (d, v) => linkSync(v, join(d, "index.json")), true);

// conversations/ itself pointing outside: nothing may be created in the link target.
{
  const dir = join(HOME, "safe", "nested-convdir");
  mkdirSync(dir, { recursive: true });
  const target = mkdtempSync(join(OUTSIDE, "convdir-"));
  chmodSync(target, 0o755);
  symlinkSync(target, join(dir, "conversations"));
  let refused = false;
  try {
    await exportChatGPTConversations({
      browserEvaluate: stubEvaluate, confirmed: true, outputDir: dir, indexOnly: false,
    });
  } catch (e) {
    refused = String(e).includes("Refusing");
  }
  ok("a symlinked conversations/ directory is refused", refused);
  ok("nothing is written into the conversations/ link target", readdirSync(target).length === 0,
     `found ${readdirSync(target).join(",")}`);
  ok("the conversations/ link target's mode is untouched", mode(target) === "755",
     `mode is ${mode(target)}`);
}

// The destination leaf itself as a symlink to an otherwise acceptable directory: refused before
// its mode is touched.
{
  const real = join(HOME, "safe", "leaf-real");
  mkdirSync(real, { recursive: true });
  chmodSync(real, 0o755);
  symlinkSync(real, join(HOME, "safe", "leaf-link"));
  let refused = false;
  try {
    await exportChatGPTConversations({
      browserEvaluate: stubEvaluate, confirmed: true, outputDir: join(HOME, "safe", "leaf-link"),
    });
  } catch (e) {
    refused = String(e).includes("symbolic link");
  }
  ok("a symlinked destination leaf is refused", refused);
  ok("a symlinked destination leaf's target mode is untouched", mode(real) === "755",
     `mode is ${mode(real)}`);
}

// ---------------------------------------------------------------- swap between validation and write
// A directory that was verified, then replaced by a symlink to somewhere else just before the
// file is opened. The write must refuse and put no content in the link target.
{
  const dir = join(HOME, "safe", "race-swap");
  mkdirSync(dir, { recursive: true });
  const target = mkdtempSync(join(OUTSIDE, "race-"));
  _testing.setRaceHook((stage) => {
    if (stage === "beforeOpen") {
      renameSync(dir, `${dir}.orig`);
      symlinkSync(target, dir);
    }
  });
  let refused = false;
  try {
    _testing.writePrivate(dir, "index.json", "SECRET");
  } catch (e) {
    refused = String(e).includes("Refusing");
  } finally {
    _testing.setRaceHook(null);
  }
  const landed = join(target, "index.json");
  ok("a directory swapped for a symlink before the open is refused", refused);
  ok("no content lands in the swapped-in target",
     !existsSync(landed) || readFileSync(landed, "utf8") === "");
  if (existsSync("/proc/self/fd")) {
    ok("the empty file created in the swapped-in target is removed (Linux)", !existsSync(landed),
       `found ${readdirSync(target).join(",")}`);
  }
}

// Swapped in before the open and swapped back right after it, so every path-based re-check
// looks clean afterwards. Only the descriptor's real path (/proc) can see this; where /proc is
// absent the case is not claimed, and the docs say so.
if (existsSync("/proc/self/fd")) {
  const dir = join(HOME, "safe", "race-swap-back");
  mkdirSync(dir, { recursive: true });
  const target = mkdtempSync(join(OUTSIDE, "race-back-"));
  _testing.setRaceHook((stage) => {
    if (stage === "beforeOpen") {
      renameSync(dir, `${dir}.orig`);
      symlinkSync(target, dir);
    } else {
      rmSync(dir);
      renameSync(`${dir}.orig`, dir);
    }
  });
  let refused = false;
  try {
    _testing.writePrivate(dir, "summary.md", "SECRET");
  } catch (e) {
    refused = String(e).includes("Refusing");
  } finally {
    _testing.setRaceHook(null);
  }
  ok("a directory swapped in and back around the open is refused (Linux)", refused);
  ok("nothing is left in the swap-and-restore target (Linux)", readdirSync(target).length === 0,
     `found ${readdirSync(target).join(",")}`);
  ok("nothing is written at the restored path either (Linux)", !existsSync(join(dir, "summary.md")));
}

// ~/ is expanded to the home directory; a relative path is refused rather than resolved against
// whatever the current directory happens to be.
{
  const r = await exportChatGPTConversations({
    browserEvaluate: stubEvaluate, confirmed: true, outputDir: "~/safe/tilde", indexOnly: true,
  });
  ok("a ~/ destination is expanded to the home directory",
     r.outputDir === join(HOME, "safe", "tilde") && mode(join(HOME, "safe", "tilde", "index.json")) === "600",
     `outputDir=${r.outputDir}`);
  let refused = false;
  try {
    await exportChatGPTConversations({
      browserEvaluate: stubEvaluate, confirmed: true, outputDir: "relative/dir", indexOnly: true,
    });
  } catch (e) {
    refused = String(e).includes("absolute path");
  }
  ok("a relative destination is refused", refused);
}

// ---------------------------------------------------------------- removed override
const source = readFileSync(join(scriptDir, "export-conversations.ts"), "utf8");
// Strip comments before asserting. The header explains that the override was removed, and
// saying so is the point; what must not exist is a live option, destructure or assignment.
const code = source
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");
ok("allowUnsafeDest has no live implementation in the relay",
   !code.includes("allowUnsafeDest"),
   "found it outside a comment");

// It must actually refuse, not merely lack the flag.
let refused = false;
try {
  await exportChatGPTConversations({
    browserEvaluate: stubEvaluate,
    confirmed: true,
    outputDir: join(HOME, "Dropbox", "exports"),
    indexOnly: true,
    // @ts-expect-error: the option no longer exists; passing it must not re-enable anything.
    allowUnsafeDest: true,
  });
} catch (e) {
  refused = String(e).includes("Refusing to export");
}
ok("a synced destination is refused even when allowUnsafeDest is passed", refused);

// The relay must handle no bearer token.
ok("the relay reads no bearer token",
   !/CHATGPT_ACCESS_TOKEN|Authorization:\s*.?Bearer/.test(source));

rmSync(HOME, { recursive: true, force: true });
rmSync(OUTSIDE, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
