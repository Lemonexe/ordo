import { emptyDb, withPlan } from "../domain/db.ts";
import type { Db } from "../domain/types.ts";

const collections = [
  ["workspace", "workspaces"],
  ["folder", "folders"],
  ["status", "statuses"],
  ["item", "items"],
  ["tag", "tags"],
  ["itemTag", "itemTags"],
  ["person", "people"],
  ["dependency", "dependencies"],
  ["itemLink", "itemLinks"],
  ["milestone", "milestones"],
  ["savedView", "savedViews"],
  ["rule", "rules"],
] as const;

type Kind = (typeof collections)[number][0];
type DbKey = (typeof collections)[number][1];

const keyOf = new Map<Kind, DbKey>(
  collections.map(([kind, key]) => [kind, key])
);

export type SyncRow = {
  kind: Kind;
  appId: string;
  payload: string;
  deleted: boolean;
};

function canonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonValue);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort())
    sorted[key] = canonValue(source[key]);
  return sorted;
}

export function canon(value: unknown): string {
  return JSON.stringify(canonValue(value));
}

export function rowsFromDb(db: Db): SyncRow[] {
  const rows: SyncRow[] = [];
  for (const [kind, key] of collections) {
    for (const entity of db[key]) {
      if (!entity || typeof entity.id !== "string") continue;
      rows.push({
        kind,
        appId: entity.id,
        payload: canon(entity),
        deleted: false,
      });
    }
  }
  return rows;
}

export function dbFromRows(rows: readonly SyncRow[]): Db | null {
  const db = emptyDb();
  for (const row of rows) {
    if (row.deleted) continue;
    const key = keyOf.get(row.kind);
    if (!key) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { id?: unknown }).id !== "string"
    )
      continue;
    (db[key] as unknown[]).push(parsed);
  }
  if (db.folders.length === 0 || db.workspaces.length === 0) return null;
  return collapseInboxes(withPlan(db));
}

export function fingerprint(db: Db): string {
  return rowsFromDb(db)
    .map((row) => `${row.kind}\n${row.appId}\n${row.payload}`)
    .sort()
    .join("\n");
}

export function isUntouched(db: Db): boolean {
  const folders = db.folders.filter((folder) => !folder.isDeleted);
  return (
    db.items.length === 0 &&
    db.tags.length === 0 &&
    db.people.length === 0 &&
    db.rules.length === 0 &&
    db.savedViews.length === 0 &&
    db.itemLinks.length === 0 &&
    db.milestones.length === 0 &&
    db.dependencies.length === 0 &&
    db.itemTags.length === 0 &&
    folders.length <= 1 &&
    folders.every((folder) => folder.system === "inbox")
  );
}

export function collapseInboxes(db: Db): Db {
  const inboxes = db.folders.filter(
    (folder) => !folder.isDeleted && folder.system === "inbox"
  );
  if (inboxes.length <= 1) return db;
  const itemsIn = (id: string) =>
    db.items.filter((item) => !item.isDeleted && item.folderId === id).length;
  const [keep, ...rest] = [...inboxes].sort((a, b) => {
    const byItems = itemsIn(b.id) - itemsIn(a.id);
    if (byItems !== 0) return byItems;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  if (!keep) return db;
  const drop = new Set(rest.map((folder) => folder.id));
  const keepStatuses = db.statuses.filter(
    (status) => status.folderId === keep.id && !status.isDeleted
  );
  const statusMap = new Map<string, string>();
  const statuses = db.statuses.map((status) => {
    if (status.isDeleted || !drop.has(status.folderId)) return status;
    const clash = keepStatuses.find(
      (candidate) => candidate.meaning === status.meaning
    );
    if (clash) {
      statusMap.set(status.id, clash.id);
      return { ...status, isDeleted: true };
    }
    statusMap.set(status.id, status.id);
    return { ...status, folderId: keep.id };
  });
  const mapStatus = (id: string | null) => (id ? statusMap.get(id) ?? id : id);
  return {
    ...db,
    folders: db.folders.map((folder) => {
      if (drop.has(folder.id)) return { ...folder, isDeleted: true };
      if (folder.parentId && drop.has(folder.parentId))
        return { ...folder, parentId: keep.id };
      return folder;
    }),
    statuses,
    items: db.items.map((item) => {
      if (!drop.has(item.folderId)) return item;
      return { ...item, folderId: keep.id, statusId: mapStatus(item.statusId) };
    }),
    rules: db.rules.map((rule) => {
      const actionFolderId = drop.has(rule.actionFolderId)
        ? keep.id
        : rule.actionFolderId;
      const actionStatusId = mapStatus(rule.actionStatusId);
      if (
        actionFolderId === rule.actionFolderId &&
        actionStatusId === rule.actionStatusId
      )
        return rule;
      return { ...rule, actionFolderId, actionStatusId };
    }),
    savedViews: db.savedViews.map((view) => {
      const folderId =
        view.folderId && drop.has(view.folderId) ? keep.id : view.folderId;
      const queryFolder =
        view.query.folderId && drop.has(view.query.folderId)
          ? keep.id
          : view.query.folderId;
      if (folderId === view.folderId && queryFolder === view.query.folderId)
        return view;
      return {
        ...view,
        folderId,
        query: { ...view.query, folderId: queryFolder },
      };
    }),
  };
}

export function mergeLatest(remote: Db, local: Db): Db {
  const merged = structuredClone(remote);
  for (const [, key] of collections) {
    const rows = merged[key] as Array<{ id: string; updatedAt: string }>;
    const byId = new Map(rows.map((entity) => [entity.id, entity]));
    for (const entity of local[key] as Array<{ id: string; updatedAt: string }>) {
      const current = byId.get(entity.id);
      if (!current || current.updatedAt < entity.updatedAt)
        byId.set(entity.id, structuredClone(entity));
    }
    (merged[key] as unknown[]) = [...byId.values()];
  }
  return merged;
}
