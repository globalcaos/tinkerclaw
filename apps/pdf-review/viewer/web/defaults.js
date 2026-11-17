// pdf-review viewer defaults, set before pdf.js starts (classic script, runs before viewer.mjs).
// Page Fit is the default view of every PDF (the architect 2026-10-16). pdf.js applies defaultZoomValue
// even when it reopens a file at the last page read; an auto-reload keeps the zoom in use.
document.addEventListener("webviewerloaded", () => {
  window.PDFViewerApplicationOptions?.set("defaultZoomValue", "page-fit");
  // Light or dark by the reader's own setting (reader.js, 2026-11-12); without one, pdf.js follows the device.
  const look = localStorage.getItem("reader.look");
  if (look === "light" || look === "dark") window.PDFViewerApplicationOptions?.set("viewerCssTheme", look === "light" ? 1 : 2);
});
// Dark look, dark page (2026-11-12): pdf.js darkens its own bars only, so the paper stayed white. The
// class below makes reader.css turn the pages dark too. Automatic follows the device, also when it changes.
window.readerLookApply = () => {
  const look = localStorage.getItem("reader.look");
  const dark = look === "dark" || (look !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("pdfDark", dark);
};
window.readerLookApply();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", window.readerLookApply);
