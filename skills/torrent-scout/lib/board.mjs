// board.mjs — the download dashboard. Progress you can SEE, because "it is
// running in the background" is a claim and a moving bar is evidence.
import { THEME, PALETTE, chip, esc } from "./vt.mjs";

const fmt = (b) => {
  b = Number(b || 0);
  return b >= 1024 ** 3
    ? `${(b / 1024 ** 3).toFixed(2)} GB`
    : b >= 1024 ** 2
      ? `${(b / 1024 ** 2).toFixed(0)} MB`
      : `${(b / 1024).toFixed(0)} KB`;
};
const name = (t) =>
  t.bittorrent?.info?.name || (t.files?.[0]?.path || "").split("/").pop() || t.gid;

const STATUS_TIER = {
  active: "good",
  complete: "best",
  waiting: "ok",
  paused: "weak",
  error: "bad",
  removed: "weak",
};

function eta(t) {
  const left = Number(t.totalLength) - Number(t.completedLength);
  const spd = Number(t.downloadSpeed);
  if (!spd || left <= 0) return "—";
  const s = left / spd;
  if (s > 86400) return `${(s / 86400).toFixed(1)} d`;
  if (s > 3600) return `${(s / 3600).toFixed(1)} h`;
  if (s > 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s)} s`;
}

export function renderBoard(tasks) {
  const T = THEME;
  if (!tasks.length) {
    return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;background:${T.bg};color:${T.dim};border:1px solid ${T.border};border-radius:11px;padding:16px 18px">📥 Download queue is empty — nothing running.</div>`;
  }
  const rows = tasks
    .map((t) => {
      const total = Number(t.totalLength) || 0;
      const done = Number(t.completedLength) || 0;
      const pct = total ? (done / total) * 100 : 0;
      const tier = STATUS_TIER[t.status] || "weak";
      const c = PALETTE[tier];
      const stalled = t.status === "active" && Number(t.downloadSpeed) === 0;
      return `<div style="padding:11px 0;border-top:1px solid ${T.line}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
        <div style="font-size:13px;color:${T.text}">${esc(name(t).slice(0, 68))}</div>
        <div>${chip(stalled ? "stalled" : t.status, stalled ? "weak" : tier)}</div>
      </div>
      <div style="margin:7px 0 5px">
        <div style="height:9px;background:#3a332a;border-radius:5px;overflow:hidden">
          <div style="width:${Math.max(pct, 0.6).toFixed(2)}%;height:100%;background:${c.bar}"></div>
        </div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;color:${T.faint};font-size:11px;font-variant-numeric:tabular-nums">
        <span style="color:${c.fg};font-weight:600">${pct.toFixed(1)}%</span>
        <span>${fmt(done)} / ${total ? fmt(total) : "size unknown"}</span>
        <span>↓ ${fmt(t.downloadSpeed)}/s</span>
        <span>ETA ${esc(eta(t))}</span>
        <span>peers ${esc(t.connections ?? "0")}</span>
        <span>seeders ${esc(t.numSeeders ?? "?")}</span>
        <span style="color:${Number(t.uploadLength) > 0 ? "#c98a5a" : T.ghost}">↑ ${fmt(t.uploadLength)}</span>
      </div>
      ${t.errorMessage ? `<div style="color:#e39a9a;font-size:11px;margin-top:4px">⚠ ${esc(t.errorMessage)}</div>` : ""}
      ${stalled && !total ? `<div style="color:${T.ghost};font-size:10.5px;margin-top:4px">no metadata yet — the swarm has not answered. With very few seeders this can take a long time or never complete.</div>` : ""}
    </div>`;
    })
    .join("");

  const upTotal = tasks.reduce((a, t) => a + Number(t.uploadLength || 0), 0);
  return `<div style="font-family:ui-sans-serif,system-ui,sans-serif;background:${T.bg};color:${T.text};border:1px solid ${T.border};border-radius:12px;padding:16px 19px;max-width:760px">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
    <div style="font-size:15px;font-weight:700">📥 Downloads</div>
    <div style="color:${T.faint};font-size:11px">${tasks.length} task(s) · uploaded ${fmt(upTotal)}${upTotal === 0 ? " (never seeds)" : ""}</div>
  </div>
  ${rows}
</div>`;
}
