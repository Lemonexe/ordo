import {
  addDays,
  addMonths,
  dateKey,
  dueDateKey,
  dueTime,
  formatDay,
  isoWeekday,
  parseDateKey,
} from "./dates.ts";
import type { Item, Priority } from "./types.ts";

export type Horizon = {
  from: string;
  until: string;
  label: string;
};

type Found = {
  start: number;
  end: number;
  horizon: Horizon;
};

const NUMBERS: Record<string, number> = {
  jednoho: 1,
  jednom: 1,
  jednu: 1,
  jedna: 1,
  jeden: 1,
  dvou: 2,
  dvema: 2,
  dve: 2,
  dva: 2,
  trech: 3,
  tri: 3,
  ctyrech: 4,
  ctyr: 4,
  ctyri: 4,
  peti: 5,
  pet: 5,
  sesti: 6,
  sest: 6,
  sedmi: 7,
  sedm: 7,
  osmi: 8,
  osm: 8,
  deviti: 9,
  devet: 9,
  deseti: 10,
  deset: 10,
  jedenacti: 11,
  jedenact: 11,
  dvanacti: 12,
  dvanact: 12,
};

export function findHorizons(folded: string, today: string): Found[] {
  const found: Found[] = [];
  const take = (re: RegExp, build: (match: RegExpMatchArray) => Horizon | null) => {
    for (const match of folded.matchAll(re)) {
      const index = match.index ?? 0;
      if (insideUrl(folded, index)) continue;
      const horizon = build(match);
      if (!horizon) continue;
      found.push({ start: index, end: index + match[0].length, horizon });
    }
  };

  take(
    /(?<![\p{L}\p{N}])(?:pristi vikend|tento vikend|tenhle vikend|na vikend|o vikendu|pres vikend|behem vikendu|vikend)(?![\p{L}\p{N}])/gu,
    (match) => (match[0].startsWith("pristi") ? nextWeekend(today) : weekend(today))
  );
  take(
    /(?<![\p{L}\p{N}])(?:(?:behem|na|v|o) )?(?:zjara|jaro|jare|jara|leto|lete|leta|podzim|podzimu|zima|zime|zimu|zimy)(?![\p{L}\p{N}])/gu,
    (match) => {
      const token = match[0].split(" ").pop() ?? "";
      const name = seasonName(token);
      return name ? season(today, name) : null;
    }
  );
  take(
    /(?<![\p{L}\p{N}])(?:(?:tento|tenhle) (?:tyden|mesic|rok)|na pristi tyden|pristi mesic|pristi rok)(?![\p{L}\p{N}])/gu,
    (match) => namedPeriod(match[0], today)
  );
  take(
    /(?<![\p{L}\p{N}])do (?:konce )?(tydne|mesice|roka|roku)(?![\p{L}\p{N}])(?!\s*\d)/gu,
    (match) => {
      const phrase = match[0];
      if (phrase.includes("konce tydne"))
        return { from: today, until: endOfWeek(today), label: "do konce týdne" };
      if (phrase.includes("konce mesice"))
        return { from: today, until: endOfMonth(today), label: "do konce měsíce" };
      if (phrase.includes("konce roku") || phrase.includes("konce roka"))
        return { from: today, until: endOfYear(today), label: "do konce roku" };
      if (phrase.endsWith("tydne"))
        return within(today, 1, "week");
      if (phrase.endsWith("mesice"))
        return within(today, 1, "month");
      return within(today, 1, "year");
    }
  );
  take(
    /(?<![\p{L}\p{N}])do (?:(\d{1,3})|(jednoho|jednom|jednu|jedna|jeden|dvou|dvema|dve|dva|trech|tri|ctyrech|ctyr|ctyri|peti|pet|sesti|sest|sedmi|sedm|osmi|osm|deviti|devet|deseti|deset|jedenacti|jedenact|dvanacti|dvanact)) (dnu|dny|dne|den|tydnu|tydny|tydne|tyden|mesicu|mesice|mesici|mesic|roku|roky|roka|rok|let)(?![\p{L}\p{N}])/gu,
    (match) => {
      const count = countOf(match[1] ?? match[2] ?? "");
      const unit = unitOf(match[3] ?? "");
      if (!count || !unit) return null;
      return within(today, count, unit);
    }
  );
  return keepLongest(found);
}

export function horizonPresets(today: string): Array<Horizon & { id: string }> {
  return [
    { id: "weekend", ...weekend(today) },
    { id: "week", ...thisWeek(today) },
    { id: "month", ...thisMonth(today) },
    { id: "quarter", ...within(today, 3, "month"), label: "do 3 měsíců" },
    { id: "spring", ...season(today, "jaro") },
    { id: "summer", ...season(today, "léto") },
    { id: "autumn", ...season(today, "podzim") },
    { id: "winter", ...season(today, "zima") },
  ];
}

export function whenLabel(
  item: {
    dueAt: string | null;
    dueHasTime: boolean;
    plannedFor: string | null;
    planUntil?: string | null;
  },
  today: string
): string | null {
  const due = dueDateKey(item.dueAt);
  if (due) {
    const time = dueTime(item.dueAt, item.dueHasTime);
    return time ? `${formatDay(due, today)} ${time}` : formatDay(due, today);
  }
  if (!item.plannedFor) return null;
  return planLabel(item.plannedFor, item.planUntil, today);
}

export function planLabel(
  from: string,
  until: string | null | undefined,
  today: string
): string {
  if (!until || until <= from) return formatDay(from, today);
  const named = namedSpan(from, until, today);
  if (named) return named;
  return `${formatDay(from, today)} – ${formatDay(until, today)}`;
}

export function planEnd(from: string, until: string | null | undefined): string {
  return until && until > from ? until : from;
}

export function isLongPlan(from: string | null, until: string | null | undefined): boolean {
  if (!from) return false;
  return inclusiveDays(from, planEnd(from, until)) > 7;
}

export function reminderCount(priority: Priority | null): number {
  if (priority === "low") return 2;
  if (priority === "high") return 4;
  if (priority === "urgent") return 6;
  return 3;
}

// Long plans are not one block. A handful of days, always including the last
// one, never denser than every other day. Short plans return nothing here.
export function reminderDays(
  from: string,
  until: string | null | undefined,
  priority: Priority | null
): string[] {
  const end = planEnd(from, until);
  const span = inclusiveDays(from, end);
  if (span <= 7) return [];
  const count = Math.min(reminderCount(priority), Math.floor((span + 1) / 2), span);
  const days: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = count === 1 ? span - 1 : Math.round((index * (span - 1)) / (count - 1));
    const day = addDays(from, offset);
    if (days.at(-1) !== day) days.push(day);
  }
  if (days.at(-1) !== end) days.push(end);
  return days;
}

export function needsLastReminderUrgent(item: Item, today: string): boolean {
  if (item.type !== "task" || item.isDeleted || item.isArchived || item.dueAt) return false;
  if (item.priority === "urgent" || !item.plannedFor) return false;
  if (!isLongPlan(item.plannedFor, item.planUntil)) return false;
  return today >= planEnd(item.plannedFor, item.planUntil);
}

export function planIsDue(
  from: string | null,
  until: string | null | undefined,
  today: string,
  priority: Priority | null = null
): boolean {
  if (!from || from > today) return false;
  const end = planEnd(from, until);
  if (today > end || from === end) return true;
  if (!isLongPlan(from, until)) return true;
  return reminderDays(from, until, priority).includes(today);
}

export function planOnDay(
  from: string | null,
  until: string | null | undefined,
  day: string,
  priority: Priority | null = null
): boolean {
  if (!from) return false;
  const end = planEnd(from, until);
  if (day < from || day > end) return false;
  if (!isLongPlan(from, until)) return true;
  return reminderDays(from, until, priority).includes(day);
}

function namedSpan(from: string, until: string, today: string): string | null {
  if (from === weekend(today).from && until === weekend(today).until) return "víkend";
  if (from === nextWeekend(today).from && until === nextWeekend(today).until)
    return "příští víkend";
  if (from === thisWeek(today).from && until === thisWeek(today).until)
    return "tento týden";
  if (from === nextWeek(today).from && until === nextWeek(today).until)
    return "příští týden";
  if (from === thisMonth(today).from && until === thisMonth(today).until)
    return "tento měsíc";
  if (from === nextMonth(today).from && until === nextMonth(today).until)
    return "příští měsíc";
  if (from === thisYear(today).from && until === thisYear(today).until)
    return "tento rok";
  if (from === nextYear(today).from && until === nextYear(today).until)
    return "příští rok";
  for (const name of ["jaro", "léto", "podzim"] as const) {
    const year = Number(from.slice(0, 4));
    const span = seasonIn(year, name);
    if (from === span.from && until === span.until) return name;
  }
  if (from.endsWith("-12-01")) {
    const year = Number(from.slice(0, 4));
    const span = { from, until: ymd(year + 1, 2, 29) };
    if (until === span.until) return "zima";
  }
  return null;
}

function namedPeriod(token: string, today: string): Horizon | null {
  if (token.endsWith("tyden") && token.includes("pristi")) return nextWeek(today);
  if (token.endsWith("tyden")) return thisWeek(today);
  if (token.endsWith("mesic") && token.includes("pristi")) return nextMonth(today);
  if (token.endsWith("mesic")) return thisMonth(today);
  if (token.includes("pristi")) return nextYear(today);
  return thisYear(today);
}

function seasonName(token: string): "jaro" | "léto" | "podzim" | "zima" | null {
  if (token === "jaro" || token === "jare" || token === "jara" || token === "zjara")
    return "jaro";
  if (token === "leto" || token === "lete" || token === "leta") return "léto";
  if (token === "podzim" || token === "podzimu") return "podzim";
  if (token === "zima" || token === "zime" || token === "zimu" || token === "zimy")
    return "zima";
  return null;
}

function season(today: string, name: "jaro" | "léto" | "podzim" | "zima"): Horizon {
  if (name === "zima") {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    // Leden a únor patří k zimě, která začala v prosinci.
    const startYear = month <= 2 ? year - 1 : year;
    return { from: `${startYear}-12-01`, until: ymd(startYear + 1, 2, 29), label: "zima" };
  }
  const year = Number(today.slice(0, 4));
  const current = seasonIn(year, name);
  const span = current.until < today ? seasonIn(year + 1, name) : current;
  return { ...span, label: name };
}

function seasonIn(
  year: number,
  name: "jaro" | "léto" | "podzim"
): { from: string; until: string } {
  if (name === "jaro") return { from: ymd(year, 3, 1), until: ymd(year, 5, 31) };
  if (name === "léto") return { from: ymd(year, 6, 1), until: ymd(year, 8, 31) };
  return { from: ymd(year, 9, 1), until: ymd(year, 11, 30) };
}

function weekend(today: string): Horizon {
  const day = isoWeekday(today);
  const from = day === 7 ? addDays(today, -1) : day === 6 ? today : addDays(today, 6 - day);
  return { from, until: addDays(from, 1), label: "víkend" };
}

function nextWeekend(today: string): Horizon {
  const current = weekend(today);
  return {
    from: addDays(current.from, 7),
    until: addDays(current.until, 7),
    label: "příští víkend",
  };
}

function thisWeek(today: string): Horizon {
  const monday = addDays(today, 1 - isoWeekday(today));
  return { from: monday, until: addDays(monday, 6), label: "tento týden" };
}

function nextWeek(today: string): Horizon {
  const monday = addDays(thisWeek(today).from, 7);
  return { from: monday, until: addDays(monday, 6), label: "příští týden" };
}

function thisMonth(today: string): Horizon {
  const start = `${today.slice(0, 7)}-01`;
  return { from: start, until: endOfMonth(start), label: "tento měsíc" };
}

function nextMonth(today: string): Horizon {
  const start = addMonths(`${today.slice(0, 7)}-01`, 1);
  return { from: start, until: endOfMonth(start), label: "příští měsíc" };
}

function thisYear(today: string): Horizon {
  const year = today.slice(0, 4);
  return { from: `${year}-01-01`, until: `${year}-12-31`, label: "tento rok" };
}

function nextYear(today: string): Horizon {
  const year = String(Number(today.slice(0, 4)) + 1);
  return { from: `${year}-01-01`, until: `${year}-12-31`, label: "příští rok" };
}

function within(today: string, count: number, unit: "day" | "week" | "month" | "year"): Horizon {
  const until =
    unit === "day"
      ? addDays(today, count)
      : unit === "week"
        ? addDays(today, count * 7)
        : addMonths(today, unit === "month" ? count : count * 12);
  return { from: today, until, label: withinLabel(count, unit) };
}

function withinLabel(count: number, unit: "day" | "week" | "month" | "year"): string {
  if (unit === "day") return count === 1 ? "do zítřka" : `do ${count} dnů`;
  if (unit === "week") return count === 1 ? "do týdne" : `do ${count} týdnů`;
  if (unit === "month") return count === 1 ? "do měsíce" : `do ${count} měsíců`;
  return count === 1 ? "do roka" : `do ${count} let`;
}

function countOf(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return value >= 1 && value <= 240 ? value : null;
  }
  return NUMBERS[token] ?? null;
}

function unitOf(token: string): "day" | "week" | "month" | "year" | null {
  if (token === "den" || token === "dne" || token === "dny" || token === "dnu") return "day";
  if (token.startsWith("tyd")) return "week";
  if (token.startsWith("mes")) return "month";
  if (token === "rok" || token === "roku" || token === "roky" || token === "roka" || token === "let")
    return "year";
  return null;
}

function endOfWeek(today: string): string {
  return addDays(today, 7 - isoWeekday(today));
}

function endOfMonth(key: string): string {
  const date = parseDateKey(key);
  return ymd(date.getFullYear(), date.getMonth() + 1, 31);
}

function endOfYear(today: string): string {
  return `${today.slice(0, 4)}-12-31`;
}

function ymd(year: number, month: number, day: number): string {
  const last = new Date(year, month, 0).getDate();
  return dateKey(new Date(year, month - 1, Math.min(day, last)));
}

function inclusiveDays(from: string, until: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = until.split("-").map(Number);
  const start = Date.UTC(y1 ?? 1970, (m1 ?? 1) - 1, d1 ?? 1);
  const end = Date.UTC(y2 ?? 1970, (m2 ?? 1) - 1, d2 ?? 1);
  return Math.round((end - start) / 86400000) + 1;
}

function insideUrl(text: string, index: number): boolean {
  return /(?:https?:\/\/|www\.)\S*$/i.test(text.slice(0, index));
}

function keepLongest(found: Found[]): Found[] {
  const ordered = [...found].sort(
    (a, b) => a.start - b.start || b.end - a.end
  );
  const kept: Found[] = [];
  let cursor = 0;
  for (const hit of ordered) {
    if (hit.start < cursor) continue;
    kept.push(hit);
    cursor = hit.end;
  }
  return kept;
}
