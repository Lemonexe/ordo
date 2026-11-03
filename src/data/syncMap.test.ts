import { describe, expect, it } from "vitest";
import { freshDb } from "../domain/reduce.ts";
import {
  collapseInboxes,
  dbFromRows,
  fingerprint,
  isUntouched,
  mergeLatest,
  rowsFromDb,
} from "./syncMap.ts";

function ctx() {
  let n = 0;
  return {
    now: "2026-10-18T08:00:00.000Z",
    today: "2026-10-18",
    id: () => `id${n++}`,
  };
}

describe("synchronizace", () => {
  it("čerstvou databázi nepovažuje za data k odeslání", () => {
    expect(isUntouched(freshDb(ctx()))).toBe(true);
  });

  it("řádek se složí zpátky do stejných dat", () => {
    const db = freshDb(ctx());
    db.items.push({
      ...db.statuses[0]!,
      id: "task1",
      folderId: db.folders[0]!.id,
      type: "task",
      title: "Brát lék",
      body: null,
      statusId: db.statuses[0]!.id,
      priority: null,
      assigneeId: null,
      dueAt: "2026-10-17",
      dueHasTime: false,
      plannedFor: "2026-10-17",
      planUntil: null,
      place: null,
      origin: null,
      spot: null,
      amount: null,
      variableSymbol: null,
      parentItemId: null,
      seriesId: null,
      recurrenceFreq: null,
      recurrenceInterval: null,
      recurrenceWeekdays: null,
      recurrenceUntil: null,
      pristine: false,
      sortOrder: "a0",
      dayOrder: null,
      ganttOrder: null,
      color: null,
      pinX: null,
      pinY: null,
      pinZ: null,
      pinW: null,
      pinH: null,
      paper: null,
      isPinned: false,
      isArchived: false,
    });
    const back = dbFromRows(rowsFromDb(db));
    expect(back && fingerprint(back)).toBe(fingerprint(db));
  });

  it("složí druhé Nezařazené do staršího a přenese jeho úkol", () => {
    const db = freshDb(ctx());
    const keep = db.folders[0]!;
    const todo = db.statuses[0]!;
    db.folders.push({
      ...keep,
      id: "inbox2",
      createdAt: "2026-10-18T09:00:00.000Z",
    });
    db.statuses.push({ ...todo, id: "todo2", folderId: "inbox2" });
    db.items.push({
      ...todo,
      id: "task1",
      folderId: keep.id,
      type: "task",
      title: "původní",
      body: null,
      statusId: todo.id,
      priority: null,
      assigneeId: null,
      dueAt: null,
      dueHasTime: false,
      plannedFor: null,
      planUntil: null,
      place: null,
      origin: null,
      spot: null,
      amount: null,
      variableSymbol: null,
      parentItemId: null,
      seriesId: null,
      recurrenceFreq: null,
      recurrenceInterval: null,
      recurrenceWeekdays: null,
      recurrenceUntil: null,
      pristine: false,
      sortOrder: "a0",
      dayOrder: null,
      ganttOrder: null,
      color: null,
      pinX: null,
      pinY: null,
      pinZ: null,
      pinW: null,
      pinH: null,
      paper: null,
      isPinned: false,
      isArchived: false,
    });
    db.items.push({
      ...todo,
      id: "task2",
      folderId: "inbox2",
      type: "task",
      title: "ze druhého telefonu",
      body: null,
      statusId: "todo2",
      priority: null,
      assigneeId: null,
      dueAt: null,
      dueHasTime: false,
      plannedFor: null,
      planUntil: null,
      place: null,
      origin: null,
      spot: null,
      amount: null,
      variableSymbol: null,
      parentItemId: null,
      seriesId: null,
      recurrenceFreq: null,
      recurrenceInterval: null,
      recurrenceWeekdays: null,
      recurrenceUntil: null,
      pristine: false,
      sortOrder: "a0",
      dayOrder: null,
      ganttOrder: null,
      color: null,
      pinX: null,
      pinY: null,
      pinZ: null,
      pinW: null,
      pinH: null,
      paper: null,
      isPinned: false,
      isArchived: false,
    });
    const collapsed = collapseInboxes(db);
    expect(
      collapsed.folders
        .filter((folder) => !folder.isDeleted && folder.system === "inbox")
        .map((folder) => folder.id)
    ).toEqual([keep.id]);
    expect(collapsed.items.find((item) => item.id === "task2")).toMatchObject({
      folderId: keep.id,
      statusId: todo.id,
    });
    expect(
      collapsed.folders.find((folder) => folder.id === "inbox2")?.isDeleted
    ).toBe(true);
  });

  it("při spojení vyhraje novější úprava a nový úkol zůstane", () => {
    const remote = freshDb(ctx());
    const local = structuredClone(remote);
    const folder = local.folders[0]!;
    folder.name = "Přejmenováno";
    folder.updatedAt = "2026-10-18T12:00:00.000Z";
    const created = structuredClone(remote.folders[0]!);
    created.id = "dalsi";
    created.name = "Z offline";
    created.system = null;
    local.folders.push(created);
    const remoteOnly = structuredClone(remote.statuses[0]!);
    remoteOnly.id = "stav-remote";
    remote.statuses.push(remoteOnly);

    const merged = mergeLatest(remote, local);
    expect(merged.folders.find((entry) => entry.id === folder.id)?.name).toBe(
      "Přejmenováno"
    );
    expect(merged.folders.some((entry) => entry.id === "dalsi")).toBe(true);
    expect(merged.statuses.some((entry) => entry.id === "stav-remote")).toBe(
      true
    );

    const older = structuredClone(local);
    older.folders[0]!.name = "Stará";
    older.folders[0]!.updatedAt = "2026-10-18T07:00:00.000Z";
    expect(
      mergeLatest(remote, older).folders.find((entry) => entry.id === folder.id)
        ?.name
    ).toBe(remote.folders[0]!.name);
  });
});
