// FORK 2026-10-06 (the user: "Me, the admin user, will have access to all the chats of all the users,
// and the UI will divide the chats into groups with their owner's tags").
//
// In multi-user mode the door tags every row of `sessions.list` with `hiveOwner`, `hiveOwnerName`
// and `hiveScope` ("private" | "user" | "legacy" | "system"). This orders an admin's chat list by
// owner and says where each owner's header goes. Open tabs keep their place at the top, untouched:
// grouping applies to the rest. Rows with no tags (single-user mode) come back unchanged.

export type HiveMe = {
  operatorId: string;
  displayName: string;
  admin: boolean;
  mainSessionKey?: string;
  multiUser?: boolean;
};

type Tagged = { hiveOwner?: string | null; hiveOwnerName?: string; hiveScope?: string };

export function ownerBucket(
  session: unknown,
  selfId: string,
): { id: string; label: string; rank: number } | null {
  const s = (session ?? {}) as Tagged;
  if (!s.hiveScope) return null;
  if (s.hiveOwner && s.hiveOwner === selfId) return { id: "self", label: "Mine", rank: 0 };
  if (s.hiveScope === "legacy")
    return { id: "legacy", label: s.hiveOwnerName || "Shared", rank: 2 };
  if (s.hiveScope === "system") return { id: "system", label: "System", rank: 3 };
  const id = s.hiveOwner || "unknown";
  return { id, label: s.hiveOwnerName || id, rank: 1 };
}

/**
 * @returns the items in display order and, per index, the owner header to paint above that row.
 */
export function groupByOwner<T>(
  items: readonly T[],
  sessionOf: (item: T) => unknown,
  selfId: string,
  isOpen: (item: T) => boolean,
): { ordered: T[]; headers: Map<number, string> } {
  const headers = new Map<number, string>();
  if (!items.some((it) => ownerBucket(sessionOf(it), selfId))) {
    return { ordered: [...items], headers };
  }
  let prefix = 0;
  while (prefix < items.length && isOpen(items[prefix])) prefix++;
  const head = items.slice(0, prefix);
  const rest = items
    .slice(prefix)
    .map((item, i) => ({ item, i, b: ownerBucket(sessionOf(item), selfId) }))
    .sort((x, y) => {
      const rx = x.b?.rank ?? 4;
      const ry = y.b?.rank ?? 4;
      if (rx !== ry) return rx - ry;
      const lx = x.b?.label ?? "";
      const ly = y.b?.label ?? "";
      return lx === ly ? x.i - y.i : lx.localeCompare(ly);
    });
  let last = "";
  rest.forEach((r, j) => {
    const id = r.b ? `${r.b.rank}:${r.b.id}` : "none";
    if (id !== last) {
      headers.set(prefix + j, r.b?.label ?? "Other");
      last = id;
    }
  });
  return { ordered: [...head, ...rest.map((r) => r.item)], headers };
}
