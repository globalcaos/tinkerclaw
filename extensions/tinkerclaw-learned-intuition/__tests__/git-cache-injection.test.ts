import { exec as execCb, execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCache } from "../src/git-cache.js";

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);

/**
 * THE ORCA INCIDENT — differential regression test.
 *
 * On 2026-08-05 at 05:23:32, and again at 05:28:31, arbitrary code executed on the host with full
 * agent privileges. The process launched was /usr/bin/orca, the GNOME screen reader, which started
 * reading the screen aloud to a sleeping user. No adversary, no malicious input, no compromised
 * dependency: `git-cache.ts` interpolated an action's "target" into a shell command and ran it
 * through /bin/sh -c, escaping only double quotes. The target was a command string that
 * `classifyTargetType()` had guessed was a file because it contained a ".". The text being
 * processed was documentation warning that bare `orca` launches the screen reader — the sentence
 * describing the hazard executed the hazard, and investigating the first firing caused the second.
 *
 * J9 (AEGIS) note 8 records the remediation as "verified by differential test". That verification
 * was real but it was a ONE-OFF: no such test existed in the repository, so nothing prevented the
 * pattern returning. This is that test, committed.
 *
 * It is DIFFERENTIAL on purpose. Asserting only that the new code is safe would pass just as
 * happily against a payload that never fires, an OS without the binary, or a typo in the fixture —
 * a green test proving nothing. So each case first demonstrates that the OLD pattern really does
 * execute this exact payload on this exact machine, and only then that the NEW one does not. The
 * first half is the control; without it the second half is unfalsifiable.
 *
 * The payload is a file write into a temp dir, not `orca` — the point is to prove code execution,
 * and a test that talks to the user's speakers is its own incident.
 */
describe("git-cache command injection (the Orca incident)", () => {
  let tmp: string;
  let canary: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "orca-regression-"));
    canary = path.join(tmp, "PWNED");
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const canaryExists = async () =>
    await fs
      .access(canary)
      .then(() => true)
      .catch(() => false);

  it("CONTROL: the old exec() pattern really does execute a backtick payload", async () => {
    // Reproduces git-cache.ts as it was BEFORE the fix, including its only sanitisation:
    // .replace(/"/g, '\\"'). Double quotes escaped, backticks untouched — which is precisely the
    // gap the incident walked through.
    const malicious = `x\`touch ${canary}\`.md`;
    const escapedFile = malicious.replace(/"/g, '\\"');

    expect(await canaryExists()).toBe(false);
    try {
      await execAsync(`git log --oneline -- "${escapedFile}" 2>/dev/null | wc -l`, {
        encoding: "utf-8",
        timeout: 5000,
        cwd: tmp,
      });
    } catch {
      // The git command's own exit status is irrelevant. The substitution happens in the shell,
      // before git ever runs — which is exactly why the incident was invisible to git's result.
    }

    // If this fails, the test fixture is broken, NOT the product. Every assertion below is
    // meaningless unless this one passes.
    expect(await canaryExists()).toBe(true);
  });

  it("the shipped execFile() pattern leaves the identical payload inert", async () => {
    const malicious = `x\`touch ${canary}\`.md`;

    expect(await canaryExists()).toBe(false);
    try {
      await execFileAsync("git", ["log", "--oneline", "--", malicious], {
        encoding: "utf-8",
        timeout: 5000,
        cwd: tmp,
      });
    } catch {
      // git will complain about the path; that is fine and is not what is under test.
    }

    // No shell parsed the string, so the backticks are ordinary characters in a filename.
    expect(await canaryExists()).toBe(false);
  });

  it("GitCache survives a metacharacter-bearing target without executing it", async () => {
    // The end-to-end shape: the value arrives the way the incident delivered it — as an action
    // "target" that is really a command string, guessed to be a file because it contains a ".".
    const cache = new GitCache({ enabled: true, watch: false, ttl_seconds: 60 } as never);
    const malicious = `grep -c foo \`touch ${canary}\` bar.md`;

    expect(await canaryExists()).toBe(false);
    const [commits, authors] = await Promise.all([
      cache.getRecentCommits(malicious, 72),
      cache.getRecentAuthors(malicious, 72),
    ]);

    expect(await canaryExists()).toBe(false);
    // Degrading to zero is the correct outcome: the enrichment is best-effort and must never be
    // worth executing a stranger's string for.
    expect(commits).toBe(0);
    expect(authors).toBe(0);
  });

  it("$(...) substitution is inert too, not just backticks", async () => {
    // The fix removes the shell entirely rather than blocking one syntax, so the other spelling
    // of command substitution must be inert for the same reason. A blocklist would have needed a
    // second entry here; an argv array needs nothing.
    const malicious = `x$(touch ${canary}).md`;

    expect(await canaryExists()).toBe(false);
    try {
      await execFileAsync("git", ["log", "--oneline", "--", malicious], {
        encoding: "utf-8",
        timeout: 5000,
        cwd: tmp,
      });
    } catch {
      /* expected */
    }
    expect(await canaryExists()).toBe(false);
  });
});
