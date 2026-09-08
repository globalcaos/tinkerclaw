// sdcard-spec.mjs — decode the markings printed on a microSD card from its title.
//
// Why this exists (2026-08-06): a €/GB ranking of memory cards is misleading on
// its own. Two 128 GB cards at the same price can differ 10x in sustained write
// speed, and the difference is expressed only as a cluster of tiny logos —
// A2, U3, V30, C10 — that the title repeats verbatim. Ranking without them
// recommends a card that is cheap and too slow for the job.
//
// The four independent marking families (they are NOT alternatives; a card
// usually carries one from each):
//
//   Class 10 / C10   Legacy minimum sustained WRITE of 10 MB/s. Nearly every
//                    card claims it; it discriminates almost nothing today.
//   U1 / U3          UHS Speed Class: minimum sustained write 10 / 30 MB/s.
//   V10 … V90        Video Speed Class: minimum sustained write 10 … 90 MB/s.
//                    V30 is the practical floor for 4K video.
//   A1 / A2          App Performance Class: minimum RANDOM IOPS (1500/500 vs
//                    4000/2000). This is the one that matters when the card
//                    runs an OS — a Raspberry Pi boots and feels fast on A2,
//                    sluggish on A1, regardless of the big "MB/s" number.
//
// The headline "up to N MB/s" is a SEQUENTIAL READ best case and is the least
// informative number on the package, which is why it is printed largest.

/**
 * Accessories that are NOT memory cards but rank as absurdly good value,
 * because their title quotes a capacity they merely SUPPORT.
 *
 * 2026-08-06: "SD2Vita 6.0 Adapter for PS Vita — supports microSD 256GB" at
 * €6.95 scored 0.027 €/GB, ten times better than any real card, and landed on
 * the chart as the best buy on the board. A €/GB ranking is only meaningful
 * across things that actually store the GB.
 */
export function isAccessory(title) {
  const t = title || "";
  return /\b(sd2vita|ps ?vita|card reader|lector de tarjetas|kartenhalter|card holder|card case|memory card case|extension cable|card to ms|adapter for (ps|nintendo|steam)|cr5400)\b/i.test(
    t,
  );
}

/**
 * "1TB" → 1024, "512 GB" → 512. Returns null when no capacity is stated.
 * A capacity introduced by "supports"/"up to"/"hasta"/"compatible with" is a
 * LIMIT, not the product's own size, and is ignored.
 */
export function parseCapacityGb(title) {
  if (!title) return null;
  if (isAccessory(title)) return null;

  const SUPPORT_CTX =
    /(support[s]?|up to|hasta|compatible (with|con)|max(imum)?)\s*(micro\s?sd\w*\s*)?$/i;
  const notSupported = (m) => !SUPPORT_CTX.test(title.slice(Math.max(0, m.index - 28), m.index));

  const tb = [...title.matchAll(/(\d+(?:[.,]\d+)?)\s*TB\b/gi)].find(notSupported);
  if (tb) return Math.round(parseFloat(tb[1].replace(",", ".")) * 1024);
  const gb = [...title.matchAll(/(\d+)\s*GB\b/gi)].find(notSupported);
  if (gb) return Number(gb[1]);
  // Some sellers write the bare unit ("3 Packs of 64G Micro SDXC").
  const g = [...title.matchAll(/\b(\d{2,4})\s*G\b/g)].find(notSupported);
  if (g) return Number(g[1]);
  return null;
}

/** "Pack of 5", "5 Pack", "2-pack", "Paquete de 3" → 5/5/2/3. Default 1. */
export function parsePackCount(title) {
  if (!title) return 1;
  const m =
    title.match(/pack(?:et)?\s*(?:of|de)\s*(\d+)/i) ||
    title.match(/(\d+)\s*[-\s]?pack\b/i) ||
    title.match(/paquete\s*de\s*(\d+)/i) ||
    title.match(/\b(\d+)\s*unidades\b/i);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 && n <= 20 ? n : 1;
}

/** Highest "up to N MB/s" claim in the title — sequential read, best case. */
export function parseReadMbs(title) {
  if (!title) return null;
  const all = [...title.matchAll(/(\d{2,4})\s*MB\s*\/\s*s/gi)].map((m) => Number(m[1]));
  return all.length ? Math.max(...all) : null;
}

/**
 * The marking cluster. Each field is null when the card does not claim it,
 * which is itself information — an absent A-class means "not rated for apps".
 */
export function parseSpeedMarks(title) {
  const t = title || "";
  const app = /\bA2\b/.test(t) ? "A2" : /\bA1\b/.test(t) ? "A1" : null;
  const uhs = /\bU3\b|UHS[- ]?I{0,3}\s*U3/.test(t) ? "U3" : /\bU1\b/.test(t) ? "U1" : null;
  const vMatch = t.match(/\bV(10|30|60|90)\b/);
  const video = vMatch ? `V${vMatch[1]}` : null;
  const legacy = /\bclass\s*10\b|\bC10\b|\bclase\s*10\b/i.test(t) ? "C10" : null;
  const bus = /UHS[- ]?II\b/i.test(t) ? "UHS-II" : /UHS[- ]?I\b/i.test(t) ? "UHS-I" : null;
  return { app, uhs, video, legacy, bus };
}

/**
 * Collapse the cluster into one tier for colour-coding and for a plain-language
 * verdict. Deliberately weights the APP class highest: for an OS disk (the
 * Raspberry Pi case) random IOPS dominates perceived speed, and it is the mark
 * buyers most often ignore in favour of the big MB/s number.
 */
export function speedTier(marks, readMbs) {
  const { app, uhs, video, legacy, bus } = marks;
  if (bus === "UHS-II" || video === "V60" || video === "V90") {
    return { tier: 4, name: "Pro", why: "UHS-II or V60+: sustained high-bitrate video" };
  }
  if (app === "A2" && (video === "V30" || uhs === "U3")) {
    return {
      tier: 3,
      name: "Fast",
      why: "A2 random IOPS + 30 MB/s sustained write — best for an OS disk",
    };
  }
  if (video === "V30" || uhs === "U3" || (readMbs && readMbs >= 150)) {
    return {
      tier: 2,
      name: "Good",
      why: "30 MB/s sustained write — fine for 4K video, average for an OS",
    };
  }
  if (app === "A1" || video === "V10" || uhs === "U1" || legacy === "C10") {
    return {
      tier: 1,
      name: "Basic",
      why: "10 MB/s sustained write — photos and files, sluggish as an OS disk",
    };
  }
  return { tier: 0, name: "Unrated", why: "no speed class stated in the listing" };
}

/** One call: everything derivable from a listing title. */
export function parseSdCard(title) {
  const capacity_gb = parseCapacityGb(title);
  const pack_count = parsePackCount(title);
  const read_mbs = parseReadMbs(title);
  const marks = parseSpeedMarks(title);
  const tier = speedTier(marks, read_mbs);
  return {
    capacity_gb,
    pack_count,
    read_mbs,
    marks,
    marks_label: [marks.app, marks.uhs, marks.video, marks.legacy].filter(Boolean).join(" "),
    ...tier,
  };
}
