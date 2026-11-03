import { describe, expect, it } from "vitest";
import { inboxFolder } from "./db.ts";
import { newItem } from "./factory.ts";
import {
  catchUpDelta,
  daysBetween,
  editSpan,
  ganttRange,
  ganttRows,
  itemSpan,
  milestonesFor,
  monthSegments,
  reorderOps,
  shiftOps,
  spanPatch,
  startsTooEarly,
  successors,
} from "./gantt.ts";
import { freshDb, reduce } from "./reduce.ts";
import type { Ctx, Db, Item } from "./types.ts";

function ctx(): Ctx {
  let count = 0;
  return {
    now: "2026-11-03T08:00:00.000Z",
    today: "2026-11-03",
    id: () => {
      count += 1;
      return `n${count}`;
    },
  };
}

function seed(
  items: Array<Partial<Parameters<typeof newItem>[0]> & { id: string }>
): Db {
  const base = ctx();
  let db = freshDb(base);
  const inbox = inboxFolder(db);
  if (!inbox) throw new Error("inbox");
  for (const item of items)
    db = reduce(
      db,
      {
        type: "createItem",
        item: newItem({
          title: item.id,
          folderId: inbox.id,
          applyRules: false,
          ...item,
        }),
      },
      base
    );
  return db;
}

const span = (item: Partial<Item>) =>
  itemSpan({ plannedFor: null, planUntil: null, dueAt: null, ...item });

describe("gantt: pruhy a milníky", () => {
  it("plán je pruh, termín je milník, nic je nic", () => {
    expect(span({ plannedFor: "2026-11-03", planUntil: "2026-11-06" })).toEqual({
      kind: "plan",
      start: "2026-11-03",
      end: "2026-11-06",
    });
    expect(span({ plannedFor: "2026-11-03" })).toEqual({
      kind: "plan",
      start: "2026-11-03",
      end: "2026-11-03",
    });
    expect(span({ dueAt: "2026-11-05T14:00" })).toEqual({
      kind: "due",
      start: "2026-11-05",
      end: "2026-11-05",
    });
    expect(span({})).toBeNull();
  });

  it("počítá dny přes změnu času", () => {
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-11-10", "2026-11-03")).toBe(-7);
  });

  it("posune pruh, natáhne konec a nepřetočí začátek za konec", () => {
    const bar = { kind: "plan" as const, start: "2026-11-03", end: "2026-11-05" };
    expect(editSpan(bar, "move", 2)).toEqual({ ...bar, start: "2026-11-05", end: "2026-11-07" });
    expect(editSpan(bar, "end", 3).end).toBe("2026-11-08");
    expect(editSpan(bar, "start", 9)).toEqual({ ...bar, start: "2026-11-05" });
    expect(editSpan(bar, "end", -9)).toEqual({ ...bar, end: "2026-11-03" });
  });

  it("úkol s termínem se posune i s časem, natažením z něj je plán od–do", () => {
    const due = { kind: "due" as const, start: "2026-11-05", end: "2026-11-05" };
    expect(editSpan(due, "end", 2)).toEqual({
      kind: "plan",
      start: "2026-11-05",
      end: "2026-11-07",
    });
    expect(editSpan(due, "start", -1)).toEqual({
      kind: "plan",
      start: "2026-11-04",
      end: "2026-11-05",
    });
    expect(editSpan(due, "start", 3)).toBe(due);
    const moved = editSpan(due, "move", 1);
    expect(moved.start).toBe("2026-11-06");
    expect(spanPatch({ dueAt: "2026-11-05T14:00" }, moved)).toEqual({
      dueAt: "2026-11-06T14:00",
      dueHasTime: true,
    });
    expect(spanPatch({ dueAt: null }, moved)).toEqual({
      dueAt: "2026-11-06",
      dueHasTime: false,
    });
  });

  it("jednodenní plán ukládá bez konce", () => {
    expect(
      spanPatch({ dueAt: null }, { kind: "plan", start: "2026-11-03", end: "2026-11-03" })
    ).toEqual({ plannedFor: "2026-11-03", planUntil: null });
  });
});

describe("gantt: osa", () => {
  it("začíná v pondělí, končí v neděli a pojme všechny pruhy", () => {
    const range = ganttRange(
      [{ kind: "plan", start: "2027-03-01", end: "2027-03-20" }],
      "2026-11-03"
    );
    expect(range.start).toBe("2026-10-19");
    expect(range.end >= "2027-04-10").toBe(true);
    expect(new Date(`${range.end}T00:00:00`).getDay()).toBe(0);
  });

  it("rozdělí dny na měsíce", () => {
    expect(monthSegments("2026-10-30", 4)).toEqual([
      { month: "2026-10", offset: 0, length: 2 },
      { month: "2026-11", offset: 2, length: 2 },
    ]);
  });
});

describe("gantt: závislosti", () => {
  it("najde navazující úkoly přes víc kroků a posune je", () => {
    let db = seed([
      { id: "a", plannedFor: "2026-11-03", planUntil: "2026-11-04" },
      { id: "b", plannedFor: "2026-11-05" },
      { id: "c", dueAt: "2026-11-09" },
      { id: "d" },
    ]);
    const base = ctx();
    db = reduce(db, { type: "addDependency", id: "d1", itemId: "b", dependsOnId: "a" }, base);
    db = reduce(db, { type: "addDependency", id: "d2", itemId: "c", dependsOnId: "b" }, base);
    db = reduce(db, { type: "addDependency", id: "d3", itemId: "d", dependsOnId: "c" }, base);
    const after = successors(db, "a");
    expect(after.map((item) => item.id)).toEqual(["b", "c", "d"]);
    expect(shiftOps(after, 2)).toEqual([
      { type: "updateItem", id: "b", patch: { plannedFor: "2026-11-07", planUntil: null } },
      { type: "updateItem", id: "c", patch: { dueAt: "2026-11-11", dueHasTime: false } },
    ]);
  });
});

describe("gantt: kolize vazeb", () => {
  const plan = (start: string, end = start) => ({ kind: "plan" as const, start, end });
  const due = (day: string) => ({ kind: "due" as const, start: day, end: day });

  it("hlídá jen start před koncem, předání ve stejný den projde", () => {
    expect(startsTooEarly(plan("2026-11-03", "2026-11-06"), plan("2026-11-05"))).toBe(true);
    expect(startsTooEarly(plan("2026-11-03", "2026-11-06"), plan("2026-11-06"))).toBe(false);
    expect(startsTooEarly(due("2026-11-06"), plan("2026-11-02"))).toBe(true);
  });

  it("posune navazující na den po konci předchozího úkolu", () => {
    expect(catchUpDelta(plan("2026-11-03", "2026-11-06"), plan("2026-11-04", "2026-11-05"))).toBe(3);
    expect(catchUpDelta(due("2026-11-06"), plan("2026-11-02"))).toBe(5);
    expect(catchUpDelta(plan("2026-11-03"), plan("2026-11-10"))).toBe(0);
  });
});

describe("gantt: ruční pořadí", () => {
  it("přesune řádek před jiný a dá klíč všem sourozencům", () => {
    const ops = reorderOps(["a", "b", "c"], "c", "a");
    expect(ops?.map((op) => (op.type === "updateItem" ? op.id : ""))).toEqual(["c", "a", "b"]);
    expect(reorderOps(["a", "b", "c"], "a", "b")).toBeNull();
    expect(reorderOps(["a", "b", "c"], "c", null)).toBeNull();
    expect(reorderOps(["a", "b", "c"], "a", null)?.length).toBe(3);
  });

  it("ruční pořadí má přednost před datem, nové bez klíče jdou na konec", () => {
    let db = seed([
      { id: "brzy", plannedFor: "2026-11-01" },
      { id: "pozdě", plannedFor: "2026-11-20" },
      { id: "nový", plannedFor: "2026-10-01" },
    ]);
    const ops = reorderOps(["brzy", "pozdě"], "pozdě", "brzy") ?? [];
    db = reduce(db, { type: "batch", ops }, ctx());
    const rows = ganttRows(db, db.items, {
      isOpen: () => true,
      trayOpen: () => true,
      fallbackFolderId: null,
    });
    expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
      "pozdě",
      "brzy",
      "nový",
    ]);
    expect(db.items.find((item) => item.id === "pozdě")?.pristine).toBe(true);
  });
});

describe("gantt: milníky", () => {
  it("ukáže milníky složky a ty bez složky, smazané ne", () => {
    const base = ctx();
    let db = seed([]);
    const inbox = inboxFolder(db)?.id ?? "";
    db = reduce(db, { type: "createMilestone", id: "m1", folderId: inbox, title: "Předání", day: "2026-11-20" }, base);
    db = reduce(db, { type: "createMilestone", id: "m2", folderId: null, title: "Dovolená", day: "2026-11-10" }, base);
    db = reduce(db, { type: "createMilestone", id: "m3", folderId: inbox, title: "Zrušeno", day: "2026-11-11" }, base);
    db = reduce(db, { type: "deleteMilestone", id: "m3" }, base);
    expect(milestonesFor(db, new Set(["jiná"])).map((row) => row.id)).toEqual(["m2"]);
    expect(milestonesFor(db, new Set([inbox])).map((row) => row.id)).toEqual(["m2", "m1"]);
    expect(milestonesFor(db, null).map((row) => row.id)).toEqual(["m2", "m1"]);
  });

  it("odmítne milník bez názvu nebo se špatným datem a umí ho přesunout", () => {
    const base = ctx();
    let db = seed([]);
    expect(reduce(db, { type: "createMilestone", id: "x", folderId: null, title: "  ", day: "2026-11-20" }, base)).toBe(db);
    expect(reduce(db, { type: "createMilestone", id: "x", folderId: null, title: "A", day: "20. 11." }, base)).toBe(db);
    db = reduce(db, { type: "createMilestone", id: "m", folderId: null, title: "Předání", day: "2026-11-20" }, base);
    db = reduce(db, { type: "updateMilestone", id: "m", day: "2026-11-22", title: "Předání klíčů" }, base);
    expect(db.milestones[0]).toMatchObject({ day: "2026-11-22", title: "Předání klíčů" });
  });

  it("stará záloha bez milníků se načte s prázdným seznamem", () => {
    const db = seed([]);
    const { milestones: _, ...old } = db;
    const loaded = reduce(db, { type: "replaceDb", db: old }, ctx());
    expect(loaded.milestones).toEqual([]);
  });
});

describe("gantt: řádky", () => {
  it("řadí podle začátku, podúkoly dává pod rodiče a nenaplánované do zásobníku", () => {
    const db = seed([
      { id: "pozdě", plannedFor: "2026-11-10" },
      { id: "brzy", plannedFor: "2026-11-04" },
      { id: "dítě", plannedFor: "2026-11-20", parentItemId: "brzy" },
      { id: "volný" },
    ]);
    const inbox = inboxFolder(db)?.id ?? "";
    const rows = ganttRows(db, db.items, {
      isOpen: () => true,
      trayOpen: () => true,
      fallbackFolderId: null,
    });
    expect(
      rows.map((row) => (row.kind === "item" ? `${row.item.id}:${row.depth}` : row.kind))
    ).toEqual(["brzy:0", "dítě:1", "pozdě:0", "tray", "volný:0", "create"]);
    const closed = ganttRows(db, db.items, {
      isOpen: () => true,
      trayOpen: () => false,
      fallbackFolderId: null,
    });
    expect(closed.find((row) => row.kind === "tray")).toEqual({
      kind: "tray",
      key: `tray:${inbox}`,
      folderId: inbox,
      count: 1,
      open: false,
    });
    expect(closed.some((row) => row.kind === "item" && row.item.id === "volný")).toBe(false);
  });

  it("drží zobrazené pořadí, i když se data změní, a nové dává na konec", () => {
    const db = seed([
      { id: "a", plannedFor: "2026-11-20" },
      { id: "b", plannedFor: "2026-11-04" },
      { id: "c", plannedFor: "2026-11-01" },
    ]);
    const ranks = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    const rows = ganttRows(db, db.items, {
      isOpen: () => true,
      trayOpen: () => true,
      fallbackFolderId: null,
      rank: (id) => ranks.get(id),
    });
    expect(rows.flatMap((row) => (row.kind === "item" ? [row.item.id] : []))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("v celkovém přehledu vynechá složky bez plánu", () => {
    const db = seed([{ id: "volný" }]);
    expect(
      ganttRows(db, db.items, {
        isOpen: () => true,
        trayOpen: () => true,
        fallbackFolderId: "x",
        scheduledOnly: true,
      })
    ).toEqual([{ kind: "create", key: "create:x", folderId: "x" }]);
  });

  it("bez úkolů nabídne aspoň řádek pro nový úkol", () => {
    const db = seed([]);
    expect(
      ganttRows(db, db.items, {
        isOpen: () => true,
        trayOpen: () => true,
        fallbackFolderId: "x",
      })
    ).toEqual([{ kind: "create", key: "create:x", folderId: "x" }]);
  });
});
