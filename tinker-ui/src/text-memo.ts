/**
 * A size-bounded, most-recently-used memo for a PURE `string → string` function.
 *
 * Plan task 9's delta fast path: with keyed rendering (chat-render.ts) a streaming delta
 * re-parses only the live bubble, but updateChat still rebuilds every row's HTML string to learn
 * which units changed, and the markdown render of each bubble dominates that. The text of a
 * settled bubble does not change between deltas, so its markdown is looked up instead of
 * re-rendered. Only the live bubble's text is new.
 *
 * Bounded by characters (keys + values), not entries: the live bubble adds one entry per delta,
 * each a little longer than the last, and those are the first to go — every repaint touches the
 * settled rows, which keeps them the most recently used.
 */
export type TextMemo = ((text: string) => string) & {
  clear(): void;
  readonly size: number;
};

export function memoizeText(fn: (text: string) => string, maxChars: number): TextMemo {
  const cache = new Map<string, string>();
  let chars = 0;
  const memo = ((text: string): string => {
    const hit = cache.get(text);
    if (hit !== undefined) {
      // Re-insert: a Map iterates in insertion order, so the oldest entry is always first.
      cache.delete(text);
      cache.set(text, hit);
      return hit;
    }
    const out = fn(text);
    const cost = text.length + out.length;
    if (cost > maxChars) {
      return out;
    }
    cache.set(text, out);
    chars += cost;
    for (const [key, value] of cache) {
      if (chars <= maxChars) {
        break;
      }
      cache.delete(key);
      chars -= key.length + value.length;
    }
    return out;
  }) as TextMemo;
  memo.clear = () => {
    cache.clear();
    chars = 0;
  };
  Object.defineProperty(memo, "size", { get: () => cache.size });
  return memo;
}
