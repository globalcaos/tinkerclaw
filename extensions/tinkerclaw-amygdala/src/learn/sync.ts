/**
 * Brings the in-memory question book in line with what the store holds (design doc §7.3): learned versions are stored
 * immutably and the active pointer is a store row, so at start the book must learn both. Idempotent.
 */
import type { QuestionBook } from "../question-book.js";
import type { AmygdalaStore } from "../store.js";

// The store has no "list versions" query: probe upward from 1 and stop after this many consecutive gaps. Versions are
// allocated contiguously above the highest known one, so a run of gaps this long means there are no more.
const MAX_GAP = 8;

export function syncBookFromStore(book: QuestionBook, store: AmygdalaStore): void {
  for (const id of book.ids()) {
    let gaps = 0;
    for (let v = 1; gaps < MAX_GAP; v++) {
      const q = store.getQuestionVersion(id, v);
      if (!q) {
        gaps++;
        continue;
      }
      gaps = 0;
      if (!book.get(id, v)) book.register(q);
    }
    const active = store.activeVersion(id);
    if (active !== undefined && book.get(id, active)) book.setActive(id, active);
  }
}
