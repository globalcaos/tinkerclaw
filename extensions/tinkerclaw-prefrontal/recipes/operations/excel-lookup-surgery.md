---
schema: "kit/1.0"
slug: "excel-lookup-surgery"
title: "Excel lookup surgery — pin only what stays aligned"
summary: "When an Excel workbook stalls on refresh because of thousands of VLOOKUP/XLOOKUP whole-column scans, census the formulas, classify each lookup as pin-safe or bound-only, rewrite at XML level, and never pin a range that re-sorts."
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
category: "operations"
tags: ["excel", "xlsx", "vlookup", "xlookup", "power-query", "performance", "erp", "proveidors"]
testedHarnesses: ["OpenClaw"]
authoredBy: "jarvis-on-the-fly"
---

# Excel lookup surgery — pin only what stays aligned

> Whole-column VLOOKUP/XLOOKUP is the stall. Pinning every search to a cell is the trap. Only pin when a key column already locks the source row; bound or table-ref everything that re-sorts.

## Goal

Make a stalled `.xlsx` editable again without losing formula results. Delivery is the rewritten workbook plus a backup sitting next to it. A chat diagnosis without the rewrite is a miss when the owner said "do it".

## When to Use

- Excel hangs for minutes on refresh or on a simple cell edit.
- The workbook is full of `VLOOKUP` / `XLOOKUP` / `BUSCARV` over `A:X` or `$B:$B`.
- Owner asks to replace search formulas with pinpointed references.

## Steps

### 1. Backup, then census — do not open-and-save with openpyxl

**Done when:** a `.BAK-YYYYMMDD-HHMM.xlsx` sits next to the original, and you have counts of every lookup function per sheet plus every sheet→sheet formula edge.

Unzip and read `xl/workbook.xml`, `xl/connections.xml`, `xl/pivotCache/*rels`, `customXml/item1.xml` (DataMashup). Formula census via regex on worksheet XML, not openpyxl write-back — openpyxl round-trips drop shared/array formulas and data validations.

Extract Power Query M from the DataMashup nested zip (`Formulas/Section1.m`).

**Rebase check — before building ANY next version (2nd sighting 2026-09-15).** Stat the copy people actually edit (the server share) and compare its mtime and size with your base. Newer ⇒ export it, diff it cell by cell, and build the next version **on it**. On 2026-09-14 this lesson was written as a Failures-Overcome entry; on 2026-09-15 a three-version ladder was still built on a stale local `_v4` and had to be rebuilt on the team's file saved the day before. A ladder on a stale base silently undoes other people's work.

### 2. Classify each lookup: pin / bound / leave

**Done when:** every lookup family has one of three labels, with the evidence that produced it.

| Label                 | Allowed when                                                                                                                                                    | Rewrite                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **PIN**               | A column on the destination already stores `'Source'!A{n}` (or equivalent 1:1 lock), keys unique, source grows from the bottom without reordering existing rows | `'Source'!B{n}`                 |
| **BOUND**             | Keys unique but row order is a subset, a pivot, or a curated list that does not share the destination's row index                                               | `Sheet!$A$2:$J$<last+slack>`    |
| **LEAVE / TABLE-REF** | Many-to-one (e.g. dimension table), or the source is an Excel Table that must auto-grow on refresh                                                              | `Table[Column]` structured refs |

**Never pin a PivotTable output.** Pivots re-sort on refresh. Pinning would silently point at the wrong vendor the next time someone hits Refresh.

Worked instance (IMP 840-1, 2026-09-10): Consulta2 was PIN (column C already locked `'Consulta2'!A{n}`); ISO and Tabla Facturación were BOUND; Consulta1 XLOOKUP was TABLE-REF because each vendor has several dimension rows.

### 3. Rewrite at XML, verify leftovers, drop calcChain

**Done when:** `zipfile.testzip()` is clean, `ET.fromstring` accepts each rewritten sheet, and a leftover scan for the original whole-column strings returns none.

- Rewrite `<f>...</f>` in place. Preserve `t="array"` / `t="shared"` attributes.
- Shrink pivot `worksheetSource ref="A1:X1048576"` to a bounded range with slack (`A1:U8000`, not the whole grid).
- Delete `xl/calcChain.xml` and its relationship — Excel rebuilds it on open; a stale 3.8 MB chain is part of the stall.
- Spot-check the first row, a mid row, and the first row after any offset jump in the lock column.

Do **not** claim Excel is faster until the owner opens it. This machine cannot recalculate.

### 4. Name the next bottleneck honestly

**Done when:** the remaining O(rows × source-rows) scans are listed, not hidden by the pin win.

Typical leftover: `XLOOKUP(1,(Table[Key]=this)*(Table[Dim]="X"), Table[Value])` still walks the whole table per cell. The real fix is a Power Query merge that brings those columns onto the 1:1 vendor table, not more cell formulas.

### 5. Retire a replaced tab — when the owner has approved it

**Done when:** the tab is gone from a new `_vN`, nothing else in the package changed byte-for-byte, and a spreadsheet engine loads both versions with every remaining sheet identical.

1. **Prove no consumer.** A grep for `Sheet!` is not enough: also Excel Tables on that sheet (structured refs carry no `Sheet!`), `definedName`s, pivot `worksheetSource sheet=`, `hyperlink location=`, `INDIRECT` strings, `Excel.CurrentWorkbook` in the DataMashup. Hits on `"Sheet"` inside pivot field names and table columns are headers, not references.
2. **Prove no unique data.** Key coverage against the replacement, then field by field. Record the values only the old tab holds (drifted names, stale flags) in the runbook **before** deleting.
3. **Remove exactly five things:** the `<sheet>`, its `localSheetId` names (and decrement every higher `localSheetId`), the workbook relationship, the `[Content_Types].xml` override, the `docProps/app.xml` count + title. Drop the part; check its own `_rels` first.
4. **Verify.** Other parts byte-identical; each `localSheetId` resolves to the sheet its formula names; relationship targets resolved relative to `xl/` (`../customXml/item1.xml` is legitimate); `soffice --headless --convert-to ods` both versions with a throwaway `-env:UserInstallation`, per-sheet hash equal.

Worked instance (IMP 840-1 `_v4`, 2026-09-14): Proveedor retired, 11,615 formulas gone, builder `~/.openclaw/workspace/tmp/imp840_v4_retire_proveedor.py`.

### 6. Prove speed and sameness with a real recalculation engine

**Done when:** each version was fully recalculated in an engine that supports its functions, timed, and its values equal the previous version's cell for cell.

- No Excel on the box: unpack the current LibreOffice deb tarball privately (`dpkg-deb -x`, checksum verified) — distro LO 7.3 has no XLOOKUP. Drive it with its bundled `program/python` over UNO: set `/org.openoffice.Office.Calc/Formula/Load/OOXMLRecalcMode` = 1 (never), load, read cached values, `calculateAll()` twice with timing, dump.
- Compare **version to version** under the same engine (expect 0 diffs), and **engine to Excel-cached** only on columns no pivot feeds — LibreOffice rebuilds pivots from their caches and treats `""+n` as `n`.
- Against Excel itself, gate every rewrite in Python: recompute the new formula's result from the cached source data and require it to equal Excel's cached value of the old formula.
- **Exact judge available:** `~/.openclaw/workspace/tmp/imp840-report/formula-eval.js` (with `xlsx.js`, `formula-parse.js`) recalculates the workbook's own formulas in Node or a browser and matched Excel's saved values on all 81,208 formula cells of IMP 840-1. `node test-engine.js <xlsx>` prints per-column mismatches; run it on the original first (expect 0), then on each version.
- Before stacking another rewrite, **ablate**: throwaway copies with one formula family frozen to values, timed back to back. A rewrite that does not move the time is risk without payoff — do not ship it as "faster".

## Failures-Overcome

- **A proof tab instead of the approved step.** 2026-09-10 the owner approved "Last = replace Proveedor with Consulta2" and said "perform the operations". The agent postponed Last on its own and, on "keep going", shipped a `_v4` with an unrequested comparison sheet. The owner asked why there was a new tab, then "fix the mistake". In a once-a-year audit book every new sheet is something the user has to understand. Do integrity proofs **off-book** (script output, runbook) and then perform the approved step — or ask. Never add a tab nobody named.
- **Parser artifacts looked like data drift.** The first Proveedor-vs-Control diff showed 67 name mismatches; 63 were `&amp;` left escaped and `<v xml:space="preserve">` not matched. Real count: 4. Unescape and accept attributes on `<v>` before counting anything.
- **A row pin is not a lookup on empty rows.** `IFERROR('Src'!B{n},"")` returns `0` for an empty source row, where the old `IFERROR(VLOOKUP(...),"")` returned blank. Cached values hide it until Excel recalculates (IMP 840-1: 37 trailing rows showed `0` names). Pin as `IF('Src'!A{n}="","",'Src'!B{n})`, and diff recalculated values, not the cached ones from the old file.
- **A whole-column lookup over a pivot matches its header labels.** Vendor `2025` matched the year header "2025" in `Tabla Facturación!P3` and inherited the grand total (6.8 M €). Start bounded pivot ranges below the header row. When a key space overlaps with labels (years, "Total"), check what the old formula actually hit before assuming the new blank is a regression.
- **Compare against the copy people actually edit.** The server copies had been hand-edited in Excel after we delivered (renamed tabs, a broken column index, a proof tab left full of `#REF!`). Check `dades` mtimes against the local versions before building the next `_vN`.
- **Reusing a source `ZipInfo` when writing corrupts the reader.** `out.writestr(z.getinfo(n), data)` mutates the reader's own record (CRC, sizes); a second read of that entry raises "Bad CRC-32". Pass `copy.copy(z.getinfo(n))`, or read every entry before writing it and re-verify from disk with a fresh `ZipFile`.
- **LibreOffice is not a pivot oracle.** Recalculated in LO 26.8, IMP 840-1 billing and OTIF columns differed from Excel's saved values in every version alike, because LO regenerates pivot output from the pivot cache. Version-to-version equality still holds; Excel-equality needs the Python gate.
- **The second engine is not the judge — Excel's own saved values are.** In LibreOffice 26.8, `FILTER(values,cond)` over empty-text cells returned errors, so IMP 840-1 `_v6` first shipped `FILTER(IF(values="",0,values),…)`. An exact formula engine checked against Excel's saved values (81,208 cells, 0 mismatches on the original) showed those cells were empty TEXT that Excel displays blank: the patch had turned 65 trait cells into `0`. For text sources write `values&""`; gate empty text (`<v/>` with `t="str"` is `""`, not "missing") instead of skipping it; settle engine disagreements against the target application's saved outputs, never by patching toward the other engine.
- **The biggest win was one formula family.** Ablation on IMP 840-1: 9,444 array `XLOOKUP(1,(A=x)*(B=y),…)` were ~100% of recalculation; ~60k other lookups cost 0.24 s together. One filter-first spill per trait column took the team file from 46.0 s to 2.2 s (LibreOffice). Measure before touching the rest.
- **Pinning a pivot** would have looked like a complete conversion and corrupted billing/delivery scores on the next refresh. Census of key-order (Consulta2 sorted 0001… vs ISO sparse 0001,0002,0005…) is the gate.
- **openpyxl save** would have dropped 9,444 array XLOOKUPs and 112 shared-formula masters. XML rewrite only.
- **Assuming the named NC file is the only external** missed a second workbook (`<register>_v1_copia.xlsm`) in `pivotCacheDefinition1.xml.rels`. That `_copia` name is the production filename; the local copy was renamed for reference only (the owner, 2026-09-10). Do not retarget it.
- **A static SVG is not a graph he can use.** After a column-card and a D2 compile that sprawled to 3700 px, the ask was bubbles that repel, arrows as springs, drag-and-drop. Delivery is an HTML force layout (`canvas/documents/imp840-graph/index.html`), not another picture of the same edges.
