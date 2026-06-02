#!/usr/bin/env bash
# upstream-3way.sh — Synthetic-3-way upstream merge helper for the tinkerclaw fork.
#
# WHY THIS EXISTS (the no-merge-base conflict multiplier)
# -------------------------------------------------------
# The fork's history and upstream/main are DISJOINT — `git merge-base HEAD
# upstream/main` is EMPTY (the fork was re-rooted; there is no real common
# ancestor commit shared by both lineages). Git's default merge therefore has
# no ancestor to diff against, so every single file that differs in any way
# becomes a worst-case 2-way reconcile (add/add conflict) even when the two
# sides are trivially or identically different. That is the conflict multiplier:
# a clean upstream catch-up explodes into hundreds of spurious conflicts.
#
# THE FIX: a PINNED synthetic common ancestor.
# `upstream-base` is a git tag pinned at the upstream content-anchor commit the
# fork actually carries (the merge-base of the fork's last-synced upstream tag
# with upstream/main; established in S3 at 7b07a0ab8fd). Feeding that tag to a
# 3-way merge as the explicit base lets git see "ours vs theirs vs ancestor"
# for every file, so trivially-different / upstream-only files AUTO-RESOLVE
# instead of re-conflicting. Only files BOTH sides genuinely changed relative to
# the pinned base will conflict — the real merge work, nothing spurious.
#
# After each SUCCESSFUL sync, ADVANCE the tag to the newly-merged upstream
# commit (`git tag -f upstream-base <new-upstream-sha>`) so the NEXT sync's
# synthetic ancestor is the content the fork now carries. The cron does this
# automatically and records the new SHA in its receipt.
#
# GIT VERSION NOTE (portable to git 2.34.1, the host's version)
# -------------------------------------------------------------
# `git merge-tree --merge-base` (the modern one-shot 3-way) only exists in git
# >= 2.38. On 2.34.1 we use two portable primitives instead:
#   * preview : the OLD `git merge-tree <base> <branch1> <branch2>` form, which
#               writes a non-destructive conflict diff to stdout (no index/tree
#               mutation) — perfect for a dry run.
#   * merge   : `git merge-recursive <base> -- <ours> <theirs>`, which performs
#               the real index + worktree 3-way against the EXPLICIT base and
#               leaves conflict markers in the worktree for the caller to
#               resolve, then the caller commits. This sidesteps the
#               "refusing to merge unrelated histories" guard entirely because
#               it operates on the three trees directly, not on the DAG.
#
# USAGE
# -----
#   scripts/merge-drivers/upstream-3way.sh preview   # non-destructive; show conflicts
#   scripts/merge-drivers/upstream-3way.sh merge     # do the 3-way into the worktree
#   scripts/merge-drivers/upstream-3way.sh advance <sha>   # move upstream-base to <sha>
#
# Env knobs:
#   BASE_REF   (default: upstream-base)  the pinned synthetic ancestor tag/ref
#   OURS_REF   (default: HEAD)
#   THEIRS_REF (default: upstream/main)
#
# This helper does NOT fetch, commit, build, or push — that is the fork-sync
# cron's job (scripts/cron-fork-sync-prompt.txt). It is the merge PRIMITIVE the
# cron calls so the synthetic-base convention lives in ONE place.
set -euo pipefail

BASE_REF="${BASE_REF:-upstream-base}"
OURS_REF="${OURS_REF:-HEAD}"
THEIRS_REF="${THEIRS_REF:-upstream/main}"

die() { echo "upstream-3way: $*" >&2; exit 1; }

# Resolve to the repo root so relative invocation works from anywhere.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repo"
cd "$REPO_ROOT"

require_base() {
  git rev-parse --verify --quiet "$BASE_REF^{commit}" >/dev/null \
    || die "pinned base '$BASE_REF' not found. Create it first: git tag -f upstream-base <content-anchor-sha> (see this script's header)."
  # Sanity: the pinned base MUST be an ancestor of theirs, else it is not a
  # valid synthetic ancestor and the 3-way is meaningless.
  if ! git merge-base --is-ancestor "$BASE_REF" "$THEIRS_REF" 2>/dev/null; then
    die "pinned base '$BASE_REF' is NOT an ancestor of '$THEIRS_REF' — it cannot be the synthetic common ancestor. Re-pin it (advance subcommand) or fetch upstream."
  fi
}

cmd="${1:-}"
case "$cmd" in
  preview)
    require_base
    BASE_SHA="$(git rev-parse --short "$BASE_REF")"
    echo "upstream-3way preview: base=$BASE_REF($BASE_SHA) ours=$OURS_REF theirs=$THEIRS_REF" >&2
    echo "(non-destructive — nothing in the worktree or index is changed)" >&2
    # OLD merge-tree form: prints the merged tree + conflict hunks to stdout.
    # A clean result means the synthetic base auto-resolved everything.
    git merge-tree "$BASE_REF" "$OURS_REF" "$THEIRS_REF"
    ;;

  merge)
    require_base
    # Refuse to clobber a dirty tree — the caller (cron) captures a rollback SHA
    # and expects a clean starting point.
    if [[ -n "$(git status --porcelain)" ]]; then
      die "working tree is dirty; commit/stash before a 3-way merge (the cron captures a pre-merge SHA for rollback first)."
    fi
    BASE_SHA="$(git rev-parse --short "$BASE_REF")"
    THEIRS_SHA="$(git rev-parse --short "$THEIRS_REF")"
    echo "upstream-3way merge: base=$BASE_REF($BASE_SHA) ours=$OURS_REF theirs=$THEIRS_REF($THEIRS_SHA)" >&2
    # merge-recursive returns non-zero on conflicts; that is EXPECTED and not a
    # script error — surface it as exit 1 so the caller resolves, but do not
    # `set -e`-abort with a confusing trace.
    set +e
    git merge-recursive "$BASE_REF" -- "$OURS_REF" "$THEIRS_REF"
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      echo "upstream-3way: clean 3-way merge — no conflicts. Index updated; review, commit, then advance upstream-base to $THEIRS_SHA." >&2
    else
      echo "upstream-3way: 3-way merge left conflicts (rc=$rc). Resolve markers, then commit; advance upstream-base to $THEIRS_SHA after the build is green." >&2
    fi
    exit $rc
    ;;

  advance)
    NEW="${2:-$THEIRS_REF}"
    git rev-parse --verify --quiet "$NEW^{commit}" >/dev/null \
      || die "advance target '$NEW' is not a valid commit"
    git tag -f upstream-base "$NEW" >/dev/null
    echo "upstream-3way: upstream-base now at $(git rev-parse --short upstream-base) ($(git log -1 --format='%s' upstream-base))" >&2
    ;;

  ""|-h|--help|help)
    sed -n '2,60p' "$0"
    ;;

  *)
    die "unknown subcommand '$cmd' (expected: preview | merge | advance <sha>)"
    ;;
esac
