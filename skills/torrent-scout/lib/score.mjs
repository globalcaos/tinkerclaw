// score.mjs — quality gate, fake detection, and ranking.
//
// This is where the skill earns its keep: a search returns 60 results and the
// value is picking one. Two stages, deliberately separate:
//   1. gate()   — hard rejections. A gated candidate is never shown.
//   2. score()  — ranks whatever survived.
// Fake detection contributes flags to both: some flags gate, most penalise.

import {
  parseRelease,
  titleSimilarity,
  SOURCE_LADDER,
  AUDIO_LADDER,
  REJECT_REASON,
} from "./parse.mjs";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Plausible video bitrate bands in Mbps, by vertical resolution. */
const BITRATE_BANDS = {
  4320: [20, 400],
  2160: [5, 220],
  1440: [3, 80],
  1080: [1.2, 70],
  720: [0.6, 25],
  480: [0.25, 10],
};

const RESOLUTION_POINTS = { 4320: 115, 2160: 100, 1440: 72, 1080: 60, 720: 25, 480: 5 };
const SOURCE_POINTS = {
  REMUX: 45,
  BluRay: 40,
  "WEB-DL": 32,
  WEBRip: 18,
  HDTV: 8,
  DVDRip: 3,
};
const AUDIO_POINTS = {
  Atmos: 30,
  TrueHD: 27,
  "DTS-HD": 25,
  FLAC: 20,
  DTS: 16,
  EAC3: 12,
  AC3: 9,
  AAC: 5,
  MP3: 1,
};
const HDR_POINTS = { DolbyVision: 12, "HDR10+": 9, HDR10: 7, HLG: 4 };
const CODEC_POINTS = { AV1: 4, HEVC: 3, H264: 2, VC1: 0, XviD: -12 };
const CHANNEL_POINTS = { 7.1: 6, 6.1: 5, 5.1: 4, "2.0": 0 };

export const PROFILES = {
  // the operator's default: maximum picture and sound, size is not a constraint.
  best: { resolutionWeight: 1.0, sizePenaltyAboveGB: null, minSeeders: 2 },
  // Quality that still fits a sane download.
  balanced: { resolutionWeight: 0.75, sizePenaltyAboveGB: 20, minSeeders: 4 },
  // Smallest thing that is still watchable.
  compact: { resolutionWeight: 0.4, sizePenaltyAboveGB: 6, minSeeders: 4 },
};

const EXECUTABLE_RE = /\.(exe|msi|scr|bat|cmd|com|apk|dmg|lnk|vbs|ps1|jar|pkg|deb|run)$/i;
const DECOY_RE =
  /(password|passwort|contrase|how[ _-]?to[ _-]?(download|play|watch)|readme|install|activate|crack|keygen|serial)/i;
const VIDEO_RE = /\.(mkv|mp4|avi|m2ts|ts|mov|wmv|mpg|mpeg|m4v|webm|iso|vob|flv|ogv)$/i;
const ARCHIVE_RE = /\.(rar|r\d{2}|zip|7z|tar|gz|part\d+\.rar)$/i;
const MODEL_RE =
  /\.(stl|3mf|obj|step|stp|f3d|dxf|dwg|scad|gcode|blend|fbx|iges|igs|sldprt|sldasm|ipt|iam)$/i;
const DOC_RE = /\.(pdf|epub|djvu|mobi|azw3|cbz|cbr|txt|md|doc|docx)$/i;

/** Implied video bitrate in Mbps, given a size and an assumed runtime. */
function impliedMbps(sizeBytes, runtimeMin) {
  if (!sizeBytes || !runtimeMin) return null;
  return (sizeBytes * 8) / (runtimeMin * 60) / 1e6;
}

/**
 * Hard rejections. A gated candidate is removed from the presented list
 * entirely — the caller reports "not available in an acceptable quality"
 * rather than showing it.
 */
export function gate(cand, opts = {}) {
  const { allowCamcorder = false, kind = "auto" } = opts;
  const p = cand.parsed;
  const reasons = [];

  if (!allowCamcorder && p.isCamcorder) {
    reasons.push(
      `${p.source}: ${REJECT_REASON[p.source] || "pre-retail source"} — barred by the quality floor`,
    );
  }
  if (cand.seeders === 0) reasons.push("dead swarm: 0 seeders, the file cannot be retrieved");
  if (cand.flags?.includes("executable-payload")) {
    reasons.push("file list contains an executable — classic malware repackage");
  }
  if (cand.flags?.includes("no-video-file") && (kind === "movie" || kind === "tv")) {
    reasons.push("no video file in the torrent despite being offered as a video release");
  }
  if (cand.flags?.includes("title-mismatch")) {
    reasons.push("release name does not match the requested title");
  }
  return { rejected: reasons.length > 0, reasons };
}

/**
 * Fake / junk heuristics. Returns a flag list; `inspect` adds the file-list
 * flags once metadata has been fetched. Name-only flags are available before
 * any network contact with the swarm.
 */
export function detectFlags(cand, opts = {}) {
  const { wantedTitle = null, runtimeMin = 105, kind = "auto" } = opts;
  const p = cand.parsed;
  const flags = [];

  if (wantedTitle && titleSimilarity(wantedTitle, p.title || cand.title) < 0.5) {
    flags.push("title-mismatch");
  }
  if (cand.seeders === 0) flags.push("dead-swarm");
  else if (cand.seeders > 0 && cand.seeders < 3) flags.push("thin-swarm");

  // Size plausibility — only meaningful for a single video work.
  if ((kind === "movie" || (kind === "auto" && !p.isEpisodic)) && cand.sizeBytes) {
    const band = BITRATE_BANDS[p.resolution];
    const mbps = impliedMbps(cand.sizeBytes, runtimeMin);
    if (band && mbps !== null) {
      if (mbps < band[0]) flags.push("size-implausible-low");
      if (mbps > band[1]) flags.push("size-implausible-high");
    }
    if (p.resolution >= 1080 && cand.sizeBytes < 500 * MB)
      flags.push("resolution-claim-unsupported");
    if (cand.sizeBytes < 100 * MB) flags.push("size-tiny");
    // Resolution-independent floor. Catches untagged listings (archive.org and
    // similar) where the name carries no quality hint at all: a feature-length
    // film simply cannot exist below ~0.35 Mbps. Under it, either the video is
    // unwatchable or — far more often — the item is a clip, a trailer or a
    // commentary track wearing the film's title.
    const mbpsAny = impliedMbps(cand.sizeBytes, runtimeMin);
    if (mbpsAny !== null && mbpsAny < 0.35) flags.push("runtime-size-mismatch");
  }

  // File-list flags, only available after inspect().
  if (Array.isArray(cand.files) && cand.files.length) {
    const paths = cand.files.map((f) => f.path);
    if (paths.some((f) => EXECUTABLE_RE.test(f))) flags.push("executable-payload");
    if (paths.some((f) => DECOY_RE.test(f))) flags.push("decoy-files");
    if (paths.some((f) => ARCHIVE_RE.test(f))) flags.push("archive-payload");

    const hasVideo = paths.some((f) => VIDEO_RE.test(f));
    const hasModel = paths.some((f) => MODEL_RE.test(f));
    const hasDoc = paths.some((f) => DOC_RE.test(f));
    if (!hasVideo && (kind === "movie" || kind === "tv")) flags.push("no-video-file");
    if (hasModel) flags.push("has-3d-models");
    if (hasDoc) flags.push("has-documents");

    const total = cand.files.reduce((a, f) => a + (f.sizeBytes || 0), 0);
    const largest = Math.max(...cand.files.map((f) => f.sizeBytes || 0));
    if (
      (kind === "movie" || (kind === "auto" && !p.isEpisodic)) &&
      total > 0 &&
      largest / total < 0.6 &&
      hasVideo
    ) {
      flags.push("fragmented");
    }
    if (cand.files.length > 300 && (kind === "movie" || kind === "tv"))
      flags.push("file-count-anomaly");
  }
  return flags;
}

/** Rank a gated-clean candidate. Higher is better. */
export function score(cand, opts = {}) {
  const { profile = "best" } = opts;
  const cfg = PROFILES[profile] || PROFILES.best;
  const p = cand.parsed;
  let s = 0;
  const why = [];

  const res = RESOLUTION_POINTS[p.resolution] ?? 10;
  s += res * cfg.resolutionWeight;
  why.push(`resolution ${p.resolution || "?"} +${Math.round(res * cfg.resolutionWeight)}`);

  const src = SOURCE_POINTS[p.source] ?? 0;
  s += src;
  if (src) why.push(`${p.source} +${src}`);

  const aud = AUDIO_POINTS[p.audioCodec] ?? 0;
  s += aud;
  if (aud) why.push(`${p.audioCodec} +${aud}`);

  for (const h of p.hdr) {
    s += HDR_POINTS[h] ?? 0;
    why.push(`${h} +${HDR_POINTS[h] ?? 0}`);
  }
  s += CODEC_POINTS[p.videoCodec] ?? 0;
  s += CHANNEL_POINTS[p.audioChannels] ?? 0;
  if (p.bitDepth === 10) s += 4;
  if (p.isProper) s += 3;
  if (p.edition) s += 2;

  // Swarm health: log-scaled, capped. A perfect release nobody seeds is worthless.
  const health = cand.webseed ? 25 : Math.min(30, 12 * Math.log10(1 + (cand.seeders || 0)));
  s += health;
  why.push(
    `${cand.webseed ? "http webseed" : `${cand.seeders ?? 0} seeders`} +${Math.round(health)}`,
  );

  if (cfg.sizePenaltyAboveGB && cand.sizeBytes > cfg.sizePenaltyAboveGB * GB) {
    const over = (cand.sizeBytes / GB - cfg.sizePenaltyAboveGB) * 2;
    s -= over;
    why.push(`oversize -${Math.round(over)}`);
  }

  const PENALTY = {
    "thin-swarm": 15,
    "size-implausible-low": 30,
    "size-implausible-high": 8,
    "resolution-claim-unsupported": 40,
    "size-tiny": 40,
    "decoy-files": 35,
    "archive-payload": 12,
    fragmented: 10,
    "file-count-anomaly": 15,
    "runtime-size-mismatch": 45,
  };
  for (const f of cand.flags || []) {
    if (PENALTY[f]) {
      s -= PENALTY[f];
      why.push(`${f} -${PENALTY[f]}`);
    }
  }
  return { score: Math.round(s), why };
}

/**
 * Full pipeline over a candidate list: parse -> flag -> gate -> score -> sort.
 * @returns {{kept: object[], rejected: object[]}}
 */
const SEVERE = [
  "size-implausible-low",
  "resolution-claim-unsupported",
  "size-tiny",
  "decoy-files",
  "file-count-anomaly",
  "runtime-size-mismatch",
];

export function rank(candidates, opts = {}) {
  const kept = [];
  const rejected = [];
  for (const raw of candidates) {
    const cand = { ...raw };
    cand.parsed = cand.parsed || parseRelease(cand.title);
    cand.flags = detectFlags(cand, opts);
    const g = gate(cand, opts);
    if (g.rejected) {
      cand.rejectReasons = g.reasons;
      rejected.push(cand);
      continue;
    }
    const { score: sc, why } = score(cand, opts);
    cand.score = sc;
    cand.scoreWhy = why;
    cand.verdict = SEVERE.some((f) => cand.flags.includes(f))
      ? "suspect"
      : cand.flags.length === 0
        ? "clean"
        : "ok";
    kept.push(cand);
  }
  kept.sort((a, b) => b.score - a.score);
  rejected.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  return { kept, rejected };
}

export { SOURCE_LADDER, AUDIO_LADDER };
