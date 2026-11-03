import { generateKeyBetween } from "fractional-indexing";
import { keyAtEnd } from "./ordering.ts";
import { storedAmount, storedSymbol } from "./dictate.ts";
import { normalizeFolderColor } from "./color.ts";
import { storedPlace } from "./place.ts";
import { paperIndex } from "./stickies.ts";
import type { Ctx, Db, Folder, Item, Status, StatusMeaning } from "./types.ts";

export function alive<T extends { isDeleted: boolean }>(rows: T[]): T[] {
  return rows.filter((row) => !row.isDeleted);
}

export function byId<T extends { id: string }>(
  rows: T[],
  id: string | null
): T | null {
  if (!id) return null;
  return rows.find((row) => row.id === id) ?? null;
}

export function workspaceId(db: Db): string {
  return alive(db.workspaces)[0]?.id ?? db.workspaces[0]?.id ?? "";
}

export function inboxFolder(db: Db): Folder | null {
  return alive(db.folders).find((folder) => folder.system === "inbox") ?? null;
}

export function statusesOf(db: Db, folderId: string): Status[] {
  return alive(db.statuses)
    .filter((status) => status.folderId === folderId)
    .sort((a, b) =>
      a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0
    );
}

export function resolvedOpen(db: Db, folder: Folder): Status | null {
  const statuses = statusesOf(db, folder.id);
  if (folder.openStatusId) {
    const chosen = statuses.find((status) => status.id === folder.openStatusId);
    if (chosen) return chosen;
  }
  return (
    statuses.find((status) => status.meaning === "todo") ?? statuses[0] ?? null
  );
}

export function resolvedClosed(db: Db, folder: Folder): Status | null {
  const statuses = statusesOf(db, folder.id);
  if (folder.closedStatusId) {
    const chosen = statuses.find(
      (status) => status.id === folder.closedStatusId
    );
    if (chosen) return chosen;
  }
  return statuses.find((status) => status.meaning === "done") ?? null;
}

export function statusMeaning(
  db: Db,
  statusId: string | null
): StatusMeaning | null {
  return byId(db.statuses, statusId)?.meaning ?? null;
}

export function isDoneStatus(db: Db, statusId: string | null): boolean {
  return statusMeaning(db, statusId) === "done";
}

export function isClosedOut(db: Db, statusId: string | null): boolean {
  const meaning = statusMeaning(db, statusId);
  return meaning === "done" || meaning === "cancelled";
}

export function wouldFolderCycle(
  db: Db,
  folderId: string,
  parentId: string | null
): boolean {
  let current = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === folderId || seen.has(current)) return true;
    seen.add(current);
    current = byId(db.folders, current)?.parentId ?? null;
  }
  return false;
}

export function descendantFolderIds(db: Db, rootId: string): string[] {
  const result: string[] = [];
  const walk = (id: string) => {
    for (const folder of alive(db.folders)) {
      if (folder.parentId === id) {
        result.push(folder.id);
        walk(folder.id);
      }
    }
  };
  walk(rootId);
  return result;
}

export function wouldDependencyCycle(
  db: Db,
  itemId: string,
  dependsOnId: string
): boolean {
  if (itemId === dependsOnId) return true;
  const edges = new Map<string, string[]>();
  for (const dependency of alive(db.dependencies)) {
    const next = edges.get(dependency.itemId) ?? [];
    next.push(dependency.dependsOnId);
    edges.set(dependency.itemId, next);
  }
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === itemId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of edges.get(current) ?? []) stack.push(next);
  }
  return false;
}

export function sortKeyForStatus(
  db: Db,
  folderId: string,
  statusId: string | null
): string {
  const keys = alive(db.items)
    .filter((item) => item.folderId === folderId && item.statusId === statusId)
    .map((item) => item.sortOrder);
  return keyAtEnd(keys);
}

export function emptyDb(): Db {
  return {
    version: 1,
    workspaces: [],
    folders: [],
    statuses: [],
    items: [],
    tags: [],
    itemTags: [],
    people: [],
    dependencies: [],
    itemLinks: [],
    milestones: [],
    savedViews: [],
    rules: [],
  };
}

export function bootstrap(ctx: Ctx): Db {
  const now = ctx.now;
  const workspace = ctx.id();
  const inbox = ctx.id();
  const todo = ctx.id();
  const doing = ctx.id();
  const done = ctx.id();
  const first = generateKeyBetween(null, null);
  const second = generateKeyBetween(first, null);
  const third = generateKeyBetween(second, null);
  const stamp = {
    createdAt: now,
    updatedAt: now,
    isDeleted: false,
    workspaceId: workspace,
  };
  return {
    ...emptyDb(),
    workspaces: [
      {
        id: workspace,
        name: "Osobní",
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      },
    ],
    folders: [
      {
        ...stamp,
        id: inbox,
        parentId: null,
        name: "Nezařazené",
        icon: null,
        color: null,
        keywords: null,
        sortOrder: first,
        system: "inbox",
        defaultView: "list",
        itemSort: null,
        openStatusId: null,
        closedStatusId: null,
        isArchived: false,
        hidden: false,
      },
    ],
    statuses: [
      {
        ...stamp,
        id: todo,
        folderId: inbox,
        name: "K udělání",
        meaning: "todo",
        sortOrder: first,
      },
      {
        ...stamp,
        id: doing,
        folderId: inbox,
        name: "Dělám",
        meaning: "doing",
        sortOrder: second,
      },
      {
        ...stamp,
        id: done,
        folderId: inbox,
        name: "Hotovo",
        meaning: "done",
        sortOrder: third,
      },
    ],
  };
}

export function seriesIdOf(item: Item): string {
  return item.seriesId ?? item.id;
}

function omitKeys<T extends object>(value: T, keys: readonly string[]): T {
  const next = { ...value } as Record<string, unknown>;
  for (const key of keys) delete next[key];
  return next as T;
}

export function withPlan(db: Db): Db {
  return {
    ...omitKeys(db, ["shoppingTemplates"]),
    folders: db.folders.map((folder) => ({
      ...folder,
      hidden: folder.hidden === true,
      itemSort:
        folder.itemSort === "priority" || folder.itemSort === "created"
          ? folder.itemSort
          : null,
    })),
    items: db.items.map((item) =>
      omitKeys({
        ...item,
        planUntil: item.planUntil ?? null,
        ganttOrder: typeof item.ganttOrder === "string" ? item.ganttOrder : null,
        color: normalizeFolderColor(item.color),
        place: storedPlace(item.place),
        origin: storedPlace(item.origin),
        spot: storedPlace(item.spot),
        amount: storedAmount(item.amount),
        variableSymbol: storedSymbol(item.variableSymbol),
        paper: paperIndex(item.paper),
      }, [
        "store",
        "quantity",
        "unit",
        "spec",
        "templateId",
      ])
    ),
    milestones: (Array.isArray(db.milestones) ? db.milestones : []).map(
      (row) => ({ ...row, color: normalizeFolderColor(row.color) })
    ),
    rules: db.rules.map((rule) => omitKeys(rule, ["actionStore"])),
    savedViews: db.savedViews.map((view) => ({
      ...view,
      query: omitKeys(view.query, ["store"]),
    })),
  };
}

export function isValidDb(value: unknown): value is Db {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Db>;
  return (
    record.version === 1 &&
    Array.isArray(record.workspaces) &&
    Array.isArray(record.folders) &&
    Array.isArray(record.statuses) &&
    Array.isArray(record.items) &&
    Array.isArray(record.tags) &&
    Array.isArray(record.itemTags) &&
    Array.isArray(record.people) &&
    Array.isArray(record.dependencies) &&
    Array.isArray(record.itemLinks) &&
    Array.isArray(record.savedViews) &&
    Array.isArray(record.rules)
  );
}
