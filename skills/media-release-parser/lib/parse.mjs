// parse.mjs — turn a raw torrent release name into structured properties.
// Pure functions, no I/O. Everything downstream (scoring, gating, fake
// detection) reads the shape produced here.

// Ordered worst -> best. Index doubles as the quality rank.
export const SOURCE_LADDER = [
  "CAM",
  "TS",
  "TC",
  "WORKPRINT",
  "SCR",
  "R5",
  "DVDRip",
  "HDTV",
  "WEBRip",
  "WEB-DL",
  "BluRay",
  "REMUX",
];

// Hard reject list: pre-retail tiers. Never shown as a candidate.
// CAM/TS/TC are literally filmed off a cinema screen; SCR/R5/WORKPRINT are
// unfinished or watermarked pre-release copies. All are barred by default.
export const CAMCORDER_SOURCES = new Set(["CAM", "TS", "TC", "SCR", "R5", "WORKPRINT"]);

// Human-readable reason per rejected tier — a "workprint" is not a camrip and
// saying so wrongly makes the tool look like it is guessing.
export const REJECT_REASON = {
  CAM: "filmed off a cinema screen with a camcorder",
  TS: "telesync — filmed in a cinema with an external audio feed",
  TC: "telecine — pre-release print capture",
  SCR: "screener — watermarked pre-release copy",
  R5: "R5 retail rip — pre-release, typically poor transfer",
  WORKPRINT: "workprint — unfinished cut, missing effects and grading",
};

const SOURCE_PATTERNS = [
  [/\b(remux)\b/i, "REMUX"],
  [/\b(blu[- .]?ray|bdrip|brrip|bdremux|bd25|bd50|uhd[- .]?bd)\b/i, "BluRay"],
  [/\b(web[- .]?dl|webdl|amzn|nf|dsnp|atvp|hmax|itunes)\b/i, "WEB-DL"],
  [/\b(web[- .]?rip|webrip)\b/i, "WEBRip"],
  [/\b(hdtv|pdtv|dsr|sdtv)\b/i, "HDTV"],
  [/\b(dvd[- .]?rip|dvdr|ntsc|pal)\b/i, "DVDRip"],
  [/\b(workprint|work[- .]print)\b/i, "WORKPRINT"],
  [/\b(dvd[- .]?scr|screener)\b/i, "SCR"],
  [/\b(telecine)\b/i, "TC"],
  [/\b(telesync|hd[- .]?ts)\b/i, "TS"],
  [/\b(hd[- .]?cam|cam[- .]?rip|camrip|new[- .]?cam)\b/i, "CAM"],
];

// Bare two/three-letter tags are only trustworthy inside a scene-style name.
// A film titled "Cam" (2018) or a doc about "TS" must not be gated as a camrip.
const AMBIGUOUS_SOURCE_PATTERNS = [
  [/\br5\b/i, "R5"],
  [/\bscr\b/i, "SCR"],
  [/\btc\b/i, "TC"],
  [/\bts\b/i, "TS"],
  [/\bcam\b/i, "CAM"],
];

/**
 * A scene release name carries machine tags: dots/underscores as separators,
 * or an explicit resolution/codec/source token. Natural-language titles do not.
 */
function looksLikeSceneRelease(rawName, normName) {
  if (/[._]\w/.test(rawName) && rawName.split(/[._]/).length >= 4) return true;
  return /\b(2160p|1080p|720p|480p|x26[45]|h[. ]?26[45]|hevc|xvid|divx|bluray|blu ray|web[- ]?dl|webrip|hdtv|dvdrip|remux|aac|ac3|dts|ddp?\d)\b/i.test(
    normName,
  );
}

const RESOLUTIONS = [
  [/\b(4320p|8k)\b/i, 4320],
  [/\b(2160p|4k|uhd)\b/i, 2160],
  [/\b(1440p|2k)\b/i, 1440],
  [/\b1080[pi]\b/i, 1080],
  [/\b720[pi]\b/i, 720],
  [/\b(576[pi]|480[pi]|360p|240p)\b/i, 480],
];

const VIDEO_CODECS = [
  [/\b(av1)\b/i, "AV1"],
  [/\b(x265|h[. ]?265|hevc)\b/i, "HEVC"],
  [/\b(x264|h[. ]?264|avc)\b/i, "H264"],
  [/\b(xvid|divx|mpeg-?4)\b/i, "XviD"],
  [/\b(vc-?1)\b/i, "VC1"],
];

// Ordered worst -> best. Index doubles as the audio quality rank.
export const AUDIO_LADDER = [
  "MP3",
  "AAC",
  "AC3",
  "EAC3",
  "DTS",
  "FLAC",
  "DTS-HD",
  "TrueHD",
  "Atmos",
];

const AUDIO_CODECS = [
  [/\b(atmos)\b/i, "Atmos"],
  [/\b(true[- .]?hd)\b/i, "TrueHD"],
  [/\b(dts[- .]?hd([- .]?ma)?|dts[- .]?x)\b/i, "DTS-HD"],
  [/\b(flac)\b/i, "FLAC"],
  [/\b(dts)\b/i, "DTS"],
  [/(\be[- .]?ac3\b|\beac3\b|\bddp\d?\b|\bdd\+)/i, "EAC3"],
  [/(\bac3\b|\bdd\d[. ]?\d\b|\bdolby[- .]?digital\b)/i, "AC3"],
  [/\baac\d?\b/i, "AAC"],
  [/\b(mp3)\b/i, "MP3"],
];

const HDR_PATTERNS = [
  [/\b(dv|dolby[- .]?vision)\b/i, "DolbyVision"],
  [/\b(hdr10\+|hdr10plus)\b/i, "HDR10+"],
  [/\b(hdr10|hdr)\b/i, "HDR10"],
  [/\b(hlg)\b/i, "HLG"],
];

const EDITIONS =
  /\b(directors?[- .]?cut|extended|uncut|unrated|theatrical|imax|criterion|remastered|final[- .]?cut|ultimate[- .]?edition|special[- .]?edition)\b/i;

// Language hints the operator reads natively or well enough. Present so a caller can
// SEE the tag; there is deliberately no subtitle logic in this skill.
const LANG_PATTERNS = [
  [/\b(multi|dual[- .]?audio|dual)\b/i, "MULTI"],
  [/\b(vose|vo|eng|english)\b/i, "EN"],
  [/\b(spa|spanish|castellano|esp|latino)\b/i, "ES"],
  [/\b(cat|catalan|catala)\b/i, "CA"],
  [/\b(fre|french|vff|vfq|truefrench)\b/i, "FR"],
  [/\b(ita|italian)\b/i, "IT"],
  [/\b(ger|german|deu)\b/i, "DE"],
  [/\b(por|portuguese|pt-?br)\b/i, "PT"],
];

function firstMatch(name, table, fallback = null) {
  for (const [re, value] of table) if (re.test(name)) return value;
  return fallback;
}

function allMatches(name, table) {
  const out = [];
  for (const [re, value] of table) if (re.test(name) && !out.includes(value)) out.push(value);
  return out;
}

/** Strip separators so word-boundary regexes behave on dotted release names. */
function normalizeName(raw) {
  return String(raw || "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Release group is conventionally the trailing "-GROUP" token. */
function extractGroup(raw) {
  const name = String(raw || "").trim();
  const bad = (g) =>
    !g || /^\d+$/.test(g) || /^(1080p|720p|2160p|x264|x265|hevc|web|dl|bluray|aac|hdr)$/i.test(g);
  // "-GROUP" or "-GROUP.mkv" at the end — the scene convention.
  let m = name.match(/-([A-Za-z0-9]{2,20})(?:\.\w{2,4})?$/);
  if (m && !bad(m[1])) return m[1];
  // "-GROUP[anything]" FIRST: the bracket here is a tracker's own tag, so the
  // group is what precedes it. Checking the bracket form first would return
  // "rartv" for "…-NTb[rartv]" — the tracker, not the release group.
  m = name.match(/-([A-Za-z0-9]{2,20})\s*\[/);
  if (m && !bad(m[1])) return m[1];
  // "[GROUP]" at the end — common on p2p and public trackers.
  m = name.match(/\[([A-Za-z0-9][A-Za-z0-9 ._-]{1,24})\]\s*$/);
  if (m && !bad(m[1].trim())) return m[1].trim();
  return null;
}

function extractYear(name) {
  const matches = [...name.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!matches.length) return null;
  const now = new Date().getFullYear() + 1;
  const plausible = matches.filter((y) => y >= 1900 && y <= now);
  return plausible.length ? plausible[0] : null;
}

function extractEpisode(name) {
  let m = name.match(/\bS(\d{1,2})[ .]?E(\d{1,3})\b/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = name.match(/\bS(\d{1,2})\b(?![ .]?E)/i);
  if (m) return { season: Number(m[1]), episode: null };
  m = name.match(/\b(\d{1,2})x(\d{2})\b/);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  return { season: null, episode: null };
}

/** Everything before the year / resolution / source tag is the title. */
function extractTitle(name, year) {
  let head = name;
  if (year) head = name.split(String(year))[0];
  else {
    const cut = head.search(
      /\b(2160p|1080p|720p|480p|4k|uhd|bluray|blu ray|web|webrip|hdtv|dvdrip|x264|x265|hevc|remux|s\d{1,2}e\d{1,3})\b/i,
    );
    if (cut > 0) head = head.slice(0, cut);
  }
  return head
    .replace(/[-–(\[\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a raw release name into structured properties.
 * @param {string} raw
 * @returns {object} parsed properties; every field may be null when unknown.
 */
export function parseRelease(raw) {
  const name = normalizeName(raw);
  const year = extractYear(name);
  const { season, episode } = extractEpisode(name);
  let source = firstMatch(name, SOURCE_PATTERNS);
  if (!source && looksLikeSceneRelease(String(raw || ""), name)) {
    source = firstMatch(name, AMBIGUOUS_SOURCE_PATTERNS);
  }
  const audio = firstMatch(name, AUDIO_CODECS);

  return {
    raw: String(raw || ""),
    title: extractTitle(name, year),
    year,
    season,
    episode,
    isEpisodic: season !== null,
    resolution: firstMatch(name, RESOLUTIONS),
    source,
    sourceRank: source ? SOURCE_LADDER.indexOf(source) : -1,
    isCamcorder: source ? CAMCORDER_SOURCES.has(source) : false,
    videoCodec: firstMatch(name, VIDEO_CODECS),
    audioCodec: audio,
    audioRank: audio ? AUDIO_LADDER.indexOf(audio) : -1,
    audioChannels: (name.match(/([25678])[. ]([01])\b/) || [])[0]?.replace(" ", ".") || null,
    hdr: allMatches(name, HDR_PATTERNS),
    bitDepth: /\b10[- ]?bits?\b/i.test(name) ? 10 : /\b8[- ]?bits?\b/i.test(name) ? 8 : null,
    edition: (name.match(EDITIONS) || [null])[0],
    languages: allMatches(name, LANG_PATTERNS),
    group: extractGroup(raw),
    isProper: /\b(proper|repack)\b/i.test(name),
  };
}

/**
 * Token-overlap similarity between what was asked for and what came back.
 * Used to catch results that share a keyword but are a different work.
 * @returns {number} 0..1
 */
export function titleSimilarity(wanted, got) {
  const tok = (s) =>
    new Set(
      normalizeName(s)
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2 && !["the", "and", "for"].includes(t)),
    );
  const a = tok(wanted);
  const b = tok(got);
  if (!a.size) return 1;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  return hit / a.size;
}
