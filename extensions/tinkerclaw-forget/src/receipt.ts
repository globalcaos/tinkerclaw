/**
 * The receipt: one row per place, each done, found, not present, out of reach or failed.
 *
 * It never holds the fact. It names files and counts copies, and carries the caller's label
 * ("my old phone number") when one was given; without a label a receipt cannot say what it was
 * for, which is the price of not keeping a copy. No hash either: a phone number's hash is
 * brute-forced in seconds, so it would be a copy with extra steps.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactKind } from "./matcher.js";
import { PLACE_TITLES, PLACES, type PlaceId } from "./places.js";

export type ItemStatus = "done" | "found" | "not_present" | "out_of_reach" | "failed";

export type ReceiptItem = { path: string; status: ItemStatus; copies?: number; detail?: string };

export type PlaceRow = {
  place: PlaceId;
  title: string;
  status: ItemStatus;
  detail: string;
  items: ReceiptItem[];
};

export type FollowUp = { at: string; files: number; copies: number; failed: number };

export type Receipt = {
  id: string;
  at: string;
  mode: "preview" | "apply";
  label?: string;
  fact: { kind: FactKind; spellings: number };
  places: PlaceRow[];
  /** The folders swept. Anything outside them was not searched. */
  searched: string[];
  /** Preview in apply mode: pass it back as `confirm` to forget for real. */
  confirm?: string;
  /** Preview in preview mode: how to turn redaction on. */
  note?: string;
  /** Apply: later passes over the chat record, for the copies this request itself made. */
  followUps?: FollowUp[];
  file?: string;
};

const SEVERITY: Record<ItemStatus, number> = {
  not_present: 0,
  done: 1,
  found: 2,
  out_of_reach: 3,
  failed: 4,
};

/** A place is as bad as its worst item: one failed copy makes the whole place failed. */
export function placeStatus(items: readonly ReceiptItem[]): ItemStatus {
  let worst: ItemStatus = "not_present";
  for (const it of items) {
    if (SEVERITY[it.status] > SEVERITY[worst]) {
      worst = it.status;
    }
  }
  return worst;
}

const STATUS_WORDS: Record<ItemStatus, string> = {
  done: "done",
  found: "found",
  not_present: "not present",
  out_of_reach: "out of reach",
  failed: "FAILED",
};

function summarize(place: PlaceId, items: readonly ReceiptItem[]): string {
  if (items.length === 0) {
    return "nothing held it";
  }
  const copies = items.reduce((n, it) => n + (it.copies ?? 0), 0);
  const parts: string[] = [];
  const by = (s: ItemStatus) => items.filter((it) => it.status === s);
  // A file item names a path; anything else (an index, the provider) is a store.
  const where = (list: readonly ReceiptItem[]) => {
    const files = list.filter((it) => it.path.startsWith("~/") || it.path.startsWith("/")).length;
    const stores = list.length - files;
    return [
      files ? `${files} ${files === 1 ? "file" : "files"}` : "",
      stores ? `${stores} ${stores === 1 ? "store" : "stores"}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
  };
  const copiesNote = copies ? ` (${copies} ${copies === 1 ? "copy" : "copies"})` : "";
  if (by("done").length > 0) {
    parts.push(`cleaned in ${where(by("done"))}${copiesNote}`);
  }
  if (by("found").length > 0) {
    parts.push(`held in ${where(by("found"))}${copiesNote}`);
  }
  for (const it of [...by("failed"), ...by("out_of_reach")]) {
    if (it.detail) {
      parts.push(it.detail);
    }
  }
  if (parts.length === 0 && place !== "provider") {
    return "nothing held it";
  }
  return parts.join("; ");
}

export function buildPlaces(items: ReadonlyMap<PlaceId, ReceiptItem[]>): PlaceRow[] {
  return PLACES.map((place) => {
    const list = items.get(place) ?? [];
    return {
      place,
      title: PLACE_TITLES[place],
      status: placeStatus(list),
      detail: summarize(place, list),
      items: list,
    };
  });
}

const MAX_ITEMS_IN_DETAILS = 20;

/** The receipt with at most 20 items per place, for a tool result that lands in the transcript. */
export function compactReceipt(r: Receipt): Receipt & { itemsTotal: Record<string, number> } {
  const itemsTotal: Record<string, number> = {};
  const places = r.places.map((p) => {
    itemsTotal[p.place] = p.items.length;
    return { ...p, items: p.items.slice(0, MAX_ITEMS_IN_DETAILS) };
  });
  return { ...r, places, itemsTotal };
}

/** The headline the post promises, and only when it is true. */
export function headline(r: Receipt): string {
  if (r.mode === "preview") {
    const held = r.places.filter((p) => p.status === "found").length;
    return held > 0
      ? `Preview: it is held in ${held} of the ${r.places.length} places. Nothing was changed.`
      : "Preview: none of the places I can search holds it. Nothing was changed.";
  }
  const failed = r.places.some((p) => p.status === "failed");
  return failed
    ? "Not every copy I can reach is gone: see the failed rows."
    : "Every copy I can reach is gone.";
}

const MAX_ITEMS_IN_TEXT = 6;

/** The receipt as the agent and its owner read it. */
export function formatReceipt(r: Receipt): string {
  const lines = [`Forget receipt ${r.id}${r.label ? ` (${r.label})` : ""}. ${headline(r)}`];
  for (const p of r.places) {
    lines.push(`- ${p.title}: ${STATUS_WORDS[p.status]}. ${p.detail}.`);
    const shown = p.items.filter((it) => it.status !== "not_present").slice(0, MAX_ITEMS_IN_TEXT);
    for (const it of shown) {
      const copies = it.copies ? ` (${it.copies})` : "";
      lines.push(`    ${STATUS_WORDS[it.status]}: ${it.path}${copies}`);
    }
    const more = p.items.filter((it) => it.status !== "not_present").length - shown.length;
    if (more > 0) {
      lines.push(`    and ${more} more in the receipt file`);
    }
  }
  lines.push(`Searched: ${r.searched.join(", ")}. Anything outside these was not searched.`);
  if (r.file) {
    lines.push(`Receipt file: ${r.file}`);
  }
  if (r.note) {
    lines.push(r.note);
  }
  if (r.mode === "apply") {
    lines.push(
      "The chat record is swept again in 1 and 10 minutes for the copies this request made.",
    );
  }
  if (r.confirm) {
    lines.push(
      `To forget it for real, call forget again with the same fact and confirm: "${r.confirm}" (valid 15 minutes).`,
    );
  }
  return lines.join("\n");
}

/** Write the receipt JSON and one line in the receipt log. Both live under <stateDir>/data/forget. */
export async function writeReceipt(dir: string, r: Receipt): Promise<string> {
  const receipts = join(dir, "receipts");
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const file = join(receipts, `${r.id}.json`);
  await writeFile(file, `${JSON.stringify({ ...r, file }, null, 2)}\n`, { mode: 0o600 });
  const row = r.places
    .map((p) => `${p.title.charAt(0).toLowerCase()}${p.title.slice(1)} ${STATUS_WORDS[p.status]}`)
    .join(", ");
  await appendFile(
    join(dir, "receipts.md"),
    `- ${r.at.slice(0, 16).replace("T", " ")} · ${r.label ?? "no label"} · ${row} · receipts/${r.id}.json\n`,
    { mode: 0o600 },
  );
  return file;
}
