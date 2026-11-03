import { addDays, dueDateKey, isoWeekday, parseDateKey } from "./dates.ts";
import { alive, byId } from "./db.ts";
import { planEnd } from "./horizon.ts";
import type { Op } from "./op.ts";
import { keyBetween } from "./ordering.ts";
import { childFolders } from "./select.ts";
import type { Db, Item, ItemPatch, Milestone } from "./types.ts";

// Every task is a bar. A plan spans from–to, a due date is one day. The
// domain keeps the two exclusive, so an item is never both. Milestones are
// separate dates, not tasks.
export type Span = { kind: "plan" | "due"; start: string; end: string };
export type SpanEdit = "move" | "start" | "end";

export function itemSpan(
  item: Pick<Item, "plannedFor" | "planUntil" | "dueAt">
): Span | null {
  if (item.plannedFor)
    return {
      kind: "plan",
      start: item.plannedFor,
      end: planEnd(item.plannedFor, item.planUntil),
    };
  const due = dueDateKey(item.dueAt);
  if (due) return { kind: "due", start: due, end: due };
  return null;
}

export function daysBetween(from: string, to: string): number {
  const a = parseDateKey(from);
  const b = parseDateKey(to);
  const utc = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

export function mondayOf(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

export function editSpan(span: Span, edit: SpanEdit, delta: number): Span {
  if (delta === 0) return span;
  if (edit === "move")
    return {
      ...span,
      start: addDays(span.start, delta),
      end: addDays(span.end, delta),
    };
  // Stretching a one-day due task turns it into a from–to plan.
  if (edit === "start") {
    const start = addDays(span.start, delta);
    const next = start > span.end ? span.end : start;
    if (span.kind === "due" && next === span.start) return span;
    return { kind: "plan", start: next, end: span.end };
  }
  const end = addDays(span.end, delta);
  const next = end < span.start ? span.start : end;
  if (span.kind === "due" && next === span.end) return span;
  return { kind: "plan", start: span.start, end: next };
}

export function spanPatch(item: Pick<Item, "dueAt">, span: Span): ItemPatch {
  if (span.kind === "plan")
    return {
      plannedFor: span.start,
      planUntil: span.end > span.start ? span.end : null,
    };
  const time = item.dueAt && item.dueAt.length > 10 ? item.dueAt.slice(10) : "";
  return { dueAt: `${span.start}${time}`, dueHasTime: time.length > 0 };
}

// The follower should not start before the item it waits on ends. Handing
// over on the same day is fine.
export function startsTooEarly(before: Span, after: Span): boolean {
  return after.start < before.end;
}

// Days to move the follower so it starts the day after the item it waits on.
export function catchUpDelta(before: Span, after: Span): number {
  return Math.max(0, daysBetween(after.start, addDays(before.end, 1)));
}

// Milestones for a view: those of the given folders plus the ones without a
// folder. `null` means every folder. Milestones of deleted folders stay hidden.
export function milestonesFor(
  db: Db,
  folderIds: ReadonlySet<string> | null
): Milestone[] {
  return alive(db.milestones)
    .filter((row) => {
      if (row.folderId === null) return true;
      const folder = byId(db.folders, row.folderId);
      if (!folder || folder.isDeleted || folder.isArchived) return false;
      return folderIds === null || folderIds.has(row.folderId);
    })
    .sort((left, right) =>
      left.day === right.day
        ? left.title.localeCompare(right.title, "cs")
        : left.day < right.day
        ? -1
        : 1
    );
}

// Everything that waits on the item, directly or through other items.
export function successors(db: Db, itemId: string): Item[] {
  const seen = new Set<string>([itemId]);
  const found: Item[] = [];
  const queue = [itemId];
  const rows = alive(db.dependencies);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const row of rows) {
      if (row.dependsOnId !== current || seen.has(row.itemId)) continue;
      seen.add(row.itemId);
      const item = byId(db.items, row.itemId);
      if (!item || item.isDeleted) continue;
      found.push(item);
      queue.push(item.id);
    }
  }
  return found;
}

export function shiftOps(items: Item[], delta: number): Op[] {
  if (delta === 0) return [];
  return items.flatMap((item) => {
    const span = itemSpan(item);
    if (!span) return [];
    return [
      {
        type: "updateItem" as const,
        id: item.id,
        patch: spanPatch(item, editSpan(span, "move", delta)),
      },
    ];
  });
}

export function ganttRange(
  spans: Span[],
  today: string
): { start: string; end: string } {
  let start = addDays(today, -14);
  let end = addDays(today, 70);
  for (const span of spans) {
    const before = addDays(span.start, -7);
    const after = addDays(span.end, 21);
    if (before < start) start = before;
    if (after > end) end = after;
  }
  return { start: mondayOf(start), end: addDays(mondayOf(end), 6) };
}

export function monthSegments(
  start: string,
  days: number
): Array<{ month: string; offset: number; length: number }> {
  const segments: Array<{ month: string; offset: number; length: number }> = [];
  for (let offset = 0; offset < days; offset += 1) {
    const month = addDays(start, offset).slice(0, 7);
    const last = segments.at(-1);
    if (last && last.month === month) last.length += 1;
    else segments.push({ month, offset, length: 1 });
  }
  return segments;
}

export type GanttRow =
  | { kind: "group"; key: string; folderId: string }
  | {
      kind: "item";
      key: string;
      item: Item;
      depth: number;
      // Parent row within the same group, for keeping siblings together.
      parentId: string | null;
      span: Span | null;
    }
  | { kind: "tray"; key: string; folderId: string; count: number; open: boolean }
  | { kind: "create"; key: string; folderId: string };

function folderRank(db: Db): Map<string, number> {
  const rank = new Map<string, number>();
  const walk = (parentId: string | null) => {
    for (const folder of childFolders(db, parentId)) {
      rank.set(folder.id, rank.size);
      walk(folder.id);
    }
  };
  walk(null);
  return rank;
}

type Rank = (id: string) => number | undefined;

// Manual order wins, then the order already on screen, then dates.
function bySpan(left: Item, right: Item, rank: Rank): number {
  const leftKey = left.ganttOrder ?? null;
  const rightKey = right.ganttOrder ?? null;
  if (leftKey && rightKey && leftKey !== rightKey)
    return leftKey < rightKey ? -1 : 1;
  if (leftKey && !rightKey) return -1;
  if (!leftKey && rightKey) return 1;
  const leftRank = rank(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = rank(right.id) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const a = itemSpan(left);
  const b = itemSpan(right);
  if (a && b) {
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    if (a.end !== b.end) return a.end < b.end ? -1 : 1;
  }
  return left.title.localeCompare(right.title, "cs");
}

function treeRows(items: Item[], rank: Rank): GanttRow[] {
  const order = (left: Item, right: Item) => bySpan(left, right, rank);
  const ids = new Set(items.map((item) => item.id));
  const children = new Map<string, Item[]>();
  const roots: Item[] = [];
  for (const item of items) {
    const parent = item.parentItemId;
    if (parent && ids.has(parent) && parent !== item.id)
      children.set(parent, [...(children.get(parent) ?? []), item]);
    else roots.push(item);
  }
  const rows: GanttRow[] = [];
  const seen = new Set<string>();
  const visit = (item: Item, depth: number, parentId: string | null) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    rows.push({
      kind: "item",
      key: `item:${item.id}`,
      item,
      depth,
      parentId,
      span: itemSpan(item),
    });
    for (const child of (children.get(item.id) ?? []).sort(order))
      visit(child, Math.min(depth + 1, 3), item.id);
  };
  for (const root of roots.sort(order)) visit(root, 0, null);
  for (const item of items) visit(item, 0, null);
  return rows;
}

export function ganttRows(
  db: Db,
  items: Item[],
  options: {
    isOpen: (item: Item) => boolean;
    trayOpen: (folderId: string) => boolean;
    fallbackFolderId: string | null;
    // Order already shown on screen. Rows keep it while dates change, so
    // a bar does not jump away from under the pointer.
    rank?: Rank;
    // Skip folders where nothing is scheduled yet.
    scheduledOnly?: boolean;
  }
): GanttRow[] {
  const rank = options.rank ?? (() => undefined);
  const byFolder = new Map<string, Item[]>();
  for (const item of items) {
    if (item.type !== "task" || item.isDeleted) continue;
    const scheduled = itemSpan(item) !== null;
    if (!scheduled && !options.isOpen(item)) continue;
    byFolder.set(item.folderId, [...(byFolder.get(item.folderId) ?? []), item]);
  }
  const folderOrder = folderRank(db);
  const folderIds = [...byFolder.keys()].sort(
    (left, right) =>
      (folderOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (folderOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
  const shownIds = options.scheduledOnly
    ? folderIds.filter((id) =>
        (byFolder.get(id) ?? []).some((item) => itemSpan(item) !== null)
      )
    : folderIds;
  const grouped = shownIds.length > 1;
  const rows: GanttRow[] = [];
  for (const folderId of shownIds) {
    const all = byFolder.get(folderId) ?? [];
    const scheduled = all.filter((item) => itemSpan(item) !== null);
    const loose = all
      .filter((item) => itemSpan(item) === null)
      .sort((left, right) =>
        left.sortOrder === right.sortOrder
          ? left.title.localeCompare(right.title, "cs")
          : left.sortOrder < right.sortOrder
          ? -1
          : 1
      );
    if (grouped) rows.push({ kind: "group", key: `group:${folderId}`, folderId });
    rows.push(...treeRows(scheduled, rank));
    if (loose.length > 0) {
      const open = options.trayOpen(folderId);
      rows.push({
        kind: "tray",
        key: `tray:${folderId}`,
        folderId,
        count: loose.length,
        open,
      });
      if (open)
        for (const item of loose)
          rows.push({
            kind: "item",
            key: `item:${item.id}`,
            item,
            depth: 0,
            parentId: null,
            span: null,
          });
    }
    rows.push({ kind: "create", key: `create:${folderId}`, folderId });
  }
  if (rows.length === 0 && options.fallbackFolderId)
    rows.push({
      kind: "create",
      key: `create:${options.fallbackFolderId}`,
      folderId: options.fallbackFolderId,
    });
  return rows;
}

// New manual order for one set of siblings: `movingId` goes before
// `beforeId`, or to the end. Every sibling gets a key so the order sticks.
export function reorderOps(
  siblingIds: string[],
  movingId: string,
  beforeId: string | null
): Op[] | null {
  if (!siblingIds.includes(movingId) || movingId === beforeId) return null;
  const next = siblingIds.filter((id) => id !== movingId);
  const index = beforeId ? next.indexOf(beforeId) : next.length;
  if (index < 0) return null;
  next.splice(index, 0, movingId);
  if (next.every((id, at) => id === siblingIds[at])) return null;
  let previous: string | null = null;
  return next.map((id) => {
    const ganttOrder = keyBetween(previous, null);
    previous = ganttOrder;
    return { type: "updateItem" as const, id, patch: { ganttOrder } };
  });
}
