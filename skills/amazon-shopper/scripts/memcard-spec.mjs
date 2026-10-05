// memcard-spec.mjs — parse memory-card specs out of an Amazon title.
//
// Sibling of title-spec.mjs (pool chemistry): same idea, different domain.
// microSD titles carry every marking that is printed on the card face, and
// those markings are what actually separate two cards of identical capacity.
//
// The markings, in plain terms:
//   Capacity   128GB / 512GB / 1TB      how much fits
//   Bus        UHS-I / UHS-II           the electrical interface ceiling
//                                       (UHS-I ≈ 104 MB/s, UHS-II ≈ 312 MB/s;
//                                       UHS-II needs a second row of pins AND a
//                                       host that has them — a Raspberry Pi
//                                       does not, so it runs at UHS-I speed)
//   Speed cls  C10 (a "10" in a C)      ≥10 MB/s sustained write. Universal now.
//   UHS class  U1 / U3 (1 or 3 in a U)  ≥10 / ≥30 MB/s sustained write
//   Video cls  V10 / V30 / V60 / V90    ≥10/30/60/90 MB/s sustained write
//   App class  A1 / A2                  RANDOM IOPS floor, not sequential:
//                                       A1 = 1500 read / 500 write IOPS
//                                       A2 = 4000 read / 2000 write IOPS
//   "hasta N MB/s"                      peak SEQUENTIAL read, marketing's
//                                       favourite number and the least
//                                       relevant one for an OS disk
//
// For running an operating system (Raspberry Pi, Steam Deck, phone) the
// number that governs how it FEELS is the app class — random IOPS — not the
// big "MB/s" on the front. For 4K video capture the video class governs.

export function parseMemCardSpec(title) {
  const t = String(title || "");

  // Capacity. Accept "512GB", "512 GB", "1TB", "1 TB".
  let capacity_gb = null;
  const tb = t.match(/(\d+(?:[.,]\d+)?)\s*TB\b/i);
  const gb = t.match(/(\d+(?:[.,]\d+)?)\s*GB\b/i);
  if (tb) capacity_gb = Math.round(parseFloat(tb[1].replace(",", ".")) * 1024);
  else if (gb) capacity_gb = Math.round(parseFloat(gb[1].replace(",", ".")));

  // Bus interface. UHS-II implies the second pin row.
  let bus = null;
  if (/UHS[-\s]?II\b/i.test(t)) bus = "UHS-II";
  else if (/UHS[-\s]?I\b/i.test(t)) bus = "UHS-I";

  // Speed class: "Class 10" / "C10" / "clase 10".
  const speed_class = /\b(?:class|clase)\s*10\b|\bC10\b/i.test(t) ? 10 : null;

  // UHS speed class U1 / U3 (avoid matching "U3" inside a model code by
  // requiring a word boundary and no adjacent alphanumerics).
  let uhs_class = null;
  const u = t.match(/(?:^|[^A-Za-z0-9])U([13])(?![A-Za-z0-9])/);
  if (u) uhs_class = Number(u[1]);

  // Video class V10/V30/V60/V90.
  let video_class = null;
  const v = t.match(/(?:^|[^A-Za-z0-9])V(10|30|60|90)(?![A-Za-z0-9])/);
  if (v) video_class = Number(v[1]);

  // Application performance class A1 / A2.
  let app_class = null;
  const a = t.match(/(?:^|[^A-Za-z0-9])A([12])(?![A-Za-z0-9])/);
  if (a) app_class = Number(a[1]);

  // Peak sequential read: "hasta 190 MB/s" / "190MB/s" / "up to 190 MB/s".
  let read_mbs = null;
  const reads = [...t.matchAll(/(\d{2,4})\s*MB\/s/gi)].map((m) => Number(m[1]));
  if (reads.length) read_mbs = Math.max(...reads);

  return {
    capacity_gb,
    bus,
    speed_class,
    uhs_class,
    video_class,
    app_class,
    read_mbs,
    tier: speedTier({ uhs_class, video_class, app_class, bus }),
  };
}

/**
 * Collapse the markings into one ordinal tier for colour-coding.
 * Deliberately driven by SUSTAINED WRITE (U/V) and RANDOM IOPS (A), never by
 * the "hasta N MB/s" headline, which is peak sequential read and is the number
 * most likely to be flattering rather than informative.
 */
export function speedTier({ uhs_class, video_class, app_class, bus }) {
  const v = video_class ?? 0;
  const u = uhs_class ?? 0;
  const a = app_class ?? 0;
  if (bus === "UHS-II" || v >= 60)
    return { rank: 4, label: "V60+ / UHS-II", note: "Overkill for a Pi; for 6K/8K video capture" };
  if (v >= 30 || u >= 3) {
    return a >= 2
      ? {
          rank: 3,
          label: "V30 · A2",
          note: "Fast sustained write AND high random IOPS — best for an OS disk",
        }
      : { rank: 2, label: "V30 / U3", note: "Fast sustained write; fine for 4K video" };
  }
  if (a >= 1 || u >= 1 || (video_class ?? 0) >= 10) {
    return {
      rank: 1,
      label: "U1 / A1",
      note: "Everyday tier: fine for storage, modest for running an OS",
    };
  }
  return { rank: 0, label: "unmarked", note: "No class markings in the title — treat as unknown" };
}
