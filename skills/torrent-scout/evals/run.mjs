#!/usr/bin/env node
// run.mjs — execute the mechanically checkable eval cases.
//
// queries.jsonl documents the full intent of each case, including the ones
// that need a live indexer. This runner covers everything that can be decided
// from fixtures, so a threshold change is measured rather than guessed.

import { parseRelease } from "../lib/parse.mjs";
import { rank, detectFlags, gate } from "../lib/score.mjs";

const CASES = [];
const t = (id, fn) => CASES.push({ id, fn });
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const DUNE = [
  {
    title: "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR.TrueHD.Atmos.7.1-FraMeSToR",
    sizeBytes: 82 * 1024 ** 3,
    seeders: 41,
  },
  {
    title: "Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX",
    sizeBytes: 8 * 1024 ** 3,
    seeders: 920,
  },
  {
    title: "Dune.Part.Two.2024.HDCAM.c1nem4.x264-SUNSCREEN",
    sizeBytes: 1.2 * 1024 ** 3,
    seeders: 2200,
  },
  {
    title: "Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.HDR.H.265-NAISU",
    sizeBytes: 420 * 1024 ** 2,
    seeders: 14,
  },
  { title: "Dune.1984.1080p.BluRay.x264-AMIABLE", sizeBytes: 12 * 1024 ** 3, seeders: 300 },
  { title: "Dune.Part.Two.2024.1080p.WEB.h264-ETHEL", sizeBytes: 0, seeders: 0 },
];
const OPTS = {
  wantedTitle: "dune part two",
  kind: "movie",
  runtime: 166,
  runtimeMin: 166,
  profile: "best",
};

t("cam-gate-01", () => {
  const { kept, rejected } = rank(DUNE, OPTS);
  ok(!kept.some((c) => c.parsed.isCamcorder), "a camcorder tier reached kept[]");
  ok(
    rejected.some((c) => c.parsed.source === "CAM"),
    "the HDCAM was not rejected",
  );
  ok(kept[0].parsed.source === "REMUX", `expected REMUX first, got ${kept[0].parsed.source}`);
  return `top=${kept[0].parsed.source} ${kept[0].parsed.resolution}p, ${rejected.length} rejected`;
});

t("cam-only-01", () => {
  const only = DUNE.filter((c) => parseRelease(c.title).isCamcorder);
  const { kept, rejected } = rank(only, OPTS);
  ok(kept.length === 0, "a camcorder-only set produced a candidate");
  ok(
    rejected.every((r) => r.parsed.isCamcorder),
    "unexpected rejection reason",
  );
  return 'camcorder-only set yields zero candidates => "not available yet"';
});

t("title-mismatch-01", () => {
  const { rejected } = rank(DUNE, OPTS);
  const d84 = rejected.find((r) => r.title.startsWith("Dune.1984"));
  ok(d84, 'Dune (1984) was not rejected against a "dune part two" query');
  ok(d84.rejectReasons.join(" ").includes("does not match"), "wrong rejection reason");
  return "Dune (1984) rejected: title mismatch";
});

t("fake-size-01", () => {
  const { kept } = rank(DUNE, OPTS);
  const naisu = kept.find((c) => c.title.includes("NAISU"));
  ok(naisu, "the undersized 2160p release was gated instead of flagged");
  ok(naisu.verdict === "suspect", `expected suspect, got ${naisu.verdict}`);
  ok(naisu.flags.includes("resolution-claim-unsupported"), "missing resolution-claim-unsupported");
  return `flags: ${naisu.flags.join(", ")}`;
});

t("clip-not-film-01", () => {
  const set = [
    {
      title: "Night of the Living Dead (1968) [feature]",
      sizeBytes: 6.3 * 1024 ** 3,
      seeders: null,
      webseed: true,
    },
    {
      title: "MONDO COMMENTARY: Night of the Living Dead",
      sizeBytes: 119 * 1024 ** 2,
      seeders: null,
      webseed: true,
    },
  ];
  const { kept } = rank(set, {
    wantedTitle: "night of the living dead",
    kind: "movie",
    runtimeMin: 96,
  });
  ok(kept[0].title.includes("feature"), "the commentary track outranked the feature");
  ok(
    kept[1].flags.includes("runtime-size-mismatch"),
    "bitrate floor did not fire on the 119MB item",
  );
  return `feature ${kept[0].score} > commentary ${kept[1].score}`;
});

t("ambiguous-tag-01", () => {
  ok(parseRelease("Cam (2018)").isCamcorder === false, '"Cam (2018)" was gated as a camrip');
  ok(
    parseRelease("Cam.2018.1080p.NF.WEB-DL.DDP5.1.x264-NTG").source === "WEB-DL",
    "scene-style Cam misparsed",
  );
  ok(
    parseRelease("The Big TS Documentary").isCamcorder === false,
    "a plain title containing TS was gated",
  );
  ok(parseRelease("Some.Movie.2024.TS.x264-GRP").source === "TS", "a real telesync was missed");
  return "bare tags honoured only inside scene-style names";
});

t("workprint-01", () => {
  const c = {
    title: "Night Of The Living Dead 1990 Workprint",
    sizeBytes: 2 * 1024 ** 3,
    seeders: 5,
  };
  c.parsed = parseRelease(c.title);
  c.flags = detectFlags(c, { kind: "movie", runtimeMin: 92 });
  const g = gate(c, { kind: "movie" });
  ok(c.parsed.source === "WORKPRINT", `expected WORKPRINT, got ${c.parsed.source}`);
  ok(g.rejected, "workprint not rejected");
  ok(g.reasons.join(" ").includes("unfinished cut"), `reason says: ${g.reasons.join(" ")}`);
  ok(!g.reasons.join(" ").includes("camcorder"), "workprint mislabelled as a camcorder rip");
  return g.reasons[0];
});

t("exec-payload-01", () => {
  const c = {
    title: "Some.Movie.2024.1080p.WEB-DL.x264-GRP",
    sizeBytes: 4 * 1024 ** 3,
    seeders: 30,
    files: [
      { path: "Some.Movie/movie.mp4", sizeBytes: 4 * 1024 ** 3 },
      { path: "Some.Movie/Codec_Installer.exe", sizeBytes: 2 * 1024 ** 2 },
    ],
  };
  c.parsed = parseRelease(c.title);
  c.flags = detectFlags(c, { kind: "movie", runtimeMin: 105, wantedTitle: "some movie" });
  const g = gate(c, { kind: "movie" });
  ok(c.flags.includes("executable-payload"), "executable not flagged");
  ok(g.rejected, "executable payload not gated");
  return g.reasons[0];
});

t("models-01", () => {
  const c = {
    title: "Prusa MK4 Upgrade Blueprints Pack",
    sizeBytes: 300 * 1024 ** 2,
    seeders: 12,
    files: [
      { path: "pack/frame.stl", sizeBytes: 200 * 1024 ** 2 },
      { path: "pack/assembly.step", sizeBytes: 90 * 1024 ** 2 },
      { path: "pack/manual.pdf", sizeBytes: 10 * 1024 ** 2 },
    ],
  };
  c.parsed = parseRelease(c.title);
  c.flags = detectFlags(c, { kind: "models", wantedTitle: "prusa mk4 upgrade blueprints" });
  ok(c.flags.includes("has-3d-models"), "model files not detected");
  ok(c.flags.includes("has-documents"), "documents not detected");
  ok(!c.flags.includes("no-video-file"), "video flag wrongly fired on a model pack");
  return c.flags.join(", ");
});

t("lang-neutral-01", () => {
  const base = "Movie.2024.1080p.WEB-DL.DDP5.1.x264-GRP";
  const a = rank([{ title: base, sizeBytes: 8 * 1024 ** 3, seeders: 50 }], {
    wantedTitle: "movie",
    kind: "movie",
  });
  const b = rank(
    [{ title: base.replace("1080p", "1080p.MULTI.VOSE"), sizeBytes: 8 * 1024 ** 3, seeders: 50 }],
    { wantedTitle: "movie", kind: "movie" },
  );
  ok(
    a.kept[0].score === b.kept[0].score,
    `language tags moved the score: ${a.kept[0].score} vs ${b.kept[0].score}`,
  );
  ok(b.kept[0].parsed.languages.length > 0, "language tags were not even parsed for display");
  return `score unchanged (${a.kept[0].score}); tags shown: ${b.kept[0].parsed.languages.join("/")}`;
});

let pass = 0;
let fail = 0;
for (const c of CASES) {
  try {
    const note = c.fn();
    pass += 1;
    console.log(`  PASS  ${c.id.padEnd(22)} ${note || ""}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL  ${c.id.padEnd(22)} ${e.message}`);
  }
}
console.log(`\n${pass}/${CASES.length} passed${fail ? `, ${fail} FAILED` : ""}`);
console.log("(cam-only-01, inspect-truth-01, no-seed-01, gate-before-fetch-01, deeper-01,");
console.log(" stable-refs-01 also have live-indexer forms documented in queries.jsonl)");
process.exit(fail ? 1 : 0);
