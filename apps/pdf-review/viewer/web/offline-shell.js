import { viewerUrl } from "./base.js";

// offline.html: the last PDF opened on this phone (offline.js keeps pdfreview.last), with 🕘 Recent to
// pick another one kept here. The app's Back asks __jarvisBack: an open list or box closes first.
const frame = document.getElementById("reader");
const last = localStorage.getItem("pdfreview.last");
frame.src = last ? viewerUrl(last) : "viewer.html?file=&recent=1";
window.__jarvisBack = () => {
  try { return frame.contentWindow?.__pdfCloseDialog?.() === true; } catch { return false; }
};
