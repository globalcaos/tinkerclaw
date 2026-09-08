#!/bin/bash
# scan-full.sh — complete full-depth folder inventory + shortcut map of the SERRA NAS.
#
# WHY THIS EXISTS: a single `dades tree <dept> --depth 99` on the big engineering vaults
# (05 Disseny/maquinas, 06 Informació/15 Clients, 07 OTELEC/12_Maquinas) NEVER FINISHES.
# gvfs/SMB does ~40 dir/s serially and those vaults hold tens of thousands of folders.
# On 2026-06-26 that killed the scan twice and then crashed the agent process.
#
# WHAT WORKS: split the share into small units and run them 8-way parallel.
#   pass 1 = every department's level-1 subfolders   (188 units)
#   pass 2 = level-1 subfolders of any unit that still timed out  (894 units)
# 2026-07-27 full run: 64.660 folders, 1.856 shortcuts, ~55 min, zero failures.
#
# Read-only throughout: every call goes through the audited `dades` CLI.
#
# Usage:  ./scan-full.sh [outdir]      (default outdir: ~/.openclaw/data/backup-audit/nas-scan-<date>)

set -u
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dades"
OUT="${1:-$HOME/.openclaw/data/backup-audit/nas-scan-$(date +%F)}"
PAR="${PAR:-8}"        # concurrent readers; 8 is polite and saturates gvfs
CAP="${CAP:-900}"      # per-unit timeout in seconds
export D OUT CAP

mkdir -p "$OUT"/{units,units2,lnkfind,lnkfind2,lnkres,logs}

step() { printf '\n=== %s ===\n' "$1"; }

step "1/5  departments"
timeout 60 "$D" ls . 2>/dev/null | awk '/^d /{ $1=""; $2=""; sub(/^[ ]+/,""); print }' > "$OUT/departments.txt"
echo "departments: $(wc -l < "$OUT/departments.txt")"

step "2/5  level-1 units"
: > "$OUT/units-raw.txt"
while IFS= read -r dept; do printf '%s\n' "$dept"; done < "$OUT/departments.txt" | \
xargs -d '\n' -P "$PAR" -I{} bash -c '
  dept="{}"
  timeout 300 "$D" tree "$dept" --depth 1 2>/dev/null | tail -n +2 | sed "s|/$||" | grep -v "^$" |
    while IFS= read -r sub; do printf "%s/%s\n" "$dept" "$sub"; done
' >> "$OUT/units-raw.txt"
sort -u "$OUT/units-raw.txt" > "$OUT/units.txt"
echo "units: $(wc -l < "$OUT/units.txt")"
# departments with NO subfolders never produce a unit — keep them or they vanish from the tree
comm -23 <(sort "$OUT/departments.txt") <(cut -d/ -f1 "$OUT/units.txt" | sort -u) > "$OUT/flat-departments.txt"

scan_pass() {  # $1=units file  $2=out subdir  $3=done log  $4=width
  nl -ba -w"$4" -nrz -s$'\t' "$1" | xargs -d '\n' -P "$PAR" -I{} bash -c '
    line="{}"; idx="${line%%	*}"; unit="${line#*	}"
    f="'"$OUT/$2"'/$idx.txt"
    printf "@UNIT\t%s\n" "$unit" > "$f"
    if timeout "$CAP" "$D" tree "$unit" --depth 99 >> "$f" 2>/dev/null
      then printf "@OK\t%s\n"   "$unit" >> "'"$OUT/logs/$3"'"
      else printf "@FAIL\t%s\n" "$unit" >> "'"$OUT/logs/$3"'"; fi'
}

step "3/5  full-depth scan, pass 1"
scan_pass "$OUT/units.txt" units done.log 4
grep '^@FAIL' "$OUT/logs/done.log" 2>/dev/null | cut -f2 | sort -u > "$OUT/monsters.txt"
echo "timed out: $(wc -l < "$OUT/monsters.txt")"

step "4/5  full-depth scan, pass 2 (subdivide the timeouts)"
: > "$OUT/units2-raw.txt"
while IFS= read -r m; do
  timeout 300 "$D" tree "$m" --depth 1 2>/dev/null | tail -n +2 | sed 's|/$||' | grep -v '^$' |
    while IFS= read -r sub; do printf '%s/%s\n' "$m" "$sub"; done >> "$OUT/units2-raw.txt"
done < "$OUT/monsters.txt"
sort -u "$OUT/units2-raw.txt" > "$OUT/units2.txt"
[ -s "$OUT/units2.txt" ] && scan_pass "$OUT/units2.txt" units2 done2.log 5

step "5/5  shortcuts (.lnk) + targets"
find_lnk() {  # $1=units file  $2=out subdir  $3=width
  nl -ba -w"$3" -nrz -s$'\t' "$1" | xargs -d '\n' -P "$PAR" -I{} bash -c '
    line="{}"; idx="${line%%	*}"; unit="${line#*	}"
    timeout "$CAP" "$D" find "$unit" ".lnk" 2>/dev/null > "'"$OUT/$2"'/$idx.txt"'
}
find_lnk "$OUT/units.txt" lnkfind 4
[ -s "$OUT/units2.txt" ] && find_lnk "$OUT/units2.txt" lnkfind2 5
cat "$OUT"/lnkfind/*.txt "$OUT"/lnkfind2/*.txt 2>/dev/null | grep '^- ' | sed 's/^- //' | sort -u > "$OUT/lnk-paths.txt"
nl -ba -w5 -nrz -s$'\t' "$OUT/lnk-paths.txt" | xargs -d '\n' -P "$PAR" -I{} bash -c '
  line="{}"; idx="${line%%	*}"; p="${line#*	}"
  timeout 120 "$D" lnk "$p" > "'"$OUT"'/lnkres/$idx.json" 2>/dev/null'

echo
echo "raw output in $OUT"
echo "  folders scanned : $(cat "$OUT"/units/*.txt "$OUT"/units2/*.txt 2>/dev/null | grep -vc '^@UNIT\|^#')"
echo "  shortcuts       : $(wc -l < "$OUT/lnk-paths.txt")"
echo
echo "NEXT: assemble indented tree output into canonical full paths (2 spaces = 1 level,"
echo "      prefix each line with its @UNIT, add all ancestors, drop @FAIL units' partials,"
echo "      then append flat-departments.txt). See memory/dades/ON-VA-CADA-COSA.md."
