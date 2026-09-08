// presenters.mjs — per-file-type presentation specs.
//
// A torrent listing is a COMPARISON, not a list. The reader's job is to tell
// options apart at a glance, so every spec here answers three questions:
//   1. which columns actually change the decision for THIS file type
//   2. which of those deserve a visual encoding (colour, bar, size) vs plain text
//   3. what to drop, because an irrelevant column costs more than it adds
//
// Adding a type = add an entry here + a spec note in references/presenters/.
// The renderer is generic; nothing below is video-specific by accident.

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export const fmtSize = (b) => {
  if (!b) return "—";
  return b >= GB ? `${(b / GB).toFixed(1)} GB` : `${(b / MB).toFixed(0)} MB`;
};

/* ─── shared visual vocabulary ────────────────────────────────────────────
   Colour means the same thing in every table: amber = best available,
   blue = good, slate = adequate, grey = weak, red = suspect. A reader who
   learns it once on a video table reads a model-pack table for free.        */
export const PALETTE = {
  best: { bg: "#4a3410", fg: "#f0c674", bd: "#8a6520" },
  good: { bg: "#1e3347", fg: "#8ec0e4", bd: "#2f5madeup" },
  ok: { bg: "#2f3b33", fg: "#a8c8a0", bd: "#46604a" },
  weak: { bg: "#3a3630", fg: "#a09580", bd: "#554e44" },
  bad: { bg: "#4a2020", fg: "#e39a9a", bd: "#7a3434" },
};
PALETTE.good.bd = "#2f5a7a";

/** Resolution → tier + label. The single strongest visual signal for video. */
export function resolutionChip(res) {
  if (!res) return { label: "?", tier: "weak" };
  if (res >= 2160) return { label: `${res}p`, tier: "best" };
  if (res >= 1080) return { label: `${res}p`, tier: "good" };
  if (res >= 720) return { label: `${res}p`, tier: "ok" };
  return { label: `${res}p`, tier: "weak" };
}

/** Swarm health → tier. Logarithmic in reality; three buckets is enough to read. */
export function healthTier(seeders, webseed) {
  if (webseed) return "good";
  const s = seeders ?? 0;
  if (s >= 50) return "best";
  if (s >= 10) return "good";
  if (s >= 3) return "ok";
  if (s >= 1) return "weak";
  return "bad";
}

/**
 * Implied video bitrate — the honest quality tell once resolution is known.
 * Two 1080p releases at 2 GB and 12 GB are not the same film in any sense
 * that matters, and the size column alone hides that when runtimes differ.
 */
export function bitrateMbps(sizeBytes, runtimeMin) {
  if (!sizeBytes || !runtimeMin) return null;
  return (sizeBytes * 8) / (runtimeMin * 60) / 1e6;
}

/** One-line human verdict on picture, for readers who do not parse tags. */
export function pictureSummary(p) {
  const bits = [];
  if (p.source === "REMUX") bits.push("untouched disc");
  else if (p.source === "BluRay") bits.push("from disc");
  else if (p.source === "WEB-DL") bits.push("from stream");
  else if (p.source === "WEBRip") bits.push("re-encoded stream");
  else if (p.source === "HDTV") bits.push("broadcast");
  if (p.hdr?.length) bits.push(p.hdr.includes("DolbyVision") ? "Dolby Vision" : "HDR");
  return bits.join(" · ") || "—";
}

/** One-line human verdict on sound. */
export function soundSummary(p) {
  // "not tagged" not "—": the release name simply did not say. An em-dash reads
  // as "no audio" or as a broken column; the reader must be able to tell the
  // difference between absent DATA and an absent FEATURE. inspect() resolves it.
  if (!p.audioCodec) return "not tagged";
  const lossless = ["TrueHD", "DTS-HD", "FLAC", "Atmos"].includes(p.audioCodec);
  const ch = p.audioChannels ? ` ${p.audioChannels}` : "";
  return `${p.audioCodec}${ch}${lossless ? " · lossless" : ""}`;
}

/* ─── the specs ──────────────────────────────────────────────────────────── */

export const PRESENTERS = {
  /**
   * VIDEO — films and episodes.
   * Decision drivers, in the order a viewer actually cares about them:
   *   can I get it (health) → how will it look (resolution+source+bitrate)
   *   → how will it sound (codec+channels) → what will it cost me (size).
   */
  video: {
    label: "Video",
    subtitle: "films & episodes — ranked by picture, then sound, then how reliably it downloads",
    columns: [
      { key: "rank", label: "#", width: "28px", align: "right" },
      { key: "quality", label: "Quality", width: "92px", note: "resolution drives the colour" },
      { key: "picture", label: "Picture", width: "150px" },
      { key: "sound", label: "Sound", width: "140px" },
      { key: "bitrate", label: "Bitrate", width: "110px", note: "the honest quality tell" },
      { key: "size", label: "Size", width: "74px", align: "right" },
      { key: "health", label: "Swarm", width: "104px" },
      { key: "release", label: "Release", width: "auto" },
    ],
    // Columns deliberately NOT shown: language tags (the operator reads 7 languages,
    // so they never move a ranking), publish date (age is not quality), and
    // the raw indexer name (moved to the release cell as a small suffix).
    omit: ["languages", "publishedAt"],
  },

  /**
   * MODELS — 3D printing / CAD / blueprint packs.
   * Nobody cares about resolution here; they care what FORMAT is inside,
   * which only `inspect` can answer, and whether it is printable or editable.
   */
  models: {
    label: "3D models & blueprints",
    subtitle: "ranked by format coverage and swarm health",
    columns: [
      { key: "rank", label: "#", width: "28px", align: "right" },
      { key: "formats", label: "Formats", width: "170px", note: "STL=print, STEP/F3D=editable" },
      { key: "files", label: "Files", width: "70px", align: "right" },
      { key: "size", label: "Size", width: "74px", align: "right" },
      { key: "health", label: "Swarm", width: "104px" },
      { key: "release", label: "Release", width: "auto" },
    ],
    omit: ["resolution", "source", "audio", "hdr", "bitrate"],
  },

  /** DOCS — books, manuals, scans. Format and page-fidelity are the axes. */
  docs: {
    label: "Documents",
    subtitle: "ranked by format quality and completeness",
    columns: [
      { key: "rank", label: "#", width: "28px", align: "right" },
      { key: "formats", label: "Format", width: "150px", note: "EPUB=reflow, PDF=fixed, CBZ=scan" },
      { key: "files", label: "Files", width: "70px", align: "right" },
      { key: "size", label: "Size", width: "74px", align: "right" },
      { key: "health", label: "Swarm", width: "104px" },
      { key: "release", label: "Release", width: "auto" },
    ],
    omit: ["resolution", "source", "audio", "hdr", "bitrate"],
  },
};

export function presenterFor(kind) {
  if (kind === "tv" || kind === "movie" || kind === "video") return PRESENTERS.video;
  if (kind === "models") return PRESENTERS.models;
  if (kind === "docs") return PRESENTERS.docs;
  return PRESENTERS.video;
}
