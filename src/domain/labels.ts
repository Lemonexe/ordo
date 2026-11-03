import type { Priority, StatusMeaning, ViewMode } from "./types.ts";

export function priorityLabel(priority: Priority | null): string {
  if (priority === "low") return "nízká";
  if (priority === "high") return "vysoká";
  if (priority === "urgent") return "urgentní";
  return "běžná";
}

export function meaningLabel(meaning: StatusMeaning): string {
  if (meaning === "todo") return "Nezačaté";
  if (meaning === "doing") return "Rozpracované";
  if (meaning === "done") return "Hotové";
  if (meaning === "none") return "Nezařazeno";
  return "Zrušené";
}

export function viewLabel(view: ViewMode): string {
  if (view === "list") return "Seznam";
  if (view === "board") return "Nástěnka";
  if (view === "notes") return "Poznámky";
  if (view === "gantt") return "Časová osa";
  return "Kalendář";
}
