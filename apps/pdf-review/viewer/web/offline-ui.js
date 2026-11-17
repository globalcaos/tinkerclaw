import { served } from "./base.js";
import { OFFLINE, state, waiting, flush, keepFolder, folderCount, isKept, discardParagraph, readiness, isReady } from "./offline.js";

// The always-visible connection note (2026-11-10): "Online" or "Offline", and how many changes wait to reach
// the Pi. A tap opens the list: what waits, a waiting ✏️ edit to change or drop, and "Keep this folder".
if (OFFLINE) {
  const app = window.PDFViewerApplication;
  await app.initializedPromise;
  const chip = document.createElement("button");
  chip.id = "syncState";
  chip.type = "button";
  chip.className = "toolbarButton";
  document.getElementById("toolbarViewerRight").prepend(chip);
  const current = () => (app.url ? decodeURIComponent(served(app.url)) : "");
  const nameOf = (p) => p.split("/").pop();
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function draw() {
    const n = waiting().count + (window.__pdfJournalCount || 0); // marks still in the journal (autoreload.js) count too
    // The reader's own files: until all are here it cannot open with no network, so the count stays in sight.
    const rd = readiness();
    const copy = !state.online ? "" : isReady(rd) ? " · ✓ ready for offline" : rd ? ` · ⏳ offline copy ${rd.have}/${rd.total}` : " · ⏳ offline copy…";
    chip.textContent = (state.online ? "Online" : "✈ Offline") + (state.syncing ? " · syncing" : n ? ` · ${n} waiting` : "") + copy;
    chip.dataset.online = state.online ? "1" : "0";
    chip.title = `${state.online ? "Connected to the Pi" : "No connection: everything is kept on this phone"}${n ? `; ${n} change(s) wait to reach the Pi` : ""}. Tap for details.`;
    if (document.getElementById("syncDialog")?.open) panel(false);
  }

  function panel(open = true) {
    let dlg = document.getElementById("syncDialog");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "syncDialog";
      document.body.append(dlg);
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    }
    const w = waiting();
    const path = current();
    const count = path ? folderCount(path) : null;
    const rows = [
      ...w.marks.map(([p, e]) => `<li>Marks on <b>${esc(nameOf(p))}</b>, kept ${new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${e.error ? ` <span class="syncErr">⚠ ${esc(e.error)}</span>` : ""}</li>`),
      ...w.redo.map((p) => `<li>Apply comments on <b>${esc(nameOf(p))}</b></li>`),
      ...w.paragraphs.map((e) => `<li data-id="${esc(e.id)}">✏️ <b>${esc(nameOf(e.path))}</b>: “${esc(e.new.slice(0, 70))}${e.new.length > 70 ? "…" : ""}”` +
        (e.conflict ? ` <span class="syncErr">⚠ not applied: ${esc(e.conflict)}</span> <button data-a="copy">Copy</button>` : ` <button data-a="change">Change</button>`) +
        ` <button data-a="drop">Discard</button></li>`),
    ];
    dlg.innerHTML = `<div class="recentHead"><b>${state.online ? "Online" : "✈ Offline"}</b><button type="button" class="recentClose" aria-label="Close">✕</button></div>
      <div class="syncBody">
        <p>${rows.length ? `${rows.length} change(s) wait to reach the Pi:` : "Nothing waits: every change is on the Pi."}</p>
        ${rows.length ? `<ul>${rows.join("")}</ul><button type="button" data-a="sync">Sync now</button>` : ""}
        <hr><p class="syncReady">${(() => { const rd = readiness(); return isReady(rd) ? "The reader is on this phone ✓ It opens with no network." : rd ? `⏳ The reader is NOT ready for offline yet: ${rd.have} of ${rd.total} files are on this phone. Keep this page open with a connection.` : "⏳ Checking whether the reader is on this phone…"; })()}</p>
        <p>This file: ${path && isKept(path) ? "kept on this phone ✓" : "not kept on this phone yet"}</p>
        <p class="syncFolder">${count ? `${count.kept} of ${count.total} kept on this phone` : "This folder is not kept yet."}</p>
        <button type="button" data-a="folder">📥 Keep this whole folder on this phone</button>
      </div>`;
    dlg.querySelector(".recentClose").onclick = () => dlg.close();
    dlg.querySelector(".syncBody").onclick = (e) => act(e, dlg);
    if (open && !dlg.open) dlg.showModal();
  }

  async function act(e, dlg) {
    const b = e.target.closest("button");
    const a = b?.dataset.a;
    if (!a) return;
    const entry = waiting().paragraphs.find((x) => x.id === b.closest("li")?.dataset.id);
    if (a === "sync") return flush();
    if (a === "drop") {
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to discard"; return; }
      return discardParagraph(entry.id);
    }
    if (a === "copy") {
      try { await navigator.clipboard.writeText(entry.new); b.textContent = "✓ Copied"; } catch { b.textContent = "Copy failed"; }
      return;
    }
    if (a === "change") {
      dlg.close();
      return window.__pdfEditPopup({ index: entry.index, text: entry.old, local: true }, entry.path, { text: entry.new, caret: entry.new.length });
    }
    if (a === "folder") {
      const note = dlg.querySelector(".syncFolder");
      b.disabled = true;
      try {
        const c = await keepFolder(current(), (done, total) => { note.textContent = `Fetching ${done} of ${total}…`; });
        note.textContent = `${c.kept} of ${c.total} kept on this phone`;
      } catch (err) {
        console.error("[offline] keeping the folder failed", err);
        note.textContent = `⚠ ${err instanceof TypeError ? "No connection: the folder can be fetched only online" : err.message}`;
      } finally {
        b.disabled = false;
      }
    }
  }

  chip.addEventListener("click", () => panel(true));
  window.addEventListener("pdfreview:offline-state", draw);
  // The phone's Back closes this list first (the app calls __jarvisBack in offline.html, which asks here).
  window.__pdfCloseDialog = () => {
    const open = [...document.querySelectorAll("dialog[open]")];
    open.forEach((d) => d.close());
    return open.length > 0;
  };
  draw();
}
