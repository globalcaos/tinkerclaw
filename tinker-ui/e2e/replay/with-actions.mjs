#!/usr/bin/env node
/**
 * Add page actions to an existing scenario, placed by ANCHORS in its own frame timeline, so a variant
 * needs no hand-computed times.
 *
 *   node with-actions.mjs <in.json> <out.json> '<actions JSON array>' [--name N] [--end-after-last <ms>]
 *   node with-actions.mjs <in.json> <out.json> @actions.json ...     (the array read from a file)
 *
 * Each action is {do, ...} plus either {at: <ms>} or {after: "<anchor>", plus?: <ms>}. Anchors:
 *   send            the scenario's send action
 *   final-N         the Nth chat final (1-based)          delta-N   the Nth chat delta
 *   break-N         the Nth lifecycle text-block-break     tool-N    the Nth tool start
 *   thinking-N      the Nth agent thinking frame           frame-I   frame index I (0-based)
 *   lifecycle-start / lifecycle-end (first agent lifecycle start / last agent lifecycle end)
 *   last-frame      the last frame                         end       the scenario's end
 * --end-after-last <ms> moves the end to (last frame or action) + ms.
 * Example: '[{"after":"final-1","plus":300,"do":"switch-away"},{"after":"final-1","plus":600,"do":"switch-back"}]'
 */
import fs from "node:fs";

const [, , IN, OUT, ACTIONS, ...rest] = process.argv;
if (!IN || !OUT || !ACTIONS) {
  console.error(
    "usage: node with-actions.mjs <in.json> <out.json> '<actions JSON>' [--name N] [--end-after-last ms]",
  );
  process.exit(2);
}
const flag = (n) => {
  const i = rest.indexOf(`--${n}`);
  return i < 0 ? undefined : rest[i + 1];
};
const s = JSON.parse(fs.readFileSync(IN, "utf-8"));
const frames = s.frames ?? [];
const nth = (pred, n) => {
  let k = 0;
  for (const f of frames) if (pred(f) && ++k === n) return f.at;
  return undefined;
};
function anchor(name) {
  const m = /^([a-z-]+?)(?:-(\d+))?$/.exec(name);
  const [, kind, num] = m ?? [];
  const n = Number(num ?? 1);
  switch (kind) {
    case "send":
      return (s.actions ?? []).find((a) => a.do === "send")?.at;
    case "final":
      return nth((f) => f.event === "chat" && f.payload?.state === "final", n);
    case "delta":
      return nth((f) => f.event === "chat" && f.payload?.state === "delta", n);
    case "break":
      return nth(
        (f) =>
          f.event === "agent" &&
          f.payload?.stream === "lifecycle" &&
          f.payload?.data?.phase === "text-block-break",
        n,
      );
    case "tool":
      return nth(
        (f) =>
          f.event === "agent" && f.payload?.stream === "tool" && f.payload?.data?.phase === "start",
        n,
      );
    case "thinking":
      return nth((f) => f.event === "agent" && f.payload?.stream === "thinking", n);
    case "frame":
      return frames[Number(num)]?.at;
    case "lifecycle-start":
      return frames.find(
        (f) =>
          f.event === "agent" &&
          f.payload?.stream === "lifecycle" &&
          f.payload?.data?.phase === "start",
      )?.at;
    case "lifecycle-end":
      return [...frames]
        .reverse()
        .find(
          (f) =>
            f.event === "agent" &&
            f.payload?.stream === "lifecycle" &&
            f.payload?.data?.phase === "end",
        )?.at;
    case "last-frame":
      return frames.at(-1)?.at;
    case "end":
      return s.end;
    default:
      return undefined;
  }
}
const actionsJson = ACTIONS.startsWith("@") ? fs.readFileSync(ACTIONS.slice(1), "utf-8") : ACTIONS;
const added = JSON.parse(actionsJson).map((a) => {
  if (typeof a.at === "number") return a;
  const base = anchor(String(a.after));
  if (base === undefined) throw new Error(`unknown or absent anchor: ${a.after}`);
  const { after, plus, ...restA } = a;
  return { ...restA, at: base + Number(plus ?? 0), anchor: `${after}${plus ? `+${plus}` : ""}` };
});
s.actions = [...(s.actions ?? []), ...added].sort((a, b) => a.at - b.at);
if (flag("name")) s.name = flag("name");
if (flag("end-after-last")) {
  const last = Math.max(frames.at(-1)?.at ?? 0, ...s.actions.map((a) => a.at));
  s.end = last + Number(flag("end-after-last"));
}
fs.writeFileSync(OUT, JSON.stringify(s, null, 1));
console.log(
  JSON.stringify({
    out: OUT,
    name: s.name,
    end: s.end,
    actions: s.actions.map((a) => ({ at: a.at, do: a.do, anchor: a.anchor })),
  }),
);
