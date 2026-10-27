// pdf-review viewer defaults, set before pdf.js starts (classic script, runs before viewer.mjs).
// Page Fit is the default view of every PDF (the architect 2026-10-16). pdf.js applies defaultZoomValue
// even when it reopens a file at the last page read; an auto-reload keeps the zoom in use.
document.addEventListener("webviewerloaded", () => {
  window.PDFViewerApplicationOptions?.set("defaultZoomValue", "page-fit");
});
