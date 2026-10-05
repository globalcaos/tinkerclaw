import { describe, expect, it } from "vitest";
import { syncBookFromStore } from "../src/learn/sync.js";
import { QuestionBook } from "../src/question-book.js";
import { AmygdalaStore } from "../src/store.js";
import type { Question } from "../src/types.js";
import { seedDir } from "./helpers/family-harness.js";

const learned = (book: QuestionBook, id: string, version: number): Question => ({
  ...(book.get(id) as Question),
  version,
  parent: version - 1,
  origin: "learned",
  cutoff: { kind: "prob", at: 0.9 },
});

describe("syncBookFromStore", () => {
  it("registers stored versions and restores the active pointer", () => {
    const store = new AmygdalaStore(":memory:");
    const first = new QuestionBook({ seedDir });
    store.saveQuestionVersion(learned(first, "novelty", 2), "learning", 1);
    store.saveQuestionVersion(learned(first, "novelty", 3), "learning", 2);
    store.setActive("novelty", 2, "c1", 3);

    const fresh = new QuestionBook({ seedDir });
    expect(fresh.versions("novelty")).toHaveLength(1);
    syncBookFromStore(fresh, store);
    expect(fresh.versions("novelty").map((q) => q.version)).toEqual([1, 2, 3]);
    expect(fresh.activeVersion("novelty")).toBe(2);
    expect(fresh.get("novelty")?.origin).toBe("learned");
    // a question with no stored row keeps the book's own pointer
    expect(fresh.activeVersion("surprise")).toBe(1);
  });

  it("is idempotent", () => {
    const store = new AmygdalaStore(":memory:");
    const first = new QuestionBook({ seedDir });
    store.saveQuestionVersion(learned(first, "novelty", 2), "learning", 1);
    store.setActive("novelty", 2, "c1", 2);
    const book = new QuestionBook({ seedDir });
    syncBookFromStore(book, store);
    syncBookFromStore(book, store);
    expect(book.versions("novelty")).toHaveLength(2);
    expect(book.activeVersion("novelty")).toBe(2);
  });

  it("ignores an active row for an id the book does not know, or a version it does not have", () => {
    const store = new AmygdalaStore(":memory:");
    store.setActive("no-such-question", 4, null, 1);
    store.setActive("novelty", 9, null, 1);
    const book = new QuestionBook({ seedDir });
    expect(() => syncBookFromStore(book, store)).not.toThrow();
    expect(book.get("no-such-question")).toBeUndefined();
    expect(book.activeVersion("novelty")).toBe(1);
  });

  it("puts the pointer back to an earlier version after an undo row", () => {
    const store = new AmygdalaStore(":memory:");
    const first = new QuestionBook({ seedDir });
    store.saveQuestionVersion(learned(first, "novelty", 2), "learning", 1);
    store.setActive("novelty", 2, "c1", 2);
    store.setActive("novelty", 1, null, 3);
    const book = new QuestionBook({ seedDir });
    syncBookFromStore(book, store);
    expect(book.activeVersion("novelty")).toBe(1);
    expect(book.get("novelty", 2)).toBeDefined();
  });
});
