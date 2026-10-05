// FORK 2026-10-05 (the architect, 11:37: "I still don't see the micro-tab attached to AcmeVision").
// The Tinker page is built from ~/src/tinkerclaw's WORKING TREE, on whatever branch it is on. A
// session switched that checkout to its own branch at 09:42 and died at 09:48; the page's rebuild
// at 11:35 built that branch, 11 commits behind develop, and said "ok", so the Gantt tab merged
// into develop at 10:05 never reached the screen. A frontend build now says so first.
import { execFileSync } from "node:child_process";

/**
 * `null` when `root` is on develop at its tip (or there is no git or no develop to compare with);
 * otherwise the branch, how many develop commits it lacks, and a warning a person can act on.
 */
export function checkoutDrift(root, run) {
  const git =
    run ??
    ((args) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // A hook's GIT_DIR must not redirect this to another repository (an empty one is an error).
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== "GIT_DIR" && k !== "GIT_WORK_TREE"),
        ),
      }).trim());
  let branch;
  let behind;
  try {
    branch = git(["branch", "--show-current"]);
    behind = Number(git(["rev-list", "--count", "HEAD..develop"]));
  } catch {
    return null;
  }
  if (!Number.isFinite(behind) || (branch === "develop" && behind === 0)) {
    return null;
  }
  const where = branch ? `branch ${branch}` : "a detached HEAD";
  const lacks = behind ? ` and lacks ${behind} commit(s) of develop` : "";
  return {
    branch,
    behind,
    warning:
      `⚠ ${root} is on ${where}${lacks}: this frontend build is NOT develop, so work merged into ` +
      "develop will not show. Put that checkout back on develop (`git checkout -m develop` keeps " +
      "uncommitted edits) and rebuild.",
  };
}
