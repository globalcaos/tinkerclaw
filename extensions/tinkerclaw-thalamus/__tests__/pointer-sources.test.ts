import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPointerSources,
  FRESH_CHAT_MS,
  listNoteFiles,
  readChatCatalog,
  readNoteDocs,
} from "../src/pointer-sources.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "thalamus-pointers-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeNote = (dir: string, name: string, description: string): string => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.md`);
  writeFileSync(p, `---\nname: ${name}\ndescription: "${description}"\n---\n\nbody\n`);
  return p;
};

/** A catalogue with the ask-session skill's `cards` columns the reader uses. */
function writeCatalog(
  path: string,
  rows: Array<{ id: string; kind: string; title: string; last: string; prompts?: string }>,
): void {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE cards (id TEXT PRIMARY KEY, kind TEXT, title TEXT, prompts TEXT, summary TEXT, last_ts TEXT, last_work_ts TEXT)",
  );
  const ins = db.prepare(
    "INSERT INTO cards(id,kind,title,prompts,summary,last_ts,last_work_ts) VALUES(?,?,?,?,?,?,?)",
  );
  for (const r of rows) {
    ins.run(r.id, r.kind, r.title, r.prompts ?? r.title, null, r.last, r.last);
  }
  db.close();
}

describe("the note folders", () => {
  it("lists Markdown two levels deep, never MEMORY.md, a daily log or a hidden folder, and a linked folder once", async () => {
    const mem = join(root, "memory");
    const a = writeNote(mem, "topic_a", "Topic A");
    const b = writeNote(join(mem, "knowledge"), "topic_b", "Topic B");
    writeNote(join(mem, "knowledge", "deeper"), "too_deep", "Too deep");
    writeNote(join(mem, ".git"), "hidden", "Hidden");
    writeFileSync(join(mem, "MEMORY.md"), "# index");
    writeFileSync(join(mem, "2026-10-25.md"), "# daily log");
    writeFileSync(join(mem, "data.json"), "{}");
    symlinkSync(join(mem, "knowledge"), join(root, "bank"));
    const files = await listNoteFiles([mem, join(root, "bank"), join(root, "missing")]);
    expect(files.toSorted()).toEqual([a, b].toSorted());
  });
});

describe("rereading the note folders", () => {
  it("reads nothing again while no file changed, and everything once one did", async () => {
    const mem = join(root, "memory");
    writeNote(mem, "topic_a", "Topic A");
    const first = await readNoteDocs([mem]);
    expect(first.docs?.map((d) => d.label)).toEqual(["Topic A"]);
    expect(await readNoteDocs([mem], first.sig)).toEqual({ sig: first.sig });
    writeNote(mem, "topic_b", "Topic B");
    const third = await readNoteDocs([mem], first.sig);
    expect(third.docs?.map((d) => d.label).toSorted()).toEqual(["Topic A", "Topic B"]);
  });
});

describe("the chat catalogue", () => {
  it("reads the owner's sessions, newest first, and is silent on a missing or foreign file", () => {
    const cat = join(root, "catalog.sqlite");
    writeCatalog(cat, [
      { id: "old", kind: "main", title: "older", last: "2026-09-01T00:00:00Z" },
      { id: "new", kind: "main", title: "newer", last: "2026-10-01T00:00:00Z" },
      { id: "sub", kind: "subagent", title: "a subagent", last: "2026-10-02T00:00:00Z" },
    ]);
    expect(readChatCatalog(cat)?.map((r) => r.id)).toEqual(["new", "old"]);
    expect(readChatCatalog(join(root, "nope.sqlite"))).toBeUndefined();
    const other = join(root, "other.sqlite");
    new Database(other).exec("CREATE TABLE x(a)");
    expect(readChatCatalog(other)).toBeUndefined();
  });
});

describe("the pointer sources", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");

  it("says index-building until the first build is done, then finds notes and chats", async () => {
    const mem = join(root, "memory");
    writeNote(
      mem,
      "olive_oil_coop",
      "Olive oil cooperative signup form link and the break-even sheet",
    );
    for (let i = 0; i < 30; i++) {
      writeNote(mem, `filler_${i}`, `Weekly agenda note ${i}`);
    }
    const cat = join(root, "catalog.sqlite");
    writeCatalog(cat, [
      {
        id: "aaaaaaaa-1111",
        kind: "main",
        title: "Fill the olive oil cooperative signup form",
        prompts: "Fill the olive oil cooperative signup form with the break-even numbers",
        last: "2026-03-10T10:00:00Z",
      },
    ]);
    const src = createPointerSources({
      noteDirs: () => [mem],
      chatCatalog: () => cat,
      now: () => now,
    });
    const text = "send me the olive oil cooperative signup form link we used last time";
    expect(src.find(text, { maxNotes: 2, maxChats: 1 })).toEqual({ skip: "index-building" });
    await src.warm();
    const got = src.find(text, { maxNotes: 2, maxChats: 1 });
    expect("skip" in got).toBe(false);
    if ("skip" in got) {
      return;
    }
    expect(got.notes.map((h) => h.id)).toEqual([join(mem, "olive_oil_coop.md")]);
    expect(got.chats.map((h) => h.id)).toEqual(["aaaaaaaa-1111"]);
    expect(src.stats()).toMatchObject({ notes: 31, chats: 1 });
  });

  it("never offers a chat worked in the last hour: that is the chat the prompt is typed in", async () => {
    const cat = join(root, "catalog.sqlite");
    const title = "Fill the olive oil cooperative signup form";
    writeCatalog(cat, [
      {
        id: "fresh",
        kind: "main",
        title,
        last: new Date(now - FRESH_CHAT_MS / 2).toISOString(),
      },
    ]);
    const src = createPointerSources({
      noteDirs: () => [],
      chatCatalog: () => cat,
      now: () => now,
    });
    await src.warm();
    const got = src.find("fill the olive oil cooperative signup form", {
      maxNotes: 2,
      maxChats: 1,
    });
    expect(got).toEqual({ notes: [], chats: [] });
  });

  it("with no folder and no catalogue there is nothing to point at", async () => {
    const src = createPointerSources({ noteDirs: () => [], chatCatalog: () => "", now: () => now });
    await src.warm();
    expect(src.find("anything at all here", { maxNotes: 2, maxChats: 1 })).toEqual({
      skip: "no-sources",
    });
  });
});
