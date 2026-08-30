// FORK 2026-08-19 (the architect: "I still would like to move cron collapsed cards
// around, and similarly as with the tasks, I would like to filter them and be
// able to classify them in groups and subgroups").
//
// THE ROOM, NOT THE FINDINGS. Card order already lives in ui-state
// (`cron:cardOrder`) because no cron ever reads how the architect arranged the cards.
// Groups, membership and the filter chip are the same kind of fact — a layout
// of the Crons tab, not something a nightly run compounds onto — so they ride
// the same choices tier rather than growing a second store or borrowing the
// task-axis tree (Ventures / Family / … is a life taxonomy; cron groups are
// "night jobs" / "security" / whatever he names).
//
// Two-level cap, Unsorted remainder, listed-ids-first order: the same three
// rules the Today tab already taught the hand. This module is the pure half
// so those rules have tests; app.ts only paints and writes.

export const CRON_TAXONOMY_KEY = "cron:taxonomy";
export const CRON_FILTER_KEY = "cron:filter";
export const CRON_UNSORTED_ID = "__unsorted__";
export const CRON_FILTER_DEFAULT: CronFilter = "all";

export type CronFilter = "all" | "unread" | "acked" | "flags" | "failed" | "disabled" | "clear";

export const CRON_FILTERS: ReadonlyArray<{ key: CronFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "acked", label: "Acknowledged" },
  { key: "flags", label: "Flags" },
  { key: "failed", label: "Failed" },
  { key: "disabled", label: "Disabled" },
  { key: "clear", label: "Clear" },
];

export type CronTaxonomyGroup = {
  id: string;
  label: string;
  position: number;
  parentId: string | null;
};

export type CronTaxonomy = {
  groups: CronTaxonomyGroup[];
  /** jobId → groupId. Absent / unknown groupId = Unsorted. */
  membership: Record<string, string>;
};

export const EMPTY_CRON_TAXONOMY: CronTaxonomy = { groups: [], membership: {} };

export type CronFilterView = {
  enabled: boolean;
  silent: boolean;
  failed: boolean;
  unreadCount: number;
  ackedCount: number;
  flagCount: number;
  openCount: number;
};

export type CronGroupNode = CronTaxonomyGroup & { children: CronGroupNode[] };

const MAX_LABEL = 32;
const MAX_ID = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGroup(value: unknown): value is CronTaxonomyGroup {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.trim() === "") return false;
  if (value.id === CRON_UNSORTED_ID) return false;
  if (typeof value.label !== "string" || value.label.trim() === "") return false;
  if (typeof value.position !== "number" || !Number.isFinite(value.position)) return false;
  if (value.parentId !== null && typeof value.parentId !== "string") return false;
  if (value.parentId === CRON_UNSORTED_ID) return false;
  return true;
}

/** Corrupt or hand-edited JSON degrades to empty — the tab still paints. */
export function parseCronTaxonomy(raw: string): CronTaxonomy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { groups: [], membership: {} };
  }
  if (!isRecord(parsed)) return { groups: [], membership: {} };
  const groupsIn = Array.isArray(parsed.groups) ? parsed.groups : [];
  const seen = new Set<string>();
  const groups: CronTaxonomyGroup[] = [];
  for (const entry of groupsIn) {
    if (!isGroup(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    groups.push({
      id: entry.id,
      label: entry.label.trim().slice(0, MAX_LABEL),
      position: entry.position,
      parentId: entry.parentId && entry.parentId.trim() !== "" ? entry.parentId : null,
    });
  }
  const known = new Set(groups.map((g) => g.id));
  // A child whose parent vanished becomes a top-level group rather than
  // disappearing — the architect named it, the name stays.
  for (const group of groups) {
    if (group.parentId && !known.has(group.parentId)) group.parentId = null;
  }
  const membership: Record<string, string> = {};
  if (isRecord(parsed.membership)) {
    for (const [jobId, groupId] of Object.entries(parsed.membership)) {
      if (typeof jobId !== "string" || jobId.trim() === "") continue;
      if (typeof groupId !== "string" || !known.has(groupId)) continue;
      membership[jobId] = groupId;
    }
  }
  return { groups, membership };
}

export function serializeCronTaxonomy(tax: CronTaxonomy): string {
  return JSON.stringify({ groups: tax.groups, membership: tax.membership });
}

export function cronGroupFoldKey(groupId: string): string {
  return `cron:group:${groupId}`;
}

export function slugCronGroupId(label: string, parentId: string | null): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID);
  if (!base) return "";
  return parentId ? `${parentId}-${base}`.slice(0, MAX_ID * 2) : base;
}

export function cronFilterAccepts(view: CronFilterView, filter: CronFilter): boolean {
  switch (filter) {
    case "unread":
      return view.unreadCount > 0;
    case "acked":
      return view.ackedCount > 0;
    case "flags":
      return view.flagCount > 0;
    case "failed":
      return view.failed || view.silent;
    case "disabled":
      return !view.enabled;
    case "clear":
      return view.enabled && !view.failed && !view.silent && view.openCount === 0;
    case "all":
    default:
      return true;
  }
}

export function parseCronFilter(raw: string | null | undefined): CronFilter {
  if (raw && CRON_FILTERS.some((f) => f.key === raw)) return raw as CronFilter;
  return CRON_FILTER_DEFAULT;
}

export function buildCronGroupTree(groups: CronTaxonomyGroup[]): CronGroupNode[] {
  const byId = new Map<string, CronGroupNode>();
  for (const group of groups) byId.set(group.id, { ...group, children: [] });
  const roots: CronGroupNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const byPos = (a: CronGroupNode, b: CronGroupNode) =>
    a.position - b.position || a.id.localeCompare(b.id);
  roots.sort(byPos);
  for (const root of roots) root.children.sort(byPos);
  return roots;
}

export function groupIdForJob(tax: CronTaxonomy, jobId: string): string {
  const groupId = tax.membership[jobId];
  if (!groupId) return CRON_UNSORTED_ID;
  return tax.groups.some((g) => g.id === groupId) ? groupId : CRON_UNSORTED_ID;
}

export function jobsInGroup<T>(
  tax: CronTaxonomy,
  groupId: string,
  jobs: T[],
  idOf: (job: T) => string,
): T[] {
  return jobs.filter((job) => groupIdForJob(tax, idOf(job)) === groupId);
}

/**
 * Rewrite `cardOrder` so `newMemberOrder` is the relative order of this
 * group's members, without disturbing how other groups sit relative to each
 * other. Members not mentioned in `newMemberOrder` keep their previous
 * relative place at the end of the group.
 */
export function spliceGroupOrder(
  cardOrder: string[],
  memberIds: string[],
  newMemberOrder: string[],
): string[] {
  const members = new Set(memberIds);
  const next = newMemberOrder.filter((id) => members.has(id));
  const seen = new Set(next);
  for (const id of memberIds) {
    if (!seen.has(id)) {
      next.push(id);
      seen.add(id);
    }
  }
  let i = 0;
  const rewritten = cardOrder.map((id) => {
    if (!members.has(id)) return id;
    const replacement = next[i] ?? id;
    i += 1;
    return replacement;
  });
  // A job just assigned into this group has no old slot here — append
  // whatever the new order still has left, or it vanishes from the list.
  return i < next.length ? [...rewritten, ...next.slice(i)] : rewritten;
}

/**
 * Persist the order of cards that are ON SCREEN without evicting the ones a
 * collapsed group or an active filter has taken out of the DOM.
 * Hidden ids keep their stored slots; the visible sequence replaces the
 * previous visible subsequence in one block (new ids included).
 */
export function mergeVisibleOrder(stored: string[], visible: string[]): string[] {
  if (stored.length === 0) return visible.slice();
  const vis = new Set(visible);
  const out: string[] = [];
  let emittedVisible = false;
  for (const id of stored) {
    if (vis.has(id)) {
      if (!emittedVisible) {
        out.push(...visible);
        emittedVisible = true;
      }
    } else {
      out.push(id);
    }
  }
  if (!emittedVisible) out.push(...visible);
  return out;
}

export function assignJob(tax: CronTaxonomy, jobId: string, groupId: string): CronTaxonomy {
  const membership = { ...tax.membership };
  if (groupId === CRON_UNSORTED_ID || !tax.groups.some((g) => g.id === groupId)) {
    delete membership[jobId];
  } else {
    membership[jobId] = groupId;
  }
  return { groups: tax.groups, membership };
}

function nextPosition(tax: CronTaxonomy, parentId: string | null): number {
  const siblings = tax.groups.filter((g) => g.parentId === parentId);
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((g) => g.position)) + 1;
}

export function canNestUnder(tax: CronTaxonomy, parentId: string | null): boolean {
  if (parentId === null) return true;
  const parent = tax.groups.find((g) => g.id === parentId);
  if (!parent) return false;
  // Two-level cap: a sub-group cannot grow children.
  return parent.parentId === null;
}

export function addCronGroup(
  tax: CronTaxonomy,
  label: string,
  parentId: string | null,
): { ok: true; tax: CronTaxonomy; group: CronTaxonomyGroup } | { ok: false; reason: string } {
  const trimmed = label.trim().slice(0, MAX_LABEL);
  if (!trimmed) return { ok: false, reason: "empty" };
  if (!canNestUnder(tax, parentId)) return { ok: false, reason: "too-deep" };
  let id = slugCronGroupId(trimmed, parentId);
  if (!id) return { ok: false, reason: "empty" };
  if (id === CRON_UNSORTED_ID || tax.groups.some((g) => g.id === id)) {
    let n = 2;
    while (tax.groups.some((g) => g.id === `${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  const group: CronTaxonomyGroup = {
    id,
    label: trimmed,
    position: nextPosition(tax, parentId),
    parentId,
  };
  return { ok: true, tax: { groups: [...tax.groups, group], membership: tax.membership }, group };
}

export function renameCronGroup(tax: CronTaxonomy, id: string, label: string): CronTaxonomy {
  const trimmed = label.trim().slice(0, MAX_LABEL);
  if (!trimmed) return tax;
  return {
    groups: tax.groups.map((g) => (g.id === id ? { ...g, label: trimmed } : g)),
    membership: tax.membership,
  };
}

/** Empty groups only. Assigned jobs go back to Unsorted; children block the delete. */
export function deleteCronGroup(tax: CronTaxonomy, id: string): CronTaxonomy | null {
  if (tax.groups.some((g) => g.parentId === id)) return null;
  const groups = tax.groups.filter((g) => g.id !== id);
  if (groups.length === tax.groups.length) return null;
  const membership = { ...tax.membership };
  for (const [jobId, groupId] of Object.entries(membership)) {
    if (groupId === id) delete membership[jobId];
  }
  return { groups, membership };
}

export function reorderCronGroups(
  tax: CronTaxonomy,
  parentId: string | null,
  orderedIds: string[],
): CronTaxonomy {
  const wanted = new Set(tax.groups.filter((g) => g.parentId === parentId).map((g) => g.id));
  const next = orderedIds.filter((id) => wanted.has(id));
  for (const id of wanted) if (!next.includes(id)) next.push(id);
  const rank = new Map(next.map((id, i) => [id, i]));
  return {
    groups: tax.groups.map((g) =>
      g.parentId === parentId && rank.has(g.id) ? { ...g, position: rank.get(g.id)! } : g,
    ),
    membership: tax.membership,
  };
}

export function reparentCronGroup(
  tax: CronTaxonomy,
  id: string,
  parentId: string | null,
  orderedSiblingIds: string[],
): CronTaxonomy | null {
  const group = tax.groups.find((g) => g.id === id);
  if (!group) return null;
  if (id === parentId) return null;
  if (parentId !== null) {
    const parent = tax.groups.find((g) => g.id === parentId);
    if (!parent || parent.parentId !== null) return null;
    // A top-level group that already has children cannot become a sub-group
    // — that would be three levels.
    if (tax.groups.some((g) => g.parentId === id)) return null;
  }
  const moved: CronTaxonomy = {
    groups: tax.groups.map((g) => (g.id === id ? { ...g, parentId } : g)),
    membership: tax.membership,
  };
  return reorderCronGroups(moved, parentId, orderedSiblingIds);
}
