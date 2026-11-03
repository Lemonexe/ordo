import {
  CalendarDays,
  ChartGantt,
  ChevronDown,
  ChevronRight,
  ChevronsUp,
  ChevronUp,
  Columns3,
  List,
  Pencil,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { showOtherCalendars, useGcalMonth } from "../data/gcal.ts";
import { dispatch, useSnap } from "../data/store.tsx";
import { isUntouched } from "../data/syncMap.ts";
import { isPaletteColor } from "../domain/color.ts";
import { addDays, dateKey, formatDay, todayKey } from "../domain/dates.ts";
import {
  byId,
  descendantFolderIds,
  inboxFolder,
  resolvedOpen,
} from "../domain/db.ts";
import { newItem } from "../domain/factory.ts";
import { whenLabel } from "../domain/horizon.ts";
import { priorityLabel } from "../domain/labels.ts";
import {
  plainNoteTitle,
  splitNoteDraft,
  takeNoteIntent,
} from "../domain/noteIntent.ts";
import { keyAtStart } from "../domain/ordering.ts";
import { opsFromTaskLines, parseQuickAdd } from "../domain/quickAdd.ts";
import {
  applyQuery,
  focusSections,
  folderItems,
  folderTrail,
  isOpenItem,
  mapStatus,
  searchItems,
  searchTags,
  shownChildFolders,
  tagItems,
  tagsOf,
  visibleItems,
} from "../domain/select.ts";
import {
  clampStickySize,
  STICKY_H,
  STICKY_PAPERS,
  STICKY_W,
  stickyColumns,
  stickySlot,
  stickyTilt,
  stickyTone,
} from "../domain/stickies.ts";
import {
  FOLDER_COLOR_LABELS,
  FOLDER_COLOR_ORDER,
  type Db,
  type Folder,
  type FolderPaint,
  type Item,
  type Priority,
  type Tag,
  type ViewMode,
} from "../domain/types.ts";
import { eventsOnDay } from "../lib/gcalEvents.ts";
import { CalendarBoard, PlanTargets } from "./calendar.tsx";
import { GanttBoard } from "./gantt.tsx";
import {
  Dot,
  FolderChildren,
  FolderCrumbs,
  FolderGlyph,
  treePad,
} from "./folders.tsx";
import { GcalDayEvents, GcalNote } from "./gcal.tsx";
import { loadDemo } from "./guide.tsx";
import {
  FormatBar,
  MarkdownField,
  type LinkHit,
  type MarkdownHandle,
} from "./markdownField.tsx";
import { placeOp } from "./move.ts";
import { useUi } from "./state.tsx";
import { BoardView, deleteItems, ItemList, ListView } from "./tasks.tsx";
import {
  Button,
  cx,
  hoverRow,
  OpenMark,
  PriorityMark,
  TagMark,
  trapTab,
  useLayer,
} from "./ui.tsx";

let captureLock = false;

export function Capture() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const { db } = useSnap();
  const ui = useUi();
  useEffect(() => {
    if (location !== "/add") {
      captureLock = false;
      return;
    }
    if (captureLock) return;
    captureLock = true;
    const params = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search
    );
    const text = params.get("text") ?? "";
    const folderParam = params.get("folder");
    const due = params.get("due");
    const inbox = inboxFolder(db);
    const named = folderParam
      ? db.folders.find(
          (folder) =>
            !folder.isDeleted &&
            (folder.id === folderParam ||
              folder.name.toLocaleLowerCase("cs") ===
                folderParam.toLocaleLowerCase("cs"))
        )
      : null;
    const intent = takeNoteIntent(text);
    if (intent.note && inbox) {
      const folder = named ?? inbox;
      const draft = splitNoteDraft(intent.text);
      const home =
        folder.system === "inbox" ? "/inbox" : `/folder/${folder.id}`;
      if (!draft) {
        ui.openQuick({
          text: intent.text,
          kind: "note",
          folderId: folder.id,
        });
        setLocation(home, { replace: true });
        return;
      }
      const id = nanoid(10);
      const next = dispatch({
        type: "createItem",
        item: newItem({
          id,
          folderId: folder.id,
          title: draft.title,
          body: draft.body,
          type: "note",
          statusId: resolvedOpen(db, folder)?.id ?? null,
          applyRules: false,
        }),
      });
      if (byId(next.items, id)) {
        ui.pushToast("Poznámka uložena", true);
        ui.select(id);
      }
      setLocation(home, { replace: true });
      return;
    }
    if (!text.trim() || !inbox) {
      ui.openQuick({ text });
      setLocation("/inbox", { replace: true });
      return;
    }
    const first = parseQuickAdd(text, db, todayKey());
    const folder =
      byId(db.folders, first.folderId ?? named?.id ?? inbox.id) ?? inbox;
    const { ops, itemIds } = opsFromTaskLines(db, text, {
      folderId: folder.id,
      statusId: resolvedOpen(db, folder)?.id ?? null,
      dateRole: "due",
      applyRules: folder.system === "inbox",
      ids: () => nanoid(10),
      today: todayKey(),
    });
    if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
      for (const id of itemIds)
        ops.push({
          type: "updateItem",
          id,
          patch: {
            dueAt: due,
            dueHasTime: false,
            plannedFor: null,
            planUntil: null,
          },
        });
    }
    const next = dispatch({ type: "batch", ops });
    const created = itemIds.flatMap((id) => {
      const item = byId(next.items, id);
      return item ? [item] : [];
    });
    const moved = created.filter((item) => item.folderId !== inbox.id);
    if (folder.system === "inbox" && moved.length === 1) {
      const home = byId(next.folders, moved[0]?.folderId ?? null);
      if (home) ui.pushToast(`Zařazeno do ${home.name}`, true);
    } else if (folder.system === "inbox" && moved.length > 1) {
      ui.pushToast("Zařazeno podle pravidel.", true);
    }
    const only = created.length === 1 ? created[0] : null;
    ui.select(only?.id ?? null);
    const homeId = only?.folderId ?? folder.id;
    setLocation(homeId === inbox.id ? "/inbox" : `/folder/${homeId}`, {
      replace: true,
    });
  }, [location, search, db, ui, setLocation]);
  return null;
}

export function HomePage() {
  const ui = useUi();
  const today = todayKey();
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="font-display text-3xl">Domů</h1>
        <button
          type="button"
          className="text-sm text-muted! hover:text-ink!"
          onClick={() => ui.setFolderEdit({ id: null, parentId: null })}
        >
          Nová složka
        </button>
      </div>
      <EmptyWelcome />
      <RecentTasks />
      <HomeTree today={today} />
    </div>
  );
}

function EmptyWelcome() {
  const { db } = useSnap();
  const ui = useUi();
  const inbox = inboxFolder(db);
  if (!isUntouched(db) || !inbox) return null;
  return (
    <section className="mb-8 rounded-xl border border-line bg-panel px-4 py-4">
      <h2 className="font-display text-2xl">Zatím tu nic není</h2>
      <p className="mt-1 mb-3 max-w-xl text-sm text-muted">
        Naplň ukázkou, ať je vidět složky, nástěnka, kalendář, opakování a
        návrhy. Až ji nebudeš chtít, v nastavení všechna data smažeš.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          tone="solid"
          onClick={() => {
            loadDemo(inbox.id);
            ui.pushToast("Ukázka je naplněná", true);
          }}
        >
          Naplň ukázkou
        </Button>
        <Link
          href="/pruvodce"
          className="inline-flex items-center rounded-md bg-black/[0.04] px-3 py-1.5 text-sm font-medium hover:bg-black/10 dark:bg-white/[0.06] dark:hover:bg-white/10"
        >
          Co Ordo umí
        </Link>
      </div>
    </section>
  );
}

function RecentTasks() {
  const { db } = useSnap();
  const items = visibleItems(db)
    .filter(
      (item) =>
        item.type === "task" && !item.parentItemId && isOpenItem(db, item)
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 8);
  if (items.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-1 px-1 text-sm text-muted">Poslední úkoly</h2>
      <ItemList items={items} showFolder />
    </section>
  );
}

function HomeTree({ today }: { today: string }) {
  const { db } = useSnap();
  const ui = useUi();
  const folders = shownChildFolders(db, null, ui.showHidden);
  if (folders.length === 0) {
    return <p className="text-sm text-muted">Zatím tu žádná složka není.</p>;
  }
  return (
    <div>
      {folders.map((folder) => (
        <HomeFolder key={folder.id} folder={folder} depth={0} today={today} />
      ))}
    </div>
  );
}

function HomeFolder({
  folder,
  depth,
  today,
}: {
  folder: Folder;
  depth: number;
  today: string;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const [location] = useLocation();
  const [open, setOpen] = useState(depth < 1);
  const children = shownChildFolders(db, folder.id, ui.showHidden);
  const href = folder.system === "inbox" ? "/inbox" : `/folder/${folder.id}`;
  const active = location === href;
  const tasks = folderItems(db, folder.id, true).filter(
    (item) => item.type === "task" && isOpenItem(db, item)
  );
  const overdue = tasks.filter(
    (item) => item.dueAt && item.dueAt.slice(0, 10) < today
  ).length;
  const dueToday = tasks.filter(
    (item) => item.dueAt?.slice(0, 10) === today
  ).length;
  const parts: string[] = [];
  if (overdue > 0)
    parts.push(overdue === 1 ? "1 po termínu" : `${overdue} po termínu`);
  if (dueToday > 0)
    parts.push(dueToday === 1 ? "1 na dnešek" : `${dueToday} na dnešek`);
  useEffect(() => {
    if (!location.startsWith("/folder/")) return;
    const currentId = location.slice("/folder/".length);
    if (currentId === folder.id) return;
    if (folderTrail(db, currentId).some((entry) => entry.id === folder.id))
      setOpen(true);
  }, [location, folder.id]);
  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
        style={{ paddingLeft: treePad(depth) }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="grid size-5 shrink-0 place-items-center rounded-md text-muted! hover:bg-black/10 hover:text-ink! dark:hover:bg-white/15"
            aria-expanded={open}
            aria-label={open ? "Sbalit" : "Rozbalit"}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight
              size={16}
              className={cx("transition-transform", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <Link
          href={href}
          className="flex min-w-0 flex-1 items-center gap-3"
          onClick={(event) => {
            if (children.length > 0 && active) {
              event.preventDefault();
              setOpen((value) => !value);
              return;
            }
            if (children.length > 0) setOpen(true);
          }}
        >
          <Dot color={folder.color} icon={folder.icon} />
          <span className="min-w-0 flex-1">
            <span
              className={cx(
                "block truncate",
                depth === 0 && "font-medium",
                folder.hidden && "text-muted"
              )}
            >
              {folder.name}
            </span>
            {parts.length > 0 && (
              <span className="block truncate text-xs text-muted">
                {parts.join(" · ")}
              </span>
            )}
          </span>
          {tasks.length > 0 && (
            <span className="text-xs tabular-nums text-muted">
              {tasks.length}
            </span>
          )}
        </Link>
      </div>
      {open &&
        children.map((child) => (
          <HomeFolder
            key={child.id}
            folder={child}
            depth={depth + 1}
            today={today}
          />
        ))}
    </div>
  );
}

function countLabel(count: number, one: string, few: string, many: string) {
  if (count === 1) return `1 ${one}`;
  return `${count} ${count < 5 ? few : many}`;
}

const FOCUS_TITLE = {
  overdue: "Po termínu",
  today: "Dnes",
  soon: "Do týdne",
  priority: "Vysoká priorita",
  ready: "Můžu začít",
} as const;

export function TodayPage() {
  const { db } = useSnap();
  const today = todayKey();
  const sections = focusSections(db, today);
  const monthEvents = useGcalMonth(today.slice(0, 7));
  const events = showOtherCalendars() ? eventsOnDay(monthEvents, today) : [];
  return (
    <div>
      <h1 className="mb-4 font-display text-3xl">Dnes</h1>
      <PlanTargets />
      <GcalNote />
      {events.length > 0 && (
        <section className="mb-5">
          <h2 className="mb-1 px-1 text-sm text-muted">V kalendáři</h2>
          <GcalDayEvents events={events} day={today} />
        </section>
      )}
      {sections.length === 0 && events.length === 0 && (
        <p className="px-2 text-sm text-muted">Teď tu nic není.</p>
      )}
      {sections.map((section) => (
        <section key={section.id} className="mb-5">
          <h2 className="mb-1 px-1 text-sm text-muted">
            {FOCUS_TITLE[section.id]}
          </h2>
          <ItemList items={section.items} showFolder />
        </section>
      ))}
      <p className="mt-4 text-xs text-muted">
        Zítřek je {addDays(today, 1)}. Přetažení na den nastaví plán a zruší
        přesný termín.
      </p>
    </div>
  );
}

export function InboxPage() {
  const { db } = useSnap();
  const ui = useUi();
  const inbox = inboxFolder(db);
  useEffect(() => {
    const current = inboxFolder(db);
    if (!current) return;
    const before = new Set(
      folderItems(db, current.id, false).map((item) => item.id)
    );
    const next = dispatch({ type: "sortInbox" });
    const afterFolder = inboxFolder(next);
    if (!afterFolder) return;
    const after = new Set(
      folderItems(next, afterFolder.id, false).map((item) => item.id)
    );
    let moved = 0;
    for (const id of before) if (!after.has(id)) moved += 1;
    if (moved > 0) {
      ui.pushToast(
        `${countLabel(
          moved,
          "položka zařazena",
          "položky zařazeny",
          "položek zařazeno"
        )} podle pravidel.`,
        true
      );
    }
    // Při dalším překreslení by vrácený krok hned znovu zařadil.
  }, []);
  if (!inbox) return null;
  return (
    <FolderScreen
      folder={inbox}
      intro={
        <p className="mt-1 text-sm text-muted">
          Sem patří všechno, co ještě nemá své místo.{" "}
          <Link
            href="/settings#pravidla"
            className="text-ink underline decoration-line underline-offset-2"
          >
            Pravidla
          </Link>
        </p>
      }
    />
  );
}

type TaskLayout = Exclude<ViewMode, "notes">;

const TASK_LAYOUTS: Array<[TaskLayout, typeof List, string]> = [
  ["list", List, "Seznam"],
  ["board", Columns3, "Nástěnka"],
  ["calendar", CalendarDays, "Kalendář"],
  ["gantt", ChartGantt, "Časová osa"],
];

function layoutKey(folderId: string) {
  return `ordo.taskLayout:${folderId}`;
}

// Last way of showing tasks in a folder, so Úkoly returns to it after notes.
function lastTaskLayout(folderId: string): TaskLayout {
  try {
    const value = localStorage.getItem(layoutKey(folderId));
    return TASK_LAYOUTS.some(([mode]) => mode === value)
      ? (value as TaskLayout)
      : "list";
  } catch {
    return "list";
  }
}

function rememberTaskLayout(folderId: string, layout: TaskLayout) {
  try {
    localStorage.setItem(layoutKey(folderId), layout);
  } catch {
    // Only a convenience.
  }
}

// What the folder shows: tasks or notes.
function KindSwitch({
  folderId,
  view,
  taskCount,
  noteCount,
  onChoose,
}: {
  folderId: string;
  view: ViewMode;
  taskCount: number;
  noteCount: number;
  onChoose: (view: ViewMode) => void;
}) {
  const notesOn = view === "notes";
  const segment = (active: boolean) =>
    cx(
      "flex items-center gap-1.5 rounded-md px-3 py-1 text-sm whitespace-nowrap",
      active
        ? "bg-raised text-ink! shadow-[var(--shadow)]"
        : "text-muted! hover:text-ink!"
    );
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg bg-black/5 p-0.5 dark:bg-white/10"
      role="group"
      aria-label="Obsah složky"
    >
      <button
        type="button"
        aria-pressed={!notesOn}
        className={segment(!notesOn)}
        onClick={() => onChoose(notesOn ? lastTaskLayout(folderId) : view)}
      >
        Úkoly
        <span className="text-xs tabular-nums text-muted">{taskCount}</span>
      </button>
      <button
        type="button"
        aria-pressed={notesOn}
        className={segment(notesOn)}
        onClick={() => {
          if (!notesOn) rememberTaskLayout(folderId, view as TaskLayout);
          onChoose("notes");
        }}
      >
        Poznámky
        <span className="text-xs tabular-nums text-muted">{noteCount}</span>
      </button>
    </div>
  );
}

// How the tasks are laid out. Hidden for notes.
function LayoutTabs({
  folderId,
  view,
  onChoose,
}: {
  folderId: string;
  view: TaskLayout;
  onChoose: (view: ViewMode) => void;
}) {
  return (
    <div
      className="mb-4 flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line"
      role="tablist"
      aria-label="Zobrazení úkolů"
    >
      {TASK_LAYOUTS.map(([mode, Icon, label]) => {
        const active = view === mode;
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            title={label}
            className={cx(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm whitespace-nowrap",
              active
                ? "border-accent font-medium text-ink!"
                : "border-transparent text-muted! hover:text-ink!"
            )}
            onClick={() => {
              rememberTaskLayout(folderId, mode);
              onChoose(mode);
            }}
          >
            <Icon size={16} className="shrink-0" />
            <span className={cx(!active && "max-sm:hidden")}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function FolderScreen({
  folder,
  intro,
}: {
  folder: Folder;
  intro?: ReactNode;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const view =
    ui.glance?.folderId === folder.id ? ui.glance.view : folder.defaultView;
  const items = folderItems(db, folder.id, false);
  const nested = descendantFolderIds(db, folder.id)
    .map((id) => byId(db.folders, id))
    .filter(
      (entry): entry is NonNullable<typeof entry> =>
        entry !== null && !entry.isDeleted && !entry.isArchived
    );
  const notes = items.filter((item) => item.type === "note");
  const choose = (mode: ViewMode) => {
    ui.setGlance(null);
    if (folder.defaultView === mode) return;
    dispatch({
      type: "updateFolder",
      id: folder.id,
      patch: { defaultView: mode },
    });
  };
  const tasks = items.filter((item) => item.type === "task");
  return (
    <div
      className={
        view === "board" ? "flex min-h-0 min-w-0 flex-1 flex-col" : undefined
      }
    >
      <div className="mb-4 flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <FolderCrumbs folderId={folder.id} parentsOnly />
          <div className="flex items-center gap-2.5">
            <FolderGlyph color={folder.color} className="h-10" />
            <h1 className="font-display text-3xl">
              {folder.icon ? `${folder.icon} ` : ""}
              {folder.name}
            </h1>
            <button
              type="button"
              aria-label="Upravit"
              title="Upravit"
              className="grid size-8 place-items-center rounded-md text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
              onClick={() =>
                ui.setFolderEdit({ id: folder.id, parentId: folder.parentId })
              }
            >
              <Pencil size={16} />
            </button>
          </div>
          {intro}
        </div>
        <KindSwitch
          folderId={folder.id}
          view={view}
          taskCount={
            tasks.filter((item) => ui.showDone || isOpenItem(db, item)).length
          }
          noteCount={notes.length}
          onChoose={choose}
        />
      </div>
      {view !== "notes" && (
        <LayoutTabs folderId={folder.id} view={view} onChoose={choose} />
      )}
      {view === "list" && (
        <>
          <FolderChildren parentId={folder.id} />
          <ListView folder={folder} items={tasks} />
        </>
      )}
      {view === "board" && <BoardView folder={folder} />}
      {view === "notes" && <Notes folderId={folder.id} notes={notes} />}
      {view === "calendar" && (
        <CalendarBoard
          folderId={folder.id}
          items={visibleItems(db).filter(
            (item) =>
              item.folderId === folder.id ||
              nested.some((entry) => entry.id === item.folderId)
          )}
        />
      )}
      {view === "gantt" && (
        <GanttBoard
          key={folder.id}
          folderId={folder.id}
          items={visibleItems(db).filter(
            (item) =>
              item.folderId === folder.id ||
              nested.some((entry) => entry.id === item.folderId)
          )}
        />
      )}
    </div>
  );
}

export function FolderPage() {
  const params = useParams<{ id: string }>();
  const { db } = useSnap();
  const folder = byId(db.folders, params.id ?? null);
  if (!folder || folder.isDeleted) return <p>Složka tu není.</p>;
  return <FolderScreen folder={folder} />;
}

function noteSource(note: { title: string; body: string | null }) {
  const body = note.body?.replace(/\r\n/g, "\n") ?? "";
  if (!body) return note.title;
  const first = body.split("\n", 1)[0] ?? "";
  const plain = plainNoteTitle(first);
  if (plain === note.title) return body;
  return `${note.title}\n${body}`;
}

function NoteTask({ id }: { id: string }) {
  const { db } = useSnap();
  return (
    <p className="text-sm text-muted">
      {byId(db.items, id)?.title ?? "Úkol už tu není."}
    </p>
  );
}

function noteLinks(db: Db, query: string): LinkHit[] {
  const found = query.trim()
    ? searchItems(db, query)
    : visibleItems(db)
        .slice()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .slice(0, 8);
  return found.slice(0, 8).map((item) => ({
    id: item.id,
    title: item.title.trim() || (item.type === "note" ? "Poznámka" : "Úkol"),
    kind: item.type === "note" ? "note" : "task",
  }));
}

function useNoteSuggest() {
  const { db } = useSnap();
  return (query: string) => noteLinks(db, query);
}

function LiveNote({
  source,
  onCommit,
  editor,
}: {
  source: string;
  onCommit: (text: string) => void;
  editor: RefObject<MarkdownHandle | null>;
}) {
  const suggest = useNoteSuggest();
  const box = useRef<HTMLDivElement>(null);
  const draft = useRef(source);
  const [text, setText] = useState(source);
  useEffect(() => {
    if (source === draft.current) return;
    const active = document.activeElement;
    if (active instanceof Node && box.current?.contains(active)) return;
    draft.current = source;
    setText(source);
  }, [source]);
  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <MarkdownField
        ref={editor}
        value={text}
        formats
        suggest={suggest}
        leadClassName="note-title break-words"
        placeholder="Nadpis"
        tailPlaceholder="Text…"
        label="Poznámka"
        className="min-h-16 flex-1 cursor-text"
        embed={(id) => <NoteTask id={id} />}
        onChange={(next) => {
          draft.current = next;
          setText(next);
        }}
        onBlur={() => {
          const next = draft.current;
          if (next.trim() === source.trim()) return;
          if (!splitNoteDraft(next)) {
            draft.current = source;
            setText(source);
            return;
          }
          onCommit(next);
        }}
      />
    </div>
  );
}

function Notes({
  folderId,
  notes,
}: {
  folderId: string;
  notes: ReturnType<typeof folderItems>;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const board = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  const folder = byId(db.folders, folderId);
  const statusId = folder ? resolvedOpen(db, folder)?.id ?? null : null;
  useLayoutEffect(() => {
    const node = board.current;
    if (!node) return;
    const measure = () => setColumns(stickyColumns(node.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = board.current;
    if (!node) return;
    let bottom = 480;
    for (const card of node.querySelectorAll<HTMLElement>("[data-sticky]")) {
      bottom = Math.max(bottom, card.offsetTop + card.offsetHeight + 28);
    }
    node.style.height = `${bottom}px`;
  });
  const create = (draft: NoteDraft) => {
    const parsed = splitNoteDraft(draft.text);
    const at =
      draft.x != null && draft.y != null
        ? {
            x: Math.round(Math.max(0, draft.x)),
            y: Math.round(Math.max(0, draft.y)),
          }
        : null;
    if (!parsed && !at) return;
    const pinZ =
      at == null
        ? null
        : notes.reduce((max, note) => Math.max(max, note.pinZ ?? 0), 0) + 1;
    dispatch({
      type: "createItem",
      item: newItem({
        id: nanoid(10),
        folderId,
        title: parsed?.title ?? "Poznámka",
        body: parsed?.body ?? null,
        type: "note",
        statusId,
        sortOrder: keyAtStart(notes.map((note) => note.sortOrder)),
        priority: draft.priority,
        paper: draft.paper,
        pinX: at?.x ?? null,
        pinY: at?.y ?? null,
        pinZ,
        pinW: draft.width,
        pinH: draft.height,
      }),
    });
  };
  const drop = (id: string, x: number, y: number) => {
    const pinZ =
      notes.reduce((max, note) => Math.max(max, note.pinZ ?? 0), 0) + 1;
    dispatch({
      type: "updateItem",
      id,
      patch: {
        pinX: Math.round(Math.max(0, x)),
        pinY: Math.round(Math.max(0, y)),
        pinZ,
      },
    });
  };
  const file = (id: string, targetId: string) => {
    const note = byId(db.items, id);
    const folder = byId(db.folders, targetId);
    if (!note || !folder || note.folderId === folder.id) return false;
    const mapped = mapStatus(db, note.statusId, folder.id);
    const go = (statusId: string) => {
      dispatch({
        type: "batch",
        ops: [
          placeOp(db, id, folder.id, statusId),
          {
            type: "updateItem",
            id,
            patch: { pinX: null, pinY: null, pinZ: null },
          },
        ],
      });
      ui.pushToast(`Zařazeno do ${folder.name}`, true);
    };
    if (mapped.choices.length > 1) {
      ui.askChoice({
        title: "Který stav?",
        options: mapped.choices.map((status) => ({
          id: status.id,
          label: status.name,
        })),
        onPick: go,
      });
      return false;
    }
    if (!mapped.statusId) return false;
    go(mapped.statusId);
    return true;
  };
  const composerAt = stickySlot(0, columns);
  return (
    <div ref={board} className="relative mt-1 min-h-[32rem]">
      <NoteComposer
        x={composerAt.x}
        y={composerAt.y}
        onCommit={create}
        onDiscard={() => ui.pushToast("Koncept je zahozený")}
      />
      {notes.map((note, index) => {
        const auto = stickySlot(index + 1, columns);
        return (
          <StickyCard
            key={note.id}
            note={note}
            source={noteSource(note)}
            x={note.pinX ?? auto.x}
            y={note.pinY ?? auto.y}
            z={(note.pinZ ?? index) + 2}
            onDrop={drop}
            onFile={file}
            onTrash={() =>
              deleteItems([note], ui.pushToast, () => {
                if (ui.selectedId === note.id) ui.setSelected(null);
              })
            }
            onCommit={(text) => {
              const parsed = splitNoteDraft(text);
              if (!parsed) return;
              if (parsed.title === note.title && parsed.body === note.body)
                return;
              dispatch({
                type: "updateItem",
                id: note.id,
                patch: { title: parsed.title, body: parsed.body },
                fileInbox: true,
              });
            }}
            onResize={(width, height) => {
              if (note.pinW === width && note.pinH === height) return;
              dispatch({
                type: "updateItem",
                id: note.id,
                patch: { pinW: width, pinH: height },
              });
            }}
            onPaper={(paper) => {
              const current = stickyTone(note.paper, note.id).index;
              if (note.paper == null && current === paper) return;
              if (note.paper === paper) return;
              dispatch({
                type: "updateItem",
                id: note.id,
                patch: { paper },
              });
            }}
            onPriority={(priority) => {
              if (priority === note.priority) return;
              dispatch({
                type: "updateItem",
                id: note.id,
                patch: { priority },
              });
            }}
          />
        );
      })}
    </div>
  );
}

type NoteDraft = {
  text: string;
  paper: number;
  priority: Priority | null;
  width: number | null;
  height: number | null;
  x: number | null;
  y: number | null;
};

const PRIORITY_LADDER = ["low", null, "high", "urgent"] as const;

function priorityIndex(priority: Priority | null) {
  const index = PRIORITY_LADDER.indexOf(priority);
  return index === -1 ? 1 : index;
}

function priorityNext(priority: Priority | null): Priority | null {
  const index = priorityIndex(priority);
  return PRIORITY_LADDER[(index + 1) % PRIORITY_LADDER.length] ?? null;
}

function PriorityGlyph({ priority }: { priority: Priority | null }) {
  if (priority === "urgent")
    return (
      <ChevronsUp
        size={15}
        strokeWidth={2.5}
        className="text-[#d23b32] dark:text-[#ff6d60]"
      />
    );
  if (priority === "high")
    return (
      <ChevronUp
        size={15}
        strokeWidth={2.5}
        className="text-[#c8960a] dark:text-[#f0c14a]"
      />
    );
  if (priority === "low")
    return (
      <ChevronDown
        size={15}
        strokeWidth={2.5}
        className="text-[#2f8a3c] dark:text-[#7dca78]"
      />
    );
  return <span className="size-1.5 rounded-full bg-muted" />;
}

function NotePriority({
  priority,
  onChange,
}: {
  priority: Priority | null;
  onChange: (priority: Priority | null) => void;
}) {
  const [live, setLive] = useState<Priority | null | undefined>(undefined);
  const origin = useRef<{ y: number; index: number } | null>(null);
  const dragged = useRef(false);
  const shown = live === undefined ? priority : live;
  return (
    <button
      type="button"
      aria-label={`Priorita ${priorityLabel(shown)}. Táhni nahoru nebo dolů.`}
      title="Táhni nahoru pro vyšší prioritu"
      className="relative grid size-6 shrink-0 cursor-ns-resize touch-none place-items-center"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        origin.current = { y: event.clientY, index: priorityIndex(priority) };
        dragged.current = false;
        setLive(priority);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Prohlížeč pointer nepustí, gesto stejně doběhne.
        }
      }}
      onPointerMove={(event) => {
        const start = origin.current;
        if (!start) return;
        event.stopPropagation();
        const delta = start.y - event.clientY;
        if (Math.abs(delta) > 8) dragged.current = true;
        const index = Math.min(
          PRIORITY_LADDER.length - 1,
          Math.max(0, start.index + Math.round(delta / 22))
        );
        setLive(PRIORITY_LADDER[index] ?? null);
      }}
      onPointerUp={(event) => {
        const start = origin.current;
        origin.current = null;
        if (!start) return;
        event.stopPropagation();
        const delta = start.y - event.clientY;
        if (Math.abs(delta) >= 8) {
          const index = Math.min(
            PRIORITY_LADDER.length - 1,
            Math.max(0, start.index + Math.round(delta / 22))
          );
          onChange(PRIORITY_LADDER[index] ?? null);
        }
        setLive(undefined);
      }}
      onPointerCancel={() => {
        origin.current = null;
        setLive(undefined);
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onChange(priorityNext(priority));
      }}
    >
      {live !== undefined && (
        <span className="pointer-events-none absolute top-full left-1/2 z-30 mt-1 -translate-x-1/2 rounded-sm bg-raised px-1.5 py-0.5 text-xs whitespace-nowrap text-ink shadow-[var(--shadow)]">
          {priorityLabel(shown)}
        </span>
      )}
      <PriorityGlyph priority={shown} />
    </button>
  );
}

function StickyTools({
  paper,
  priority,
  onPaper,
  onPriority,
  editor,
}: {
  paper: number;
  priority: Priority | null;
  onPaper: (paper: number) => void;
  onPriority: (priority: Priority | null) => void;
  editor: RefObject<MarkdownHandle | null>;
}) {
  const suggest = useNoteSuggest();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const tone = STICKY_PAPERS[paper] ?? STICKY_PAPERS[0];
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (button.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-card-settings]"))
        return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div
      data-sticky-tool=""
      className="mt-1 flex shrink-0 items-center justify-between gap-2 pr-6"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label="Nastavení kartičky"
        aria-expanded={open}
        className="grid size-6 place-items-center rounded-md"
        onClick={() => {
          const rect = button.current?.getBoundingClientRect();
          if (!rect) return;
          const width = 280;
          setBox({
            top: Math.min(rect.bottom + 6, window.innerHeight - 24),
            left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8),
          });
          setOpen((value) => !value);
        }}
      >
        <span
          className="size-3.5 rounded-full"
          style={{
            background: tone.bg,
            boxShadow: open
              ? "0 0 0 1.5px #2a241c"
              : "inset 0 0 0 1px rgb(42 36 28 / 22%)",
          }}
        />
      </button>
      {open && box
        ? createPortal(
            <div
              data-card-settings=""
              data-format-bar=""
              className="fixed z-[90] max-h-[70vh] w-[17.5rem] overflow-auto rounded-lg border border-line bg-raised p-2 shadow-[var(--shadow)]"
              style={{ top: box.top, left: box.left }}
              onMouseDown={(event) => {
                if (event.target instanceof HTMLInputElement) return;
                event.preventDefault();
              }}
            >
              <p className="mb-1 px-1 text-xs text-muted">Barva</p>
              <div className="mb-2 flex items-center gap-1 px-1" role="radiogroup" aria-label="Barva">
                {STICKY_PAPERS.map((swatch, index) => {
                  const selected = index === paper;
                  const label =
                    swatch.name.charAt(0).toLocaleUpperCase("cs") +
                    swatch.name.slice(1);
                  return (
                    <button
                      key={swatch.bg}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={label}
                      title={label}
                      className="grid size-6 place-items-center rounded-md"
                      onClick={() => onPaper(index)}
                    >
                      <span
                        className="size-3.5 rounded-full"
                        style={{
                          background: swatch.bg,
                          boxShadow: selected
                            ? "0 0 0 1.5px #2a241c"
                            : "inset 0 0 0 1px rgb(42 36 28 / 22%)",
                        }}
                      />
                    </button>
                  );
                })}
              </div>
              <p className="mb-1 px-1 text-xs text-muted">Formát</p>
              <FormatBar
                onFormat={(action) => editor.current?.format(action)}
                suggest={suggest}
              />
            </div>,
            document.body
          )
        : null}
      <NotePriority priority={priority} onChange={onPriority} />
    </div>
  );
}

function NoteResize({
  width,
  height,
  onLive,
  onResize,
}: {
  width: number;
  height: number | null;
  onLive: (size: { w: number; h: number } | null) => void;
  onResize: (width: number, height: number) => void;
}) {
  const handle = useRef<HTMLDivElement>(null);
  const resize = useRef<{
    px: number;
    py: number;
    w: number;
    h: number;
  } | null>(null);
  const currentHeight = () => {
    const host = handle.current?.offsetParent;
    return (
      height ?? (host instanceof HTMLElement ? host.offsetHeight : STICKY_H)
    );
  };
  return (
    <div
      ref={handle}
      data-resize=""
      role="button"
      aria-label="Velikost poznámky"
      className="absolute right-0 bottom-0 z-10 grid size-6 cursor-nwse-resize touch-none place-items-end p-1"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = handle.current?.offsetParent?.getBoundingClientRect();
        if (!rect) return;
        resize.current = {
          px: event.clientX,
          py: event.clientY,
          w: rect.width,
          h: rect.height,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = resize.current;
        if (!start) return;
        event.stopPropagation();
        const next = clampStickySize(
          start.w + event.clientX - start.px,
          start.h + event.clientY - start.py
        );
        onLive({ w: next.width, h: next.height });
      }}
      onPointerUp={(event) => {
        const start = resize.current;
        resize.current = null;
        if (!start) return;
        event.stopPropagation();
        const next = clampStickySize(
          start.w + event.clientX - start.px,
          start.h + event.clientY - start.py
        );
        if (
          next.width === Math.round(start.w) &&
          next.height === Math.round(start.h)
        ) {
          onLive(null);
          return;
        }
        onResize(next.width, next.height);
      }}
      onPointerCancel={() => {
        resize.current = null;
        onLive(null);
      }}
      onKeyDown={(event) => {
        const horizontal =
          event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
        const vertical =
          event.key === "ArrowDown" ? 16 : event.key === "ArrowUp" ? -16 : 0;
        if (!horizontal && !vertical) return;
        event.preventDefault();
        event.stopPropagation();
        const current = clampStickySize(width, currentHeight());
        const next = clampStickySize(
          current.width + horizontal,
          current.height + vertical
        );
        onResize(next.width, next.height);
      }}
    >
      <span className="size-2.5 border-r-2 border-b-2 border-[#2a241c]/40" />
    </div>
  );
}

const NOTE_HOLD_MS = 200;
const NOTE_DRAG_SLOP = 6;
const NOTE_HOLD_SLOP = 12;

function focusNote(root: HTMLElement | null) {
  root?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
}

type StickyPress = {
  fromText: boolean;
  ready: boolean;
  release: () => void;
};

function attachStickyPress(
  event: ReactPointerEvent<HTMLElement>,
  hooks: {
    onArm: () => void;
    onCancel: () => void;
    onSlide: (event: PointerEvent) => void;
    onFinish: () => void;
  }
): StickyPress | null {
  if (event.button !== 0) return null;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      "a, textarea, input, button, [data-resize], [data-sticky-tool]"
    )
  )
    return null;
  const fromText =
    target instanceof Element &&
    Boolean(target.closest("[contenteditable='true']"));
  const pointerId = event.pointerId;
  const x0 = event.clientX;
  const y0 = event.clientY;
  const host = event.currentTarget;
  let timer: number | null = null;
  let stopped = false;
  const press: StickyPress = {
    fromText,
    ready: !fromText,
    release: () => {
      if (stopped) return;
      stopped = true;
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    },
  };
  const onMove = (native: PointerEvent) => {
    if (stopped || native.pointerId !== pointerId) return;
    if (!press.ready) {
      if (Math.hypot(native.clientX - x0, native.clientY - y0) < NOTE_HOLD_SLOP)
        return;
      press.release();
      hooks.onCancel();
      return;
    }
    hooks.onSlide(native);
  };
  const onUp = (native: PointerEvent) => {
    if (stopped || native.pointerId !== pointerId) return;
    const ready = press.ready;
    press.release();
    if (ready) hooks.onFinish();
    else hooks.onCancel();
  };
  const onCancel = (native: PointerEvent) => {
    if (stopped || native.pointerId !== pointerId) return;
    press.release();
    hooks.onCancel();
  };
  if (!fromText) {
    try {
      host.setPointerCapture(pointerId);
    } catch {
      // Prohlížeč pointer nepustí, gesto stejně doběhne nad kartou.
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return press;
  }
  timer = window.setTimeout(() => {
    timer = null;
    if (stopped) return;
    press.ready = true;
    try {
      host.setPointerCapture(pointerId);
    } catch {
      // Pointer už mezitím skončil, tah stejně jede přes okno.
    }
    hooks.onArm();
  }, NOTE_HOLD_MS);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  return press;
}

function NoteComposer({
  x,
  y,
  onCommit,
  onDiscard,
}: {
  x: number;
  y: number;
  onCommit: (draft: NoteDraft) => void;
  onDiscard: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<MarkdownHandle>(null);
  const suggest = useNoteSuggest();
  const draft = useRef("");
  const committed = useRef<string | null>(null);
  const skip = useRef(false);
  const holding = useRef(false);
  const suppress = useRef(false);
  const chosen = useRef<Omit<NoteDraft, "text" | "x" | "y">>({
    paper: 0,
    priority: null,
    width: null,
    height: null,
  });
  const origin = useRef<{
    px: number;
    py: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const place = useRef<{ x: number; y: number } | null>(null);
  const overTrash = useRef(false);
  const moved = useRef(false);
  const fromText = useRef(false);
  const gesture = useRef<StickyPress | null>(null);
  const [held, setHeld] = useState(false);
  const [text, setText] = useState("");
  const [paper, setPaper] = useState(0);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [size, setSize] = useState<{ w: number; h: number | null }>({
    w: STICKY_W,
    h: null,
  });
  const [live, setLive] = useState<{ w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [generation, setGeneration] = useState(0);
  const shown = live ?? size;
  const tone = STICKY_PAPERS[paper] ?? STICKY_PAPERS[0];
  chosen.current = {
    paper,
    priority,
    width: shown.h == null ? null : shown.w,
    height: shown.h,
  };
  useEffect(() => {
    if (!drag) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [drag]);
  useEffect(() => {
    return () => gesture.current?.release();
  }, []);
  const cancelPress = () => {
    gesture.current = null;
    origin.current = null;
    place.current = null;
    moved.current = false;
    overTrash.current = false;
    holding.current = false;
    markNoteFolder(null);
    setDrag(null);
    setHeld(false);
  };
  const reset = (fresh: boolean) => {
    draft.current = "";
    setText("");
    setPaper(0);
    setPriority(null);
    setSize({ w: STICKY_W, h: null });
    setLive(null);
    if (fresh) setGeneration((n) => n + 1);
  };
  const commit = (at: { x: number; y: number } | null) => {
    if (skip.current) return;
    const value = draft.current;
    if (committed.current === value && !at) return;
    if (!splitNoteDraft(value) && !at) return;
    committed.current = value;
    const next = chosen.current;
    suppress.current = true;
    reset(at != null);
    onCommit({ text: value, ...next, x: at?.x ?? null, y: at?.y ?? null });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        suppress.current = false;
      });
    });
  };
  const leave = () => {
    window.setTimeout(() => {
      if (holding.current) return;
      const active = document.activeElement;
      if (active instanceof Node && box.current?.contains(active)) return;
      if (active instanceof Element && active.closest("[data-format-bar]")) return;
      if (skip.current) {
        skip.current = false;
        return;
      }
      commit(null);
    }, 0);
  };
  const slideRef = useRef<(event: PointerEvent) => void>(() => {});
  const finishRef = useRef<() => void>(() => {});
  slideRef.current = (event) => {
    const start = origin.current;
    const node = box.current;
    if (!start || !node || !gesture.current?.ready) return;
    const dx = event.clientX - start.px;
    const dy = event.clientY - start.py;
    if (!moved.current && Math.hypot(dx, dy) < NOTE_DRAG_SLOP) return;
    if (!moved.current) window.getSelection()?.removeAllRanges();
    moved.current = true;
    event.preventDefault();
    const raw = { x: start.x + dx, y: start.y + dy };
    place.current = { x: Math.max(0, raw.x), y: Math.max(0, raw.y) };
    setDrag(raw);
    const hit = folderUnder(event.clientX, event.clientY, node);
    const trash = hit?.kind === "trash";
    overTrash.current = trash;
    markNoteFolder(trash ? "trash" : null);
  };
  finishRef.current = () => {
    if (!holding.current) return;
    const next = place.current;
    const didMove = moved.current;
    const trashed = overTrash.current;
    const text = fromText.current;
    origin.current = null;
    place.current = null;
    moved.current = false;
    overTrash.current = false;
    fromText.current = false;
    holding.current = false;
    gesture.current?.release();
    gesture.current = null;
    setHeld(false);
    markNoteFolder(null);
    setDrag(null);
    if (didMove && trashed) {
      const had = Boolean(splitNoteDraft(draft.current));
      skip.current = true;
      committed.current = draft.current;
      reset(true);
      if (had) onDiscard();
      return;
    }
    if (didMove && next) {
      commit(next);
      return;
    }
    if (!text) focusNote(box.current);
  };
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = attachStickyPress(event, {
      onArm: () => setHeld(true),
      onCancel: cancelPress,
      onSlide: (native) => slideRef.current(native),
      onFinish: () => finishRef.current(),
    });
    if (!press) return;
    gesture.current?.release();
    gesture.current = press;
    fromText.current = press.fromText;
    holding.current = true;
    const rect = box.current?.getBoundingClientRect();
    origin.current = {
      px: event.clientX,
      py: event.clientY,
      x,
      y,
      left: rect?.left ?? x,
      top: rect?.top ?? y,
    };
    place.current = { x, y };
    moved.current = false;
    overTrash.current = false;
  };
  const floating =
    drag && origin.current
      ? {
          left: origin.current.left + (drag.x - origin.current.x),
          top: origin.current.top + (drag.y - origin.current.y),
        }
      : null;
  return (
    <div
      ref={box}
      data-sticky=""
      data-note-composer=""
      className={cx(
        "sticky-note absolute flex flex-col rounded-sm px-4 pt-5 pb-2",
        shown.h == null ? "min-h-[148px]" : "overflow-hidden",
        drag || held ? "cursor-grabbing" : "cursor-grab"
      )}
      data-note-held={drag || held ? "" : undefined}
      data-note-drag={drag ? "" : undefined}
      style={{
        left: floating ? floating.left : drag?.x ?? x,
        top: floating ? floating.top : drag?.y ?? y,
        width: shown.w,
        height: shown.h ?? undefined,
        background: tone.bg,
        zIndex: drag ? 80 : 1,
        position: floating ? "fixed" : undefined,
        pointerEvents: floating ? "none" : undefined,
        transform: floating ? "rotate(0deg) scale(1.03)" : undefined,
      }}
      onBlur={leave}
      onPointerDown={beginDrag}
      onPointerMove={(event) => slideRef.current(event.nativeEvent)}
      onPointerUp={() => finishRef.current()}
      onPointerCancel={() => {
        if (!holding.current) return;
        const text = fromText.current;
        origin.current = null;
        place.current = null;
        moved.current = false;
        overTrash.current = false;
        fromText.current = false;
        holding.current = false;
        gesture.current?.release();
        gesture.current = null;
        setHeld(false);
        markNoteFolder(null);
        setDrag(null);
        if (!text) commit(null);
      }}
    >
      <span
        className="absolute inset-x-0 top-0 z-10 h-2 cursor-grab touch-none"
        style={{ background: tone.edge }}
      />
      <MarkdownField
        key={generation}
        ref={editor}
        value={text}
        formats
        suggest={suggest}
        autoFocus
        leadClassName="note-title break-words"
        placeholder="Nadpis"
        tailPlaceholder="Text…"
        label="Nová poznámka"
        className="min-h-16 flex-1 cursor-text"
        embed={(id) => <NoteTask id={id} />}
        onChange={(next) => {
          if (suppress.current) return;
          committed.current = null;
          draft.current = next;
          setText(next);
        }}
        onEscape={() => {
          skip.current = true;
          reset(false);
        }}
        onBlur={leave}
      />
      <StickyTools
        paper={paper}
        priority={priority}
        onPaper={setPaper}
        onPriority={setPriority}
        editor={editor}
      />
      <NoteResize
        width={shown.w}
        height={shown.h}
        onLive={setLive}
        onResize={(width, height) => {
          setSize({ w: width, h: height });
          setLive(null);
        }}
      />
    </div>
  );
}

type NoteHit = { kind: "folder"; id: string } | { kind: "trash" };

function folderUnder(x: number, y: number, card: HTMLElement): NoteHit | null {
  for (const node of document.elementsFromPoint(x, y)) {
    if (!(node instanceof Element) || node === card || card.contains(node))
      continue;
    if (node.closest("[data-note-trash]")) return { kind: "trash" };
    const row = node.closest<HTMLElement>(
      "[data-folder-row], [data-note-folder]"
    );
    const id = row?.dataset.folderRow ?? row?.dataset.noteFolder;
    if (id) return { kind: "folder", id };
  }
  return null;
}

let noteOver: string | null = null;

function markNoteFolder(id: string | null) {
  if (noteOver === id) return;
  const paint = (key: string, on: boolean) => {
    const selector =
      key === "trash"
        ? "[data-note-trash]"
        : `[data-folder-row="${CSS.escape(
            key
          )}"], [data-note-folder="${CSS.escape(key)}"]`;
    for (const row of document.querySelectorAll(selector)) {
      if (on) row.setAttribute("data-note-over", "");
      else row.removeAttribute("data-note-over");
    }
  };
  if (noteOver) paint(noteOver, false);
  noteOver = id;
  if (!id) return;
  paint(id, true);
  if (id !== "trash")
    document.dispatchEvent(new CustomEvent("ordo-note-over", { detail: id }));
}

function StickyCard({
  note,
  source,
  x,
  y,
  z,
  onCommit,
  onDrop,
  onFile,
  onTrash,
  onResize,
  onPaper,
  onPriority,
}: {
  note: Item;
  source: string;
  x: number;
  y: number;
  z: number;
  onCommit: (text: string) => void;
  onDrop: (id: string, x: number, y: number) => void;
  onFile: (id: string, folderId: string) => boolean;
  onTrash: () => void;
  onResize: (width: number, height: number) => void;
  onPaper: (paper: number) => void;
  onPriority: (priority: Priority | null) => void;
}) {
  const ui = useUi();
  const card = useRef<HTMLElement>(null);
  const editor = useRef<MarkdownHandle>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [live, setLive] = useState<{ w: number; h: number } | null>(null);
  const origin = useRef<{
    px: number;
    py: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const place = useRef<{ x: number; y: number } | null>(null);
  const overFolder = useRef<string | null>(null);
  const moved = useRef(false);
  const fromText = useRef(false);
  const gesture = useRef<StickyPress | null>(null);
  const [held, setHeld] = useState(false);
  const tone = stickyTone(note.paper, note.id);
  const left = drag?.x ?? x;
  const top = drag?.y ?? y;
  const dragging = drag !== null;
  const floating =
    drag && origin.current
      ? {
          left: origin.current.left + (drag.x - origin.current.x),
          top: origin.current.top + (drag.y - origin.current.y),
        }
      : null;
  useEffect(() => {
    if (!dragging) return;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [dragging]);
  const width = live?.w ?? note.pinW ?? STICKY_W;
  const height = live?.h ?? note.pinH ?? null;
  useEffect(() => {
    if (!drag || origin.current) return;
    if (
      Math.round(x) === Math.round(drag.x) &&
      Math.round(y) === Math.round(drag.y)
    )
      setDrag(null);
  }, [x, y, drag]);
  useEffect(() => {
    if (!live) return;
    if (note.pinW === live.w && note.pinH === live.h) setLive(null);
  }, [note.pinW, note.pinH, live]);
  useEffect(() => {
    return () => gesture.current?.release();
  }, []);
  const cancelPress = () => {
    gesture.current = null;
    origin.current = null;
    place.current = null;
    moved.current = false;
    overFolder.current = null;
    markNoteFolder(null);
    setDrag(null);
    setHeld(false);
  };
  const slideRef = useRef<(event: PointerEvent) => void>(() => {});
  const finishRef = useRef<() => void>(() => {});
  slideRef.current = (event) => {
    const start = origin.current;
    const node = card.current;
    if (!start || !node || !gesture.current?.ready) return;
    const dx = event.clientX - start.px;
    const dy = event.clientY - start.py;
    if (!moved.current && Math.hypot(dx, dy) < NOTE_DRAG_SLOP) return;
    if (!moved.current) window.getSelection()?.removeAllRanges();
    moved.current = true;
    event.preventDefault();
    const raw = { x: start.x + dx, y: start.y + dy };
    place.current = { x: Math.max(0, raw.x), y: Math.max(0, raw.y) };
    setDrag(raw);
    const hit = folderUnder(event.clientX, event.clientY, node);
    const target =
      hit?.kind === "trash"
        ? "trash"
        : hit?.kind === "folder" && hit.id !== note.folderId
        ? hit.id
        : null;
    overFolder.current = target;
    markNoteFolder(target);
  };
  finishRef.current = () => {
    const didMove = moved.current;
    if (!gesture.current && !didMove) return;
    const next = place.current;
    const folder = overFolder.current;
    const text = fromText.current;
    origin.current = null;
    place.current = null;
    moved.current = false;
    overFolder.current = null;
    fromText.current = false;
    gesture.current?.release();
    gesture.current = null;
    setHeld(false);
    markNoteFolder(null);
    if (!didMove) {
      if (!text) focusNote(card.current);
      return;
    }
    if (folder === "trash") {
      onTrash();
      setDrag(null);
      return;
    }
    if (folder) {
      if (!onFile(note.id, folder)) setDrag(null);
      return;
    }
    if (next) {
      setDrag(next);
      onDrop(note.id, next.x, next.y);
    } else setDrag(null);
  };
  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const press = attachStickyPress(event, {
      onArm: () => setHeld(true),
      onCancel: cancelPress,
      onSlide: (native) => slideRef.current(native),
      onFinish: () => finishRef.current(),
    });
    if (!press) return;
    gesture.current?.release();
    gesture.current = press;
    fromText.current = press.fromText;
    const host = card.current?.offsetParent;
    const hostBox =
      host instanceof HTMLElement ? host.getBoundingClientRect() : null;
    origin.current = {
      px: event.clientX,
      py: event.clientY,
      x: left,
      y: top,
      left: hostBox ? hostBox.left + left : left,
      top: hostBox ? hostBox.top + top : top,
    };
    place.current = { x: left, y: top };
    moved.current = false;
    overFolder.current = null;
  };
  return (
    <article
      ref={card}
      data-note=""
      data-note-id={note.id}
      data-sticky=""
      data-activity-focus={ui.focusId === note.id ? "" : undefined}
      className={cx(
        "sticky-note absolute flex flex-col rounded-sm px-4 pt-5 pb-2",
        height === null ? "min-h-[148px]" : "overflow-hidden",
        drag || held ? "cursor-grabbing" : "cursor-grab"
      )}
      data-note-held={drag || held ? "" : undefined}
      data-note-drag={drag ? "" : undefined}
      style={{
        left: floating ? floating.left : left,
        top: floating ? floating.top : top,
        width,
        height: height ?? undefined,
        zIndex: drag || live ? 80 : z,
        background: tone.bg,
        position: floating ? "fixed" : undefined,
        pointerEvents: floating ? "none" : undefined,
        transform: floating
          ? "rotate(0deg) scale(1.03)"
          : `rotate(${stickyTilt(note.id)}deg)`,
      }}
      onPointerDown={beginDrag}
      onPointerMove={(event) => slideRef.current(event.nativeEvent)}
      onPointerUp={() => finishRef.current()}
      onPointerCancel={() => {
        origin.current = null;
        place.current = null;
        moved.current = false;
        overFolder.current = null;
        fromText.current = false;
        gesture.current?.release();
        gesture.current = null;
        setHeld(false);
        markNoteFolder(null);
        setDrag(null);
      }}
    >
      <span
        className="absolute inset-x-0 top-0 z-10 h-2 cursor-grab touch-none"
        style={{ background: tone.edge }}
      />
      <div
        className={cx(
          "flex min-h-0 flex-1 flex-col",
          height !== null && "overflow-auto"
        )}
      >
        <LiveNote source={source} onCommit={onCommit} editor={editor} />
      </div>
      <StickyTools
        paper={tone.index}
        priority={note.priority}
        onPaper={onPaper}
        onPriority={onPriority}
        editor={editor}
      />
      <NoteResize
        width={width}
        height={height}
        onLive={setLive}
        onResize={(nextWidth, nextHeight) => {
          setLive({ w: nextWidth, h: nextHeight });
          onResize(nextWidth, nextHeight);
        }}
      />
    </article>
  );
}

export function TrashPage() {
  const { db } = useSnap();
  const ui = useUi();
  const [openId, setOpenId] = useState<string | null>(null);
  const today = todayKey();
  const entries = [
    ...db.folders
      .filter((folder) => folder.isDeleted)
      .map((folder) => ({
        kind: "folder" as const,
        folder,
        at: folder.updatedAt,
      })),
    ...db.items
      .filter((item) => item.isDeleted)
      .map((item) => ({ kind: "item" as const, item, at: item.updatedAt })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-3xl">Koš</h1>
        <Button
          tone="danger"
          onClick={() =>
            ui.askConfirm({
              title: "Vyprázdnit koš?",
              body: "Smazané položky zmizí nadobro.",
              confirm: "Vyprázdnit",
              onConfirm: () => dispatch({ type: "emptyTrash" }),
            })
          }
        >
          Vyprázdnit
        </Button>
      </div>
      {entries.length === 0 && (
        <p className="text-sm text-muted">Koš je prázdný.</p>
      )}
      <div className="divide-y divide-line">
        {entries.map((entry) =>
          entry.kind === "folder" ? (
            <TrashFolder
              key={entry.folder.id}
              db={db}
              folder={entry.folder}
              today={today}
              open={openId === entry.folder.id}
              onToggle={() =>
                setOpenId((current) =>
                  current === entry.folder.id ? null : entry.folder.id
                )
              }
              onOpenItem={setOpenId}
              onRestore={() =>
                dispatch({ type: "restoreFolder", id: entry.folder.id })
              }
              onPurge={() => {
                dispatch({ type: "purgeFolder", id: entry.folder.id });
                ui.pushToast(
                  `Složka „${entry.folder.name}“ je smazaná natrvalo`,
                  true
                );
              }}
            />
          ) : (
            <TrashItem
              key={entry.item.id}
              db={db}
              item={entry.item}
              today={today}
              open={openId === entry.item.id}
              onToggle={() =>
                setOpenId((current) =>
                  current === entry.item.id ? null : entry.item.id
                )
              }
              onRestore={() =>
                dispatch({ type: "restoreItem", id: entry.item.id })
              }
              onPurge={() => {
                dispatch({ type: "purgeItem", id: entry.item.id });
                ui.pushToast(
                  `„${
                    entry.item.title.trim() || "Bez názvu"
                  }“ je smazané natrvalo`,
                  true
                );
              }}
            />
          )
        )}
      </div>
    </div>
  );
}

function TrashItem({
  db,
  item,
  today,
  open,
  onToggle,
  onRestore,
  onPurge,
}: {
  db: Db;
  item: Item;
  today: string;
  open: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const title = item.title.trim() || "Bez názvu";
  const kind = item.type === "note" ? "Poznámka" : "Úkol";
  const place = trashPlace(db, item.folderId);
  const when = deletedWhen(item.updatedAt, today);
  const source = item.type === "note" ? noteSource(item) : item.body ?? "";
  const hasText =
    item.type === "note" ? source !== item.title : Boolean(source.trim());
  const status = byId(db.statuses, item.statusId);
  const due = whenLabel(item, today);
  const tags = tagsOf(db, item.id);
  const person = byId(db.people, item.assigneeId);
  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? (
            <ChevronDown size={16} className="mt-1 shrink-0 text-muted" />
          ) : (
            <ChevronRight size={16} className="mt-1 shrink-0 text-muted" />
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium">{title}</span>
            <span className="mt-0.5 block truncate text-sm text-muted">
              {kind}
              {" · "}
              {place.text}
              {place.gone ? " (v koši)" : ""}
              {when ? ` · ${when}` : ""}
            </span>
          </span>
        </button>
        <span className="flex shrink-0 gap-1">
          <Button onClick={onRestore}>Obnovit</Button>
          <Button tone="danger" onClick={onPurge}>
            Smazat
          </Button>
        </span>
      </div>
      {open && (
        <div className="mt-3 ml-6 grid gap-3">
          {hasText && (
            <div className="rounded-md bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
              <MarkdownField
                value={source}
                editable={false}
                label={title}
                {...(item.type === "note"
                  ? { leadClassName: "note-title break-words" }
                  : {})}
              />
            </div>
          )}
          <dl className="grid gap-1.5 text-sm">
            <TrashFact label="Druh">{kind}</TrashFact>
            <TrashFact label="Složka">
              {place.href ? (
                <Link
                  href={place.href}
                  className="underline decoration-line underline-offset-2"
                >
                  {place.text}
                </Link>
              ) : (
                place.text
              )}
              {place.gone && (
                <span className="text-muted">
                  {" "}
                  je v koši. Položka se po obnovení zařadí do{" "}
                  {inboxFolder(db)?.name ?? "Nezařazené"}.
                </span>
              )}
            </TrashFact>
            {item.type === "task" && status && (
              <TrashFact label="Stav">{status.name}</TrashFact>
            )}
            {due && <TrashFact label="Termín">{due}</TrashFact>}
            {item.priority && (
              <TrashFact label="Priorita">
                {priorityLabel(item.priority)}
              </TrashFact>
            )}
            {person && !person.isDeleted && (
              <TrashFact label="Člověk">{person.name}</TrashFact>
            )}
            {tags.length > 0 && (
              <TrashFact label="Štítky">
                <span className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <TagMark key={tag.id} name={tag.name} color={tag.color} />
                  ))}
                </span>
              </TrashFact>
            )}
            {item.origin && <TrashFact label="Odkud">{item.origin}</TrashFact>}
            {item.place && <TrashFact label="Kam">{item.place}</TrashFact>}
            {when && <TrashFact label="Smazáno">{when}</TrashFact>}
          </dl>
        </div>
      )}
    </div>
  );
}

function TrashFolder({
  db,
  folder,
  today,
  open,
  onToggle,
  onOpenItem,
  onRestore,
  onPurge,
}: {
  db: Db;
  folder: Folder;
  today: string;
  open: boolean;
  onToggle: () => void;
  onOpenItem: (id: string) => void;
  onRestore: () => void;
  onPurge: () => void;
}) {
  const parent = folderTrail(db, folder.parentId);
  const parentText =
    parent.length > 0 ? parent.map((entry) => entry.name).join(" / ") : "Domů";
  const parentGone = parent.some((entry) => entry.isDeleted);
  const parentHref =
    parent.length === 0 || parentGone
      ? null
      : parent[parent.length - 1]?.system === "inbox"
      ? "/inbox"
      : `/folder/${parent[parent.length - 1]?.id}`;
  const inside = db.items.filter(
    (item) => item.isDeleted && item.folderId === folder.id
  );
  const when = deletedWhen(folder.updatedAt, today);
  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? (
            <ChevronDown size={16} className="mt-1 shrink-0 text-muted" />
          ) : (
            <ChevronRight size={16} className="mt-1 shrink-0 text-muted" />
          )}
          <span className="min-w-0">
            <span className="block truncate font-medium">{folder.name}</span>
            <span className="mt-0.5 block truncate text-sm text-muted">
              Složka · {parentText}
              {when ? ` · ${when}` : ""}
            </span>
          </span>
        </button>
        <span className="flex shrink-0 gap-1">
          <Button onClick={onRestore}>Obnovit</Button>
          <Button tone="danger" onClick={onPurge}>
            Smazat
          </Button>
        </span>
      </div>
      {open && (
        <dl className="mt-3 ml-6 grid gap-1.5 text-sm">
          <TrashFact label="Druh">Složka</TrashFact>
          <TrashFact label="Byla v">
            {parentHref ? (
              <Link
                href={parentHref}
                className="underline decoration-line underline-offset-2"
              >
                {parentText}
              </Link>
            ) : (
              parentText
            )}
          </TrashFact>
          <TrashFact label="Uvnitř">
            {inside.length === 0 ? (
              <span className="text-muted">Žádné smazané položky.</span>
            ) : (
              <span className="grid gap-1">
                {inside.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="truncate text-left underline decoration-line underline-offset-2"
                    onClick={() => onOpenItem(item.id)}
                  >
                    {item.title.trim() || "Bez názvu"}
                  </button>
                ))}
              </span>
            )}
          </TrashFact>
          {when && <TrashFact label="Smazáno">{when}</TrashFact>}
        </dl>
      )}
    </div>
  );
}

function TrashFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function trashPlace(
  db: Db,
  folderId: string
): {
  text: string;
  gone: boolean;
  href: string | null;
} {
  const trail = folderTrail(db, folderId);
  const folder = trail[trail.length - 1];
  if (!folder) return { text: "Neznámá složka", gone: true, href: null };
  const gone = trail.some((entry) => entry.isDeleted);
  return {
    text: trail.map((entry) => entry.name).join(" / "),
    gone,
    href: gone
      ? null
      : folder.system === "inbox"
      ? "/inbox"
      : `/folder/${folder.id}`,
  };
}

function deletedWhen(at: string, today: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const day = formatDay(dateKey(date), today);
  const time = date.toLocaleTimeString("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day.charAt(0).toLocaleUpperCase("cs")}${day.slice(1)} ${time}`;
}

function tagSwatch(color: string | null) {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#767676";
}

function TagColor({ tag }: { tag: Tag }) {
  const paint = (color: FolderPaint | null) =>
    dispatch({ type: "updateTag", id: tag.id, color });
  const custom = Boolean(tag.color && !isPaletteColor(tag.color));
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {FOLDER_COLOR_ORDER.map((value) => (
        <button
          key={value}
          type="button"
          aria-label={FOLDER_COLOR_LABELS[value]}
          aria-pressed={tag.color === value}
          title={FOLDER_COLOR_LABELS[value]}
          className={cx(
            "size-6 rounded-full",
            tag.color === value &&
              "outline outline-2 outline-offset-2 outline-ink"
          )}
          style={{ background: `var(--${value})` }}
          onClick={() => paint(tag.color === value ? null : value)}
        />
      ))}
      <input
        type="color"
        aria-label="Vlastní barva"
        title="Vlastní barva"
        className={cx(
          "h-7 w-10 cursor-pointer rounded-md border border-line bg-transparent p-0.5",
          "[&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0",
          custom && "outline outline-2 outline-offset-2 outline-ink"
        )}
        value={tagSwatch(tag.color)}
        onChange={(event) => {
          const next = event.target.value;
          if (/^#[0-9a-fA-F]{6}$/.test(next))
            paint(next.toLowerCase() as FolderPaint);
        }}
      />
    </div>
  );
}

export function TagPage() {
  const params = useParams<{ id: string }>();
  const { db } = useSnap();
  const tag = byId(db.tags, params.id ?? null);
  if (!tag || tag.isDeleted) return <p>Štítek tu není.</p>;
  const items = tagItems(db, tag.id);
  return (
    <div>
      <h1 className="mb-3 font-display text-3xl">
        <TagMark name={tag.name} color={tag.color} dotClassName="size-4" />
      </h1>
      <TagColor tag={tag} />
      {items.length === 0 ? (
        <p className="text-sm text-muted">Pod tímhle štítkem nic není.</p>
      ) : (
        <ItemList items={items} showFolder />
      )}
    </div>
  );
}

export function ViewPage() {
  const params = useParams<{ id: string }>();
  const { db } = useSnap();
  const view = db.savedViews.find(
    (entry) => entry.id === params.id && !entry.isDeleted
  );
  if (!view) return <p>Pohled tu není.</p>;
  const items = applyQuery(db, view.query);
  return (
    <div>
      <h1 className="mb-4 font-display text-3xl">{view.name}</h1>
      <ItemList items={items} showFolder />
    </div>
  );
}

export function SearchDialog() {
  const ui = useUi();
  if (!ui.searchOpen) return null;
  return <SearchPanel />;
}

function SearchPanel() {
  const { db } = useSnap();
  const ui = useUi();
  const [, setLocation] = useLocation();
  const panel = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  const needle = text.trim().toLocaleLowerCase("cs");
  const folders = needle
    ? db.folders
        .filter(
          (folder) =>
            !folder.isDeleted &&
            folder.name.toLocaleLowerCase("cs").includes(needle)
        )
        .slice(0, 6)
    : [];
  const tags = searchTags(db, text);
  const items = searchItems(db, text);
  const hits = [
    ...folders.map((folder) => ({
      kind: "folder" as const,
      id: folder.id,
      label: folderTrail(db, folder.id)
        .map((part) => part.name)
        .join(" / "),
      href: folder.system === "inbox" ? "/inbox" : `/folder/${folder.id}`,
    })),
    ...tags.map((tag) => ({
      kind: "tag" as const,
      id: tag.id,
      name: tag.name,
      color: tag.color,
      label: `#${tag.name}`,
      href: `/tag/${tag.id}`,
    })),
    ...items.map((item) => ({
      kind: "item" as const,
      id: item.id,
      label: item.title,
      priority: item.priority,
      href: "",
    })),
  ];
  const active = hits.length === 0 ? 0 : Math.min(index, hits.length - 1);
  const openHit = (hit: (typeof hits)[number]) => {
    if (hit.kind === "item") ui.setSelected(hit.id);
    else {
      setLocation(hit.href);
      ui.select(null);
    }
    ui.setMenuOpen(false);
    ui.setSearchOpen(false);
  };
  useLayer((event) => {
    trapTab(event, panel.current);
    if (event.key === "Escape") {
      event.preventDefault();
      ui.setSearchOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const last = hits.length - 1;
      if (last < 0) return;
      setIndex((current) => {
        const from = Math.min(current, last);
        return event.key === "ArrowDown"
          ? Math.min(last, from + 1)
          : Math.max(0, from - 1);
      });
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("a, button")) return;
    const hit = hits[active];
    if (!hit) return;
    event.preventDefault();
    openHit(hit);
  });
  useEffect(() => {
    document
      .getElementById(`search-hit-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, text]);
  return (
    <div
      className="fixed inset-0 z-50 bg-ink/15 p-4"
      onMouseDown={() => ui.setSearchOpen(false)}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Hledat"
        className="mx-auto max-w-lg rounded-lg bg-raised p-4 outline-none"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          className="w-full bg-transparent py-2 text-lg outline-none"
          placeholder="Hledat"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setIndex(0);
          }}
        />
        <div className="max-h-80 overflow-y-auto" role="listbox">
          {hits.length === 0 && needle && (
            <p className="px-2 py-3 text-sm text-muted">Nic nenalezeno.</p>
          )}
          {hits.map((hit, hitIndex) =>
            hit.kind === "folder" || hit.kind === "tag" ? (
              <Link
                key={`${hit.kind}-${hit.id}`}
                id={`search-hit-${hitIndex}`}
                href={hit.href}
                role="option"
                aria-selected={hitIndex === active}
                className={cx(
                  "flex items-center gap-2 px-2 py-2",
                  hoverRow,
                  hitIndex === active && "bg-accent-soft text-accent"
                )}
                onMouseEnter={() => setIndex(hitIndex)}
                onClick={() => {
                  ui.select(null);
                  ui.setMenuOpen(false);
                  ui.setSearchOpen(false);
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {hit.kind === "tag" ? (
                    <TagMark name={hit.name} color={hit.color} />
                  ) : (
                    hit.label
                  )}
                </span>
                <OpenMark />
              </Link>
            ) : (
              <button
                key={`item-${hit.id}`}
                id={`search-hit-${hitIndex}`}
                type="button"
                role="option"
                aria-selected={hitIndex === active}
                className={cx(
                  "flex w-full items-center gap-2 px-2 py-2 text-left",
                  hoverRow,
                  hitIndex === active && "bg-accent-soft text-accent"
                )}
                onMouseEnter={() => setIndex(hitIndex)}
                onClick={() => openHit(hit)}
              >
                <PriorityMark priority={hit.priority} />
                <span className="min-w-0 flex-1 truncate">{hit.label}</span>
                <OpenMark />
              </button>
            )
          )}
        </div>
        <p className="mt-2 text-xs text-muted">
          Šipky vyberou, Enter otevře, Escape zavře
        </p>
      </div>
    </div>
  );
}
