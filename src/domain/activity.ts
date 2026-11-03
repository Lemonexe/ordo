import { byId, statusMeaning } from "./db.ts";
import { priorityLabel } from "./labels.ts";
import { paperLabel } from "./stickies.ts";
import { dueDateKey, formatDay } from "./dates.ts";
import type { Op } from "./op.ts";
import { reduce } from "./reduce.ts";
import type { Ctx, Db, Item } from "./types.ts";

export type ActivityTarget =
  | { kind: "item"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "person"; id: string };

export type ActivityEntry = {
  id: string;
  at: string;
  text: string;
  target: ActivityTarget | null;
};

const limit = 100;

export function recordActivity(before: Db, op: Op, ctx: Ctx): ActivityEntry[] {
  return walk(before, op, ctx).slice(0, limit);
}

export function readActivity(value: unknown): ActivityEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ActivityEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Partial<ActivityEntry>;
    if (typeof entry.id !== "string" || typeof entry.at !== "string" || typeof entry.text !== "string")
      continue;
    const target = readTarget(entry.target);
    if (target === undefined) continue;
    entries.push({ id: entry.id, at: entry.at, text: entry.text, target });
    if (entries.length >= limit) break;
  }
  return entries;
}

function readTarget(value: unknown): ActivityTarget | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const target = value as Partial<ActivityTarget>;
  if (typeof target.id !== "string") return undefined;
  if (target.kind === "item" || target.kind === "folder" || target.kind === "person")
    return { kind: target.kind, id: target.id };
  return undefined;
}

function walk(before: Db, op: Op, ctx: Ctx): ActivityEntry[] {
  if (op.type === "batch") {
    let db = before;
    const out: ActivityEntry[] = [];
    for (const child of op.ops) {
      const next = reduce(db, child, ctx);
      if (next !== db) {
        if (child.type === "batch") out.push(...walk(db, child, ctx));
        else {
          const one = describe(db, child, next, ctx);
          if (one) out.push(one);
        }
      }
      db = next;
    }
    return dedupe(out);
  }
  const after = reduce(before, op, ctx);
  if (after === before) return [];
  const one = describe(before, op, after, ctx);
  return one ? [one] : [];
}

function dedupe(entries: ActivityEntry[]): ActivityEntry[] {
  const seen = new Set<string>();
  const out: ActivityEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.text}\0${entry.target?.kind ?? ""}\0${entry.target?.id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function describe(before: Db, op: Op, after: Db, ctx: Ctx): ActivityEntry | null {
  switch (op.type) {
    case "batch":
    case "sortInbox":
    case "replaceDb":
    case "reorderStatuses":
    case "reorderRules":
      return null;
    case "createItem": {
      const item = byId(after.items, op.item.id);
      if (!item) return null;
      const noun = item.type === "note" ? "Nová poznámka" : "Nový úkol";
      const folder = byId(after.folders, item.folderId);
      const text =
        item.folderId !== op.item.folderId && folder
          ? `${noun} ${quoted(item.title)} ve složce ${folder.name}`
          : `${noun} ${quoted(item.title)}`;
      return entry(text, { kind: "item", id: item.id }, ctx);
    }
    case "updateItem":
    case "placeItem": {
      const previous = byId(before.items, op.id);
      const item = byId(after.items, op.id);
      if (!previous || !item) return null;
      return itemEdit(previous, item, after, ctx);
    }
    case "deleteItem": {
      const item = byId(before.items, op.id);
      if (!item) return null;
      const noun = item.type === "note" ? "Smazaná poznámka" : "Smazaný úkol";
      return entry(`${noun} ${quoted(item.title)}`, { kind: "item", id: item.id }, ctx);
    }
    case "restoreItem": {
      const item = byId(after.items, op.id);
      if (!item) return null;
      const noun = item.type === "note" ? "Obnovená poznámka" : "Obnovený úkol";
      return entry(`${noun} ${quoted(item.title)}`, { kind: "item", id: item.id }, ctx);
    }
    case "purgeItem": {
      const item = byId(before.items, op.id);
      if (!item) return null;
      return entry(`Natrvalo smazáno ${quoted(item.title)}`, null, ctx);
    }
    case "createFolder": {
      const folder = byId(after.folders, op.id);
      if (!folder) return null;
      return entry(`Nová složka ${quoted(folder.name)}`, { kind: "folder", id: folder.id }, ctx);
    }
    case "updateFolder": {
      const previous = byId(before.folders, op.id);
      const folder = byId(after.folders, op.id);
      if (!previous || !folder) return null;
      const keys = Object.keys(op.patch).filter((key) => key !== "defaultView" && key !== "itemSort");
      if (keys.length === 0) return null;
      if (previous.name !== folder.name)
        return entry(
          `Složka ${quoted(previous.name)} se jmenuje ${quoted(folder.name)}`,
          { kind: "folder", id: folder.id },
          ctx
        );
      return entry(`Upravená složka ${quoted(folder.name)}`, { kind: "folder", id: folder.id }, ctx);
    }
    case "moveFolder": {
      const previous = byId(before.folders, op.id);
      const folder = byId(after.folders, op.id);
      if (!previous || !folder || previous.parentId === folder.parentId) return null;
      const parent = folder.parentId ? byId(after.folders, folder.parentId) : null;
      const text = parent
        ? `Složka ${quoted(folder.name)} je ve složce ${parent.name}`
        : `Složka ${quoted(folder.name)} je na nejvyšší úrovni`;
      return entry(text, { kind: "folder", id: folder.id }, ctx);
    }
    case "deleteFolder": {
      const folder = byId(before.folders, op.id);
      if (!folder) return null;
      return entry(`Smazaná složka ${quoted(folder.name)}`, { kind: "folder", id: folder.id }, ctx);
    }
    case "restoreFolder": {
      const folder = byId(after.folders, op.id);
      if (!folder) return null;
      return entry(`Obnovená složka ${quoted(folder.name)}`, { kind: "folder", id: folder.id }, ctx);
    }
    case "purgeFolder": {
      const folder = byId(before.folders, op.id);
      if (!folder) return null;
      return entry(`Natrvalo smazaná složka ${quoted(folder.name)}`, null, ctx);
    }
    case "createPerson": {
      const person = byId(after.people, op.id);
      if (!person) return null;
      return entry(`Nový člověk ${quoted(person.name)}`, { kind: "person", id: person.id }, ctx);
    }
    case "updatePerson": {
      const previous = byId(before.people, op.id);
      const person = byId(after.people, op.id);
      if (!previous || !person) return null;
      const text =
        previous.name !== person.name
          ? `Člověk ${quoted(previous.name)} se jmenuje ${quoted(person.name)}`
          : `Upravený člověk ${quoted(person.name)}`;
      return entry(text, { kind: "person", id: person.id }, ctx);
    }
    case "deletePerson": {
      const person = byId(before.people, op.id);
      if (!person) return null;
      return entry(`Smazaný člověk ${quoted(person.name)}`, null, ctx);
    }
    case "setItemTags": {
      const item = byId(after.items, op.itemId);
      if (!item) return null;
      return entry(`Štítky u ${quoted(item.title)}`, { kind: "item", id: item.id }, ctx);
    }
    case "setRecurrence": {
      const item = byId(after.items, op.itemId);
      if (!item) return null;
      return entry(`Opakování úkolu ${quoted(item.title)}`, { kind: "item", id: item.id }, ctx);
    }
    case "emptyTrash":
      return entry("Koš je prázdný", null, ctx);
    default:
      return null;
  }
}

const watched = [
  "title",
  "body",
  "priority",
  "paper",
  "color",
  "dueAt",
  "dueHasTime",
  "plannedFor",
  "planUntil",
  "place",
  "origin",
  "spot",
  "amount",
  "variableSymbol",
  "assigneeId",
  "parentItemId",
  "isPinned",
  "isArchived",
  "type",
  "folderId",
  "statusId",
] as const;

function itemEdit(previous: Item, item: Item, db: Db, ctx: Ctx): ActivityEntry | null {
  const keys = watched.filter((key) => {
    if (key === "paper") return (previous.paper ?? null) !== (item.paper ?? null);
    return previous[key] !== item[key];
  });
  if (keys.length === 0) return null;
  const target: ActivityTarget = { kind: "item", id: item.id };
  if (keys.includes("folderId"))
    return entry(movedSentence(item, db), target, ctx);
  if (keys.length === 1 && keys[0] === "statusId")
    return entry(statusSentence(previous, item, db), target, ctx);
  if (keys.length === 1 && keys[0] === "title")
    return entry(`${noun(item)} se jmenuje ${quoted(item.title)}`, target, ctx);
  if (keys.length === 1 && keys[0] === "body")
    return entry(edited(item), target, ctx);
  if (keys.length === 1 && keys[0] === "priority")
    return entry(`Priorita ${quoted(item.title)} je ${priorityLabel(item.priority)}`, target, ctx);
  if (keys.length === 1 && keys[0] === "color")
    return entry(`Úkol ${quoted(item.title)} má jinou barvu`, target, ctx);
  if (keys.length === 1 && keys[0] === "paper")
    return entry(`Barva ${quoted(item.title)} je ${paperLabel(item.paper)}`, target, ctx);
  if (keys.every((key) => key === "dueAt" || key === "dueHasTime"))
    return entry(dueSentence(item, ctx.today), target, ctx);
  if (keys.every((key) => key === "plannedFor" || key === "planUntil"))
    return entry(`Plán ${quoted(item.title)} je upravený`, target, ctx);
  return entry(edited(item), target, ctx);
}

function movedSentence(item: Item, db: Db): string {
  const folder = byId(db.folders, item.folderId);
  const name = noun(item);
  return folder
    ? `${name} ${quoted(item.title)} je ve složce ${folder.name}`
    : `${name} ${quoted(item.title)} je jinde`;
}

function statusSentence(previous: Item, item: Item, db: Db): string {
  const meaning = statusMeaning(db, item.statusId);
  const was = statusMeaning(db, previous.statusId);
  const name = noun(item);
  if (meaning === "done" && was !== "done")
    return item.type === "note"
      ? `Poznámka ${quoted(item.title)} je hotová`
      : `Úkol ${quoted(item.title)} je hotový`;
  if (was === "done" && meaning !== "done" && meaning !== "cancelled")
    return item.type === "note"
      ? `Poznámka ${quoted(item.title)} je znovu otevřená`
      : `Úkol ${quoted(item.title)} je znovu otevřený`;
  if (meaning === "cancelled")
    return item.type === "note"
      ? `Poznámka ${quoted(item.title)} je zrušená`
      : `Úkol ${quoted(item.title)} je zrušený`;
  const status = byId(db.statuses, item.statusId);
  return status
    ? `${name} ${quoted(item.title)} je ve stavu ${status.name}`
    : edited(item);
}

function dueSentence(item: Item, today: string): string {
  const day = dueDateKey(item.dueAt);
  if (!day) return `${quoted(item.title)} už nemá termín`;
  return `Termín ${quoted(item.title)} je ${formatDay(day, today)}`;
}

function edited(item: Item): string {
  return item.type === "note"
    ? `Upravená poznámka ${quoted(item.title)}`
    : `Upravený úkol ${quoted(item.title)}`;
}

function noun(item: Item): string {
  return item.type === "note" ? "Poznámka" : "Úkol";
}

function quoted(value: string | null | undefined): string {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  const shown = text ? text.slice(0, 80) : "Bez názvu";
  return `„${shown}“`;
}

function entry(text: string, target: ActivityTarget | null, ctx: Ctx): ActivityEntry {
  return { id: ctx.id(), at: ctx.now, text, target };
}
