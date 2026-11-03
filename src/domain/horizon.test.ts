import { describe, expect, it } from "vitest";
import { findHorizons, needsLastReminderUrgent, planIsDue, planLabel, planOnDay, reminderDays } from "./horizon.ts";
import type { Item } from "./types.ts";
import { fold } from "./text.ts";

const friday = "2026-10-16";
const saturday = "2026-10-17";

function first(text: string, today: string) {
  return findHorizons(fold(text), today)[0]?.horizon ?? null;
}

describe("období", () => {
  it("pozná jaro, tři měsíce a víkend", () => {
    expect(first("vysadit javor na jaře", saturday)).toEqual({
      from: "2027-03-01",
      until: "2027-05-31",
      label: "jaro",
    });
    expect(first("koupit beton do třech měsíců", saturday)).toEqual({
      from: saturday,
      until: "2027-01-17",
      label: "do 3 měsíců",
    });
    expect(first("koupit beton do tří měsíců", saturday)?.until).toBe("2027-01-17");
    expect(first("koupit beton do 3 měsíců", saturday)?.label).toBe("do 3 měsíců");
    expect(first("vypnout topení na víkend", saturday)).toEqual({
      from: "2026-10-17",
      until: "2026-10-18",
      label: "víkend",
    });
    expect(first("vypnout topení na víkend", friday)).toEqual({
      from: "2026-10-17",
      until: "2026-10-18",
      label: "víkend",
    });
  });

  it("nebere slovo javor ani adresu", () => {
    expect(first("vysadit javor", saturday)).toBeNull();
    expect(first("návod https://example.com/jaro", saturday)).toBeNull();
  });

  it("posune roční období, která už letos skončila", () => {
    expect(first("na podzim", saturday)).toEqual({
      from: "2026-09-01",
      until: "2026-11-30",
      label: "podzim",
    });
    expect(first("v zimě", saturday)?.from).toBe("2026-12-01");
    expect(first("v zimě", "2026-01-10")).toEqual({
      from: "2025-12-01",
      until: "2026-02-28",
      label: "zima",
    });
    expect(first("na jaře", "2026-04-02")?.from).toBe("2026-03-01");
    expect(first("na jaře", "2026-06-01")?.from).toBe("2027-03-01");
  });

  it("krátké období patří do dneška, dlouhý plán jen v den připomínky", () => {
    expect(planIsDue("2026-10-17", "2026-10-18", saturday)).toBe(true);
    expect(planIsDue("2027-03-01", "2027-05-31", saturday)).toBe(false);
    expect(planIsDue(saturday, "2027-01-17", saturday)).toBe(true);
    expect(planIsDue(saturday, "2027-01-17", "2027-01-12")).toBe(false);
    expect(planIsDue(saturday, "2027-01-17", "2027-01-17")).toBe(true);
    expect(planIsDue("2027-03-01", "2027-05-31", "2027-05-28")).toBe(false);
    expect(planIsDue("2027-03-01", "2027-05-31", "2027-05-31")).toBe(true);
    expect(planIsDue("2026-10-20", null, saturday)).toBe(false);
    expect(planIsDue("2026-10-16", null, saturday)).toBe(true);
  });

  it("v kalendáři ukáže víkend a dny připomínek, ne celou sezonu", () => {
    expect(planOnDay("2026-10-17", "2026-10-18", "2026-10-18")).toBe(true);
    expect(planOnDay("2027-03-01", "2027-05-31", "2027-04-15")).toBe(false);
    expect(planOnDay("2027-03-01", "2027-05-31", "2027-03-01")).toBe(true);
    expect(planOnDay("2027-03-01", "2027-05-31", "2027-05-31")).toBe(true);
    expect(planOnDay("2026-10-20", null, "2026-10-20")).toBe(true);
  });

  it("počet připomínek roste s prioritou a poslední den je vždy v nich", () => {
    const from = "2026-10-01";
    const until = "2026-10-20";
    const low = reminderDays(from, until, "low");
    const normal = reminderDays(from, until, null);
    const high = reminderDays(from, until, "high");
    const urgent = reminderDays(from, until, "urgent");
    expect(low).toHaveLength(2);
    expect(normal).toHaveLength(3);
    expect(high).toHaveLength(4);
    expect(urgent).toHaveLength(6);
    for (const days of [low, normal, high, urgent]) {
      expect(days[0]).toBe(from);
      expect(days.at(-1)).toBe(until);
      for (let index = 1; index < days.length; index += 1) {
        const left = days[index - 1];
        const right = days[index];
        const between =
          left && right
            ? Math.round(
                (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86400000
              )
            : 0;
        expect(between).toBeGreaterThanOrEqual(2);
      }
    }
    const packed = reminderDays("2026-10-01", "2026-10-08", "urgent");
    expect(packed).toHaveLength(4);
    expect(packed.at(-1)).toBe("2026-10-08");
    expect(reminderDays("2026-10-01", "2026-10-07", "urgent")).toEqual([]);
  });

  it("poslední den otevřeného dlouhého plánu chce urgentní prioritu", () => {
    const item = {
      type: "task",
      isDeleted: false,
      isArchived: false,
      dueAt: null,
      priority: null,
      plannedFor: "2026-10-01",
      planUntil: "2026-10-20",
    } as Item;
    expect(needsLastReminderUrgent(item, "2026-10-20")).toBe(true);
    expect(needsLastReminderUrgent(item, "2026-10-19")).toBe(false);
    expect(needsLastReminderUrgent({ ...item, priority: "urgent" }, "2026-10-20")).toBe(false);
    expect(needsLastReminderUrgent({ ...item, planUntil: "2026-10-05" }, "2026-10-05")).toBe(false);
    expect(needsLastReminderUrgent({ ...item, dueAt: "2026-10-20" }, "2026-10-20")).toBe(false);
  });

  it("pojmenuje uložené rozmezí", () => {
    expect(planLabel("2027-03-01", "2027-05-31", saturday)).toBe("jaro");
    expect(planLabel("2026-10-17", "2026-10-18", saturday)).toBe("víkend");
    expect(planLabel(saturday, "2027-01-17", saturday)).toBe("dnes – 17. 1. 2027");
    expect(planLabel("2026-10-12", "2026-10-21", saturday)).toBe("12. 10. – 21. 10.");
    expect(planLabel("2026-10-20", "2026-10-22", saturday)).toBe("20. 10. – 22. 10.");
    expect(planLabel("2026-10-20", null, saturday)).toBe("20. 10.");
  });
});
