#!/bin/bash
# ChatGPT Export — local maintenance tool (purge, expiry, destination vetting)
#
# Usage: ./export.sh --purge [-o OUTPUT_DIR]
#        ./export.sh --purge-expired
#        ./export.sh --check-dest DIR
#
# THIS SCRIPT DOES NOT FETCH ANYTHING AND HANDLES NO CREDENTIAL.
#
# Exporting is done by the two user-driven paths, both of which reuse the session your browser
# already holds and read no token, no cookie jar and no credential file:
#
#   scripts/export-conversations.ts   browser relay — the agent drives your attached tab
#   scripts/bookmarklet.js            you paste it into the console on chatgpt.com yourself
#
# No script in this package reads, stores, forwards or replays a credential of any kind.
#
# What is left here is the cleanup half for the relay exporter: it writes a manifest into every
# export it makes so that --purge can validate and delete it later. The bookmarklet writes no
# manifest; its single download is deleted by hand.
#
# OFF SWITCH: this script exits immediately, before any file write or delete, if
# CHATGPT_EXPORT_DISABLE=1 is set or ~/.openclaw/chatgpt-export.disabled exists.

set -e

MANIFEST_NAME=".chatgpt-export-manifest.json"
MANIFEST_FORMAT="chatgpt-export-manifest/1"
EXPORT_ROOT="$HOME/.local/share/chatgpt-export"

# ---------------------------------------------------------------- off switch
if [ "${CHATGPT_EXPORT_DISABLE:-}" = "1" ] || [ -e "$HOME/.openclaw/chatgpt-export.disabled" ]; then
  echo "⛔ ChatGPT export is disabled on this machine (CHATGPT_EXPORT_DISABLE / ~/.openclaw/chatgpt-export.disabled)."
  echo "   Nothing was fetched, nothing was written and nothing was deleted."
  exit 0
fi

# ---------------------------------------------------------------- arguments
OUTPUT_DIR=""
PURGE=0
PURGE_EXPIRED=0
CHECK_DEST=""

usage() {
  cat <<'EOF'
Usage: ./export.sh --purge [-o OUTPUT_DIR]
       ./export.sh --purge-expired
       ./export.sh --check-dest DIR

This script does NOT export and handles NO credential. To export, use one of the two
user-driven paths, which read no token at all:

  scripts/export-conversations.ts   browser relay (the agent drives your attached tab)
  scripts/bookmarklet.js            paste into the console on chatgpt.com yourself

  -o, --output DIR   Which export directory --purge should act on.
                     Default: $HOME/.local/share/chatgpt-export/<date>
  --purge            Delete ONE export directory: the exact -o directory (default: today's).
                     Validated, typed confirmation, interactive only. See below.
  --purge-expired    Delete every export under $HOME/.local/share/chatgpt-export whose manifest
                     expiry has passed. Same validation, one typed confirmation.
  --check-dest DIR   Report whether DIR is an acceptable export destination and exit. Writes
                     nothing. Resolves symlinks first, so a link pointing at a synced folder,
                     a git repo or somewhere outside your home is rejected on what it actually
                     resolves to rather than on how the path is spelled.

--purge deletes only a directory that: canonicalizes successfully; is a strict descendant of the
canonical $HOME at least two levels deep; is not reached through a symlink; and contains a
.chatgpt-export-manifest.json that THIS tool wrote. It never derives a parent directory, never
touches $HOME or /, and refuses to run non-interactively. It removes local copies only — your
ChatGPT account is untouched.

There is no --allow-unsafe-dest. It was removed in 1.9.1: an override that lets a plaintext copy
of your entire chat history be written into a synced folder or a git repo is not a guardrail.

Off switch: CHATGPT_EXPORT_DISABLE=1, or touch ~/.openclaw/chatgpt-export.disabled
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) OUTPUT_DIR="$2"; shift 2 ;;
    --purge) PURGE=1; shift ;;
    --purge-expired) PURGE_EXPIRED=1; shift ;;
    --check-dest) CHECK_DEST="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --token-mode|--allow-unsafe-dest)
      echo "❌ $1 was removed in 1.9.1 and does nothing." >&2
      echo "" >&2
      if [ "$1" = "--token-mode" ]; then
        echo "   This package no longer reads, stores or replays a ChatGPT bearer token." >&2
        echo "   Export through a path that reuses the session your browser already holds:" >&2
        echo "     scripts/export-conversations.ts   (browser relay)" >&2
        echo "     scripts/bookmarklet.js            (paste into the console yourself)" >&2
      else
        echo "   Exports are plaintext copies of everything you have ever typed into ChatGPT." >&2
        echo "   There is no supported way to write one into a synced folder or a git repo." >&2
        echo "   Pick a local, non-synced destination instead." >&2
      fi
      exit 1 ;;
    --full|--index-only|--limit|--redact|--expire-days|--dry-run|--yes|-y)
      echo "❌ $1 belonged to the removed token path and does nothing here." >&2
      echo "   Export with scripts/export-conversations.ts or scripts/bookmarklet.js." >&2
      exit 1 ;;
    *)
      echo "Unknown argument: $1"
      echo ""
      echo "If you were passing an access token here: this package no longer accepts one"
      echo "anywhere, in any form. Use the browser-relay or bookmarklet path instead."
      echo ""
      usage
      exit 1 ;;
  esac
done

OUTPUT_DIR="${OUTPUT_DIR:-$EXPORT_ROOT/$(date +%Y-%m-%d)}"


# ---------------------------------------------------------------- path validation helpers
#
# Every destructive operation goes through canonicalize_under_home() and marker_ok(). Nothing
# is deleted on the strength of a string comparison against an unresolved path: a symlink
# anywhere in the chain would make that a lie.

canonicalize() {
  # Resolve a path fully. Prints the canonical path, or fails.
  if command -v realpath >/dev/null 2>&1; then
    realpath -- "$1" 2>/dev/null
  else
    # readlink -f is the portable-enough fallback; both resolve every component.
    readlink -f -- "$1" 2>/dev/null
  fi
}

canonicalize_under_home() {
  # Echoes the canonical path if it is a safe deletion candidate, else fails with a reason.
  _cand="$1"
  _home_real=$(canonicalize "$HOME") || { echo "❌ Cannot canonicalize \$HOME." >&2; return 1; }
  _target_real=$(canonicalize "$_cand") || { echo "❌ Cannot canonicalize '$_cand' — refusing to delete." >&2; return 1; }
  [ -n "$_target_real" ] || { echo "❌ Empty canonical path for '$_cand' — refusing to delete." >&2; return 1; }

  case "$_target_real" in
    "" | "/" ) echo "❌ Refusing to delete '$_target_real'." >&2; return 1 ;;
  esac
  if [ "$_target_real" = "$_home_real" ]; then
    echo "❌ Refusing to delete your home directory." >&2; return 1
  fi
  # Strict descendant of the CANONICAL home. This is what catches symlink redirection at any
  # component, which `[ -L "$dir" ]` alone (final component only) would miss.
  case "$_target_real" in
    "$_home_real"/*) : ;;
    *) echo "❌ Refusing to delete outside your home directory: $_target_real" >&2; return 1 ;;
  esac
  # At least two levels below home, so a stray -o can never aim this at ~/Documents.
  _rel="${_target_real#"$_home_real"/}"
  case "$_rel" in
    */*) : ;;
    *) echo "❌ Refusing to delete '$_target_real' — an export directory is at least two levels below \$HOME." >&2; return 1 ;;
  esac
  if [ ! -d "$_target_real" ]; then
    echo "❌ Not a directory: $_target_real" >&2; return 1
  fi
  printf '%s\n' "$_target_real"
}

marker_ok() {
  # The directory must carry a manifest THIS tool wrote. An arbitrary index.json found somewhere
  # underneath is not proof of ownership, so it is not accepted.
  _m="$1/$MANIFEST_NAME"
  [ -f "$_m" ] || return 1
  [ -L "$_m" ] && return 1
  grep -q "\"format\"[[:space:]]*:[[:space:]]*\"$MANIFEST_FORMAT\"" "$_m" 2>/dev/null || return 1
  return 0
}

manifest_expiry() {
  sed -n 's/.*"expires_at_epoch"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1/$MANIFEST_NAME" 2>/dev/null | head -n 1
}

purge_validated_dir() {
  # Re-validates from scratch and deletes. Called only after the human has typed PURGE, and it
  # re-checks everything immediately before `rm` so a directory swapped in after the first
  # check (a TOCTOU race) is still rejected.
  _d="$1"
  _final=$(canonicalize_under_home "$_d") || return 1
  if ! marker_ok "$_final"; then
    echo "❌ '$_final' has no $MANIFEST_NAME written by this tool — refusing to delete it." >&2
    return 1
  fi
  rm -rf -- "$_final"
  echo "   🗑  Deleted $_final"
  return 0
}

# ---------------------------------------------------------------- --purge
if [ "$PURGE" -eq 1 ]; then
  if [ ! -t 0 ]; then
    echo "❌ Refusing to purge non-interactively." >&2
    exit 1
  fi
  # The target is the EXACT export directory. No parent is ever derived from it.
  if [ ! -e "$OUTPUT_DIR" ]; then
    echo "Nothing to delete: $OUTPUT_DIR does not exist."
    exit 0
  fi
  TARGET=$(canonicalize_under_home "$OUTPUT_DIR") || exit 1
  if ! marker_ok "$TARGET"; then
    echo "❌ '$TARGET' contains no $MANIFEST_NAME written by this tool." >&2
    echo "   Refusing to delete a directory this tool did not create." >&2
    exit 1
  fi
  echo "This will permanently delete the export directory:"
  echo "    $TARGET"
  du -sh -- "$TARGET" 2>/dev/null | sed 's/^/    size: /'
  printf "Type PURGE to confirm: " >&2
  read -r _c
  if [ "$_c" != "PURGE" ]; then
    echo "Aborted. Nothing was deleted."
    exit 1
  fi
  purge_validated_dir "$TARGET" || exit 1
  echo "Done. This removed LOCAL copies only — your ChatGPT account is untouched."
  exit 0
fi

# ---------------------------------------------------------------- --purge-expired
if [ "$PURGE_EXPIRED" -eq 1 ]; then
  if [ ! -t 0 ]; then
    echo "❌ Refusing to purge non-interactively." >&2
    exit 1
  fi
  if [ ! -d "$EXPORT_ROOT" ]; then
    echo "Nothing to do: $EXPORT_ROOT does not exist."
    exit 0
  fi
  NOW=$(date +%s)
  EXPIRED=""
  for d in "$EXPORT_ROOT"/*; do
    [ -d "$d" ] || continue
    [ -L "$d" ] && continue
    marker_ok "$d" || continue
    exp=$(manifest_expiry "$d")
    [ -n "$exp" ] || continue
    [ "$NOW" -ge "$exp" ] || continue
    EXPIRED="$EXPIRED$d
"
  done
  if [ -z "$EXPIRED" ]; then
    echo "No expired exports under $EXPORT_ROOT."
    exit 0
  fi
  echo "These exports are past the expiry recorded in their own manifest:"
  printf '%s' "$EXPIRED" | while IFS= read -r d; do
    [ -n "$d" ] || continue
    printf '    %s' "$d"
    du -sh -- "$d" 2>/dev/null | awk '{printf "  (%s)", $1}'
    printf '\n'
  done
  printf "Type PURGE to delete all of the above: " >&2
  read -r _c
  if [ "$_c" != "PURGE" ]; then
    echo "Aborted. Nothing was deleted."
    exit 1
  fi
  FAILED=0
  printf '%s' "$EXPIRED" | while IFS= read -r d; do
    [ -n "$d" ] || continue
    purge_validated_dir "$d" || FAILED=1
  done
  echo "Done. This removed LOCAL copies only — your ChatGPT account is untouched."
  exit 0
fi

# ---------------------------------------------------------------- destination safety
# An export is a plaintext copy of everything you have ever typed into ChatGPT. Writing it into
# a folder a sync client is watching hands that copy to a cloud you were not thinking about,
# and writing it into a git repo is how it ends up pushed.
#
# CANONICAL, NOT LITERAL (fixed 1.9.1). This check used to test the path as written. That meant
# ~/exports passed every test while being a symlink to ~/Dropbox/exports: the literal string
# starts with $HOME and contains no sync marker, so all three guards agreed on a path that was
# never the path being written to. Every check below now runs against the CANONICAL destination,
# resolved through symlinks at every component, and compares against the CANONICAL home.
#
# The destination usually does not exist yet, so canonicalize_dest resolves the deepest ancestor
# that DOES exist and re-attaches the remaining tail. That is what closes the hole: the symlink
# is always in the part that exists.

canonicalize_dest() {
  # Print the fully-resolved form of a path that may not exist yet. Fails if it is not absolute
  # or if the existing part of it cannot be resolved.
  _d="$1"
  [ -n "$_d" ] || return 1
  case "$_d" in
    /*) : ;;
    *) return 1 ;;
  esac
  # Walk up to the deepest component that exists on disk.
  _existing="$_d"
  while [ ! -e "$_existing" ] && [ "$_existing" != "/" ]; do
    _parent="${_existing%/*}"
    [ -n "$_parent" ] || _parent="/"
    [ "$_parent" = "$_existing" ] && break
    _existing="$_parent"
  done
  _real=$(canonicalize "$_existing") || return 1
  [ -n "$_real" ] || return 1
  if [ "$_existing" = "$_d" ]; then
    printf '%s\n' "$_real"
    return 0
  fi
  _tail="${_d#"$_existing"}"
  _tail="${_tail#/}"
  case "$_real" in
    /) printf '/%s\n' "$_tail" ;;
    *) printf '%s/%s\n' "$_real" "$_tail" ;;
  esac
}

dest_objection() {
  # Echoes a human-readable objection and returns 0 if the destination is NOT acceptable.
  # Returns 1 (with no output) if it is fine.
  _d="$1"
  case "$_d" in
    /*) : ;;
    *) echo "the destination must be an absolute path"; return 0 ;;
  esac

  _canon=$(canonicalize_dest "$_d") || {
    echo "its path could not be resolved"; return 0
  }
  _home_real=$(canonicalize "$HOME") || {
    echo "your home directory could not be resolved"; return 0
  }

  # Sync markers, tested on the RESOLVED path. A symlink named "exports" pointing into Dropbox
  # is caught here even though the name gives nothing away.
  case "$_canon" in
    *Dropbox*|*"Google Drive"*|*GoogleDrive*|*OneDrive*|*iCloud*|*"Mobile Documents"*|*Nextcloud*|*ownCloud*|*Syncthing*|*pCloud*|*MEGA*|*Yandex.Disk*)
      echo "it resolves to what looks like a synced folder ($_canon)"; return 0 ;;
  esac

  # Containment in the CANONICAL home, so a symlinked ancestor cannot smuggle the export out.
  if [ "$_canon" = "$_home_real" ]; then
    echo "it resolves to your home directory itself ($_canon)"; return 0
  fi
  case "$_canon" in
    "$_home_real"/*) : ;;
    *) echo "it resolves to a location outside your home directory ($_canon)"; return 0 ;;
  esac

  # Git probe, walking the RESOLVED ancestors and stopping at the canonical home.
  _probe="$_canon"
  while [ -n "$_probe" ] && [ "$_probe" != "/" ] && [ "$_probe" != "$_home_real" ]; do
    if [ -e "$_probe/.git" ]; then
      echo "it resolves to a path inside a git repository ($_probe)"; return 0
    fi
    _parent="${_probe%/*}"
    [ -n "$_parent" ] || _parent="/"
    [ "$_parent" = "$_probe" ] && break
    _probe="$_parent"
  done

  return 1
}

if [ -n "$CHECK_DEST" ]; then
  if OBJECTION=$(dest_objection "$CHECK_DEST"); then
    echo "❌ Not an acceptable export destination — $OBJECTION." >&2
    echo "   Pick a local, non-synced directory inside your home, outside any git repo." >&2
    echo "   The default is $EXPORT_ROOT/<date>." >&2
    exit 1
  fi
  RESOLVED=$(canonicalize_dest "$CHECK_DEST")
  echo "✅ Acceptable export destination."
  echo "   As written : $CHECK_DEST"
  echo "   Resolves to: $RESOLVED"
  echo "   Nothing was written. This command only inspects the path."
  exit 0
fi

# ---------------------------------------------------------------- no export path here
echo "This script does not export. It handles no token and fetches nothing."
echo ""
echo "Export using a path that reuses the session your browser already holds:"
echo "  scripts/export-conversations.ts   browser relay, driven by the agent"
echo "  scripts/bookmarklet.js            paste into the console on chatgpt.com yourself"
echo ""
echo "This script's own jobs:"
echo "  ./export.sh --purge -o DIR    validated delete of one export"
echo "  ./export.sh --purge-expired   delete every export past its recorded expiry"
echo "  ./export.sh --check-dest DIR  vet a destination (resolves symlinks; writes nothing)"
exit 1
