import { useDroppable } from "@dnd-kit/core";
import {
  Calendar,
  Clock,
  House,
  Menu,
  MoreHorizontal,
  Plus,
  Redo2,
  Search,
  Settings,
  Sun,
  Trash2,
  Undo2,
  Users,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Link, Redirect, Route, Switch, useLocation, useParams } from "wouter";
import { dispatch, redo, undo, useSnap } from "../data/store.tsx";
import { getSyncView, subscribeSync } from "../data/sync.ts";
import { alive, byId, resolvedClosed, resolvedOpen } from "../domain/db.ts";
import { mapStatus, visibleItems } from "../domain/select.ts";
import { ActivityPage, openLinkedItem } from "./activity.tsx";
import { CalendarBoard } from "./calendar.tsx";
import { GanttBoard } from "./gantt.tsx";
import { Detail } from "./detail.tsx";
import { DragLayer } from "./dnd.tsx";
import { revertLast, undoDraftFolder, useDraftFolder } from "./draftFolder.ts";
import { FolderPicker } from "./folderPick.tsx";
import { GcalNotices, GcalReturn } from "./gcal.tsx";
import { FolderDialog, FolderTree, RootDrop } from "./folders.tsx";
import { GuidePage } from "./guide.tsx";
import { placeMany } from "./move.ts";
import {
  Capture,
  FolderPage,
  HomePage,
  InboxPage,
  SearchDialog,
  TagPage,
  TodayPage,
  TrashPage,
  ViewPage,
} from "./pages.tsx";
import { PeoplePage, PersonPage } from "./people.tsx";
import { QuickAdd } from "./quick.tsx";
import { SettingsPage } from "./settings.tsx";
import { useUi } from "./state.tsx";
import {
  deleteItems,
  indentListedTask,
  toggleComplete,
  visibleTaskIds,
} from "./tasks.tsx";
import { ThemeSync } from "./theme.tsx";
import {
  Button,
  cx,
  Dialog,
  IconButton,
  layerOpen,
  modLabel,
  TagMark,
} from "./ui.tsx";
import { jumpWordInField, wordJumpTarget } from "./wordCaret.ts";

export function Shell() {
  return (
    <DragLayer>
      <ThemeSync />
      <Frame />
    </DragLayer>
  );
}

const SIDEBAR_KEY = "ukoly-sidebar";
const SIDEBAR_DEFAULT = 288;
const SIDEBAR_MIN = 216;
const SIDEBAR_MAX = 448;

function clampSidebar(width: number) {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

function readSidebarWidth() {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_KEY));
    if (Number.isFinite(value) && value > 0) return clampSidebar(value);
  } catch {
    /* úložiště nemusí být dostupné */
  }
  return SIDEBAR_DEFAULT;
}

function useSidebarWidth() {
  const [width, setWidth] = useState(readSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const commit = (next: number) => {
    widthRef.current = next;
    setWidth(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(next));
    } catch {
      /* volba platí aspoň do obnovení stránky */
    }
  };
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      const next = clampSidebar(
        drag.current.w + event.clientX - drag.current.x
      );
      widthRef.current = next;
      setWidth(next);
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      commit(widthRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag.current = { x: event.clientX, w: widthRef.current };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 32 : 16;
    commit(
      clampSidebar(
        widthRef.current + (event.key === "ArrowRight" ? step : -step)
      )
    );
  };
  return { width, dragging, onPointerDown, onKeyDown };
}

function SidebarEdge({
  width,
  dragging,
  onPointerDown,
  onKeyDown,
}: {
  width: number;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Šířka postranního panelu"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      className="group/edge absolute inset-y-0 z-30 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none lg:block"
      style={{ left: width }}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span
        className={cx(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2",
          dragging ? "bg-accent" : "bg-transparent group-hover/edge:bg-accent"
        )}
      />
    </div>
  );
}

function useOnline() {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine,
    () => true
  );
}

function SyncNote() {
  const online = useOnline();
  const sync = useSyncExternalStore(subscribeSync, getSyncView, getSyncView);
  if (!sync.enabled) return null;
  const offline = !online || sync.phase === "offline";
  if (!offline && sync.phase !== "error") return null;
  return (
    <p
      className="mb-4 rounded-md bg-black/[0.04] px-3 py-2 text-sm text-muted dark:bg-white/[0.06]"
      role="status"
    >
      {offline
        ? "Bez spojení. Úpravy zůstanou v tomhle zařízení a synchronizují se, až se spojení vrátí."
        : sync.detail ??
          "Synchronizace se nepovedla. Úpravy jsou uložené v tomhle zařízení."}
    </p>
  );
}

function Frame() {
  const snap = useSnap();
  const ui = useUi();
  const [location, setLocation] = useLocation();
  const sidebar = useSidebarWidth();
  const selected =
    ui.picked.length > 0 ? null : byId(snap.db.items, ui.selectedId);
  const glance = ui.glance;
  const focusId = ui.focusId;
  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string" && id)
        openLinkedItem(snap.db, id, ui, setLocation);
    };
    document.addEventListener("ordo-open-item", onOpen);
    return () => document.removeEventListener("ordo-open-item", onOpen);
  }, [snap.db, ui, setLocation]);
  useEffect(() => {
    if (!glance) return;
    const folder = byId(snap.db.folders, glance.folderId);
    const here =
      folder?.system === "inbox"
        ? location === "/inbox"
        : location === `/folder/${glance.folderId}`;
    if (!folder || !here) ui.setGlance(null);
  }, [location, glance, ui.setGlance, snap.db.folders]);
  useEffect(() => {
    if (!focusId) return;
    const id = CSS.escape(focusId);
    const frame = requestAnimationFrame(() => {
      const node = document.querySelector(
        `[data-note-id="${id}"], [data-task-id="${id}"]`
      );
      if (node instanceof HTMLElement) node.scrollIntoView({ block: "center" });
    });
    const timer = window.setTimeout(() => ui.setFocusId(null), 1800);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [focusId, location, ui.setFocusId]);

  return (
    <div
      className="relative min-h-dvh lg:grid lg:h-dvh lg:grid-cols-[var(--sidebar)_minmax(0,1fr)] lg:overflow-hidden"
      style={{ "--sidebar": `${sidebar.width}px` } as CSSProperties}
    >
      <Hotkeys />
      <aside className="hidden min-w-0 border-r border-line bg-panel lg:block lg:h-full lg:min-h-0 lg:overflow-hidden">
        <Sidebar />
      </aside>
      <SidebarEdge
        width={sidebar.width}
        dragging={sidebar.dragging}
        onPointerDown={sidebar.onPointerDown}
        onKeyDown={sidebar.onKeyDown}
      />
      {ui.menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/30 lg:hidden"
          onMouseDown={() => ui.setMenuOpen(false)}
        >
          <div
            className="h-full w-[min(20rem,88vw)] bg-panel"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Sidebar />
          </div>
        </div>
      )}
      <div className="min-w-0 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:overflow-hidden">
        <main className="min-w-0 px-4 pb-24 pt-5 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-y-auto lg:px-8 lg:pt-6">
          {(snap.memoryOnly || snap.persistError) && (
            <p className="mb-4 rounded-md bg-warn/15 px-3 py-2 text-sm">
              {snap.memoryOnly
                ? "Prohlížeč data neukládá. Po zavření zmizí."
                : `Uložení selhalo: ${snap.persistError}`}
            </p>
          )}
          <SyncNote />
          <div className="mb-4 flex items-center gap-1 lg:hidden">
            <IconButton label="Menu" onClick={() => ui.setMenuOpen(true)}>
              <Menu size={20} />
            </IconButton>
            <p className="font-display text-xl leading-none text-ink">Ordo</p>
            <HistoryMenu />
            <span className="ml-auto flex items-center gap-1">
              <IconButton
                label={`Hledat (${modLabel}K)`}
                onClick={() => ui.setSearchOpen(true)}
              >
                <Search size={18} />
              </IconButton>
            </span>
          </div>
          <div className="mb-6 hidden items-center justify-end gap-2 lg:flex">
            <IconButton
              label={`Hledat (${modLabel}K)`}
              onClick={() => ui.setSearchOpen(true)}
            >
              <Search size={18} />
            </IconButton>
            <Button
              tone="solid"
              title="Přidat úkol (mezerník)"
              onClick={() =>
                ui.openQuick({ folderId: folderFromLocation(location) })
              }
            >
              <Plus size={16} /> Přidat úkol
            </Button>
          </div>
          {ui.picked.length > 0 && <BulkBar />}
          <Capture />
          <GcalReturn />
          <GcalNotices />
          <Switch>
            <Route path="/" component={HomePage} />
            <Route path="/today" component={TodayPage} />
            <Route path="/ready">
              <Redirect href="/today" />
            </Route>
            <Route path="/inbox" component={InboxPage} />
            <Route path="/folder/:id" component={FolderPage} />
            <Route path="/tag/:id" component={TagPage} />
            <Route path="/people" component={PeoplePage} />
            <Route path="/people/:id" component={PersonRoute} />
            <Route path="/calendar" component={CalendarRoute} />
            <Route path="/add" component={AddRoute} />
            <Route path="/aktivita" component={ActivityPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/pruvodce" component={GuidePage} />
            <Route path="/trash" component={TrashPage} />
            <Route path="/view/:id" component={ViewPage} />
            <Route>
              <Redirect href="/" />
            </Route>
          </Switch>
        </main>
        {selected && <Detail item={selected} />}
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-raised pb-[env(safe-area-inset-bottom)] lg:hidden">
        <Tab href="/" label="Domů" icon={<House size={18} />} />
        <button
          type="button"
          className="grid flex-1 place-items-center py-2 text-accent"
          title="Přidat (mezerník)"
          onClick={() =>
            ui.openQuick({ folderId: folderFromLocation(location) })
          }
        >
          <Plus size={22} />
          <span className="text-xs">Přidat</span>
        </button>
        <button
          type="button"
          className="grid flex-1 place-items-center py-2 text-xs text-muted"
          onClick={() => ui.setMenuOpen(true)}
        >
          <Menu size={18} />
          Menu
        </button>
      </nav>
      {ui.quick && <QuickAdd />}
      <SearchDialog />
      <FolderDialog />
      {ui.confirm && <ConfirmDialog />}
      {ui.choice && (
        <ChoiceDialog
          key={`${ui.choice.title}:${ui.choice.options
            .map((option) => option.id)
            .join(":")}`}
        />
      )}
      <div className="fixed bottom-20 left-1/2 z-50 flex w-[min(24rem,92vw)] -translate-x-1/2 flex-col gap-2 lg:bottom-4">
        {ui.toasts.map((toast) => (
          <div
            key={toast.id}
            className="flex items-center justify-between gap-3 rounded-md bg-ink px-4 py-2 text-sm text-bg"
          >
            <span>{toast.text}</span>
            {toast.undo && (
              <button type="button" data-history-undo onClick={revertLast}>
                {toast.action ?? "Vrátit"}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const editedFields = new WeakSet<EventTarget>();

function textEdited(target: EventTarget | null) {
  return target !== null && editedFields.has(target);
}

function Hotkeys() {
  const snap = useSnap();
  const ui = useUi();
  const [location] = useLocation();
  useEffect(() => {
    const mark = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLTextAreaElement) editedFields.add(target);
      else if (
        target instanceof HTMLInputElement &&
        (target.type === "text" || target.type === "search")
      )
        editedFields.add(target);
      else if (target instanceof HTMLElement && target.isContentEditable)
        editedFields.add(target);
    };
    const clear = (event: Event) => {
      if (event.target) editedFields.delete(event.target);
    };
    document.addEventListener("input", mark);
    document.addEventListener("focusin", clear);
    return () => {
      document.removeEventListener("input", mark);
      document.removeEventListener("focusin", clear);
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = Boolean(
        target?.closest("input, textarea, select, [contenteditable='true']")
      );
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        if (layerOpen()) return;
        if (ui.menuOpen) {
          event.preventDefault();
          ui.setMenuOpen(false);
          return;
        }
        if (typing) {
          target?.blur();
          return;
        }
        if (ui.picked.length > 0) {
          event.preventDefault();
          ui.setSelected(null);
          return;
        }
        if (ui.selectedId) {
          event.preventDefault();
          ui.setSelected(null);
        }
        return;
      }
      if (
        event.altKey &&
        !mod &&
        !event.shiftKey &&
        event.code === "KeyH" &&
        !event.repeat
      ) {
        event.preventDefault();
        const next = !ui.showHidden;
        ui.setShowHidden(next);
        ui.pushToast(
          next ? "Skryté složky jsou vidět" : "Skryté složky jsou schované"
        );
        return;
      }
      if (mod && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (ui.quick || ui.folderEdit || ui.confirm || ui.choice) return;
        ui.setMenuOpen(false);
        ui.setSearchOpen(!ui.searchOpen);
        return;
      }
      if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z"
      ) {
        if (undoDraftFolder()) {
          event.preventDefault();
          return;
        }
        if (textEdited(target)) return;
        event.preventDefault();
        undo();
        return;
      }
      if (
        mod &&
        !event.altKey &&
        ((event.shiftKey && event.key.toLowerCase() === "z") ||
          (!event.shiftKey && event.key.toLowerCase() === "y"))
      ) {
        if (textEdited(target)) return;
        event.preventDefault();
        redo();
        return;
      }
      if (
        event.key === "Tab" &&
        !event.altKey &&
        !mod &&
        !layerOpen() &&
        !ui.menuOpen &&
        !target?.closest(
          "[data-task-composer], [data-detail], [data-task-body]"
        )
      ) {
        const row = target?.closest<HTMLElement>(
          "main [data-task-list] [data-task-id]"
        );
        const body =
          !target ||
          target === document.body ||
          target === document.documentElement;
        const id = row?.dataset.taskId ?? (body ? ui.selectedId : null);
        if (
          id &&
          byId(snap.db.items, id)?.type === "task" &&
          indentListedTask(snap.db, id, event.shiftKey)
        ) {
          event.preventDefault();
          return;
        }
      }
      if (
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !mod &&
        !layerOpen() &&
        !ui.menuOpen &&
        !target?.closest(
          "[data-task-composer], [data-task-body], [data-note-composer], textarea"
        )
      ) {
        const row = target?.closest<HTMLElement>(
          "main [data-task-list] [data-task-id]"
        );
        const fromOpenTask =
          Boolean(row) ||
          !typing ||
          Boolean(target?.closest("[data-detail-title]"));
        const id = row?.dataset.taskId ?? (fromOpenTask ? ui.selectedId : null);
        if (id && byId(snap.db.items, id)?.type === "task" && taskListed(id)) {
          event.preventDefault();
          ui.editBody(id);
          return;
        }
      }
      if (layerOpen() || typing || ui.menuOpen || event.altKey || mod) return;
      const control = Boolean(target?.closest("button, a, summary"));
      if (event.key === " " && !event.repeat && !control) {
        event.preventDefault();
        ui.openQuick({ folderId: folderFromLocation(location) });
        return;
      }
      if (event.key.toLowerCase() === "n" && !event.repeat) {
        event.preventDefault();
        ui.openQuick({ folderId: folderFromLocation(location) });
        return;
      }
      const inDetail = Boolean(target?.closest("[data-detail]"));
      if (!inDetail && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        moveSelection(
          ui.selectedId,
          event.key === "ArrowDown" ? 1 : -1,
          ui.setSelected
        );
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !control && !inDetail) {
        const row = target?.closest<HTMLElement>("main [data-task-id]");
        const id = row?.dataset.taskId ?? ui.selectedId;
        if (!id) return;
        event.preventDefault();
        if (ui.selectedId !== id) {
          ui.setSelected(id);
          scrollTask(id);
          return;
        }
        document.querySelector<HTMLElement>("[data-detail-title]")?.focus();
        return;
      }
      if (!inDetail && event.key.toLowerCase() === "x" && !event.repeat) {
        const item = byId(snap.db.items, ui.selectedId);
        if (!item || item.type !== "task") return;
        event.preventDefault();
        toggleComplete(snap.db, item, ui.askConfirm);
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        !event.repeat
      ) {
        const focused =
          target?.closest<HTMLElement>("[data-task-id]")?.dataset.taskId;
        const ids =
          ui.picked.length > 0
            ? ui.picked
            : ui.selectedId
            ? [ui.selectedId]
            : focused
            ? [focused]
            : [];
        const items = ids.flatMap((id) => {
          const item = byId(snap.db.items, id);
          return item && !item.isDeleted ? [item] : [];
        });
        if (items.length === 0) return;
        event.preventDefault();
        deleteItems(items, ui.pushToast, () => {
          if (items.some((item) => item.id === ui.selectedId))
            ui.setSelected(null);
          if (ui.picked.length > 0) ui.clearPicked();
        });
      }
    };
    const onWord = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const field = wordJumpTarget(event.target);
      if (!field) return;
      event.preventDefault();
      event.stopPropagation();
      jumpWordInField(
        field,
        event.key === "ArrowRight" ? 1 : -1,
        event.shiftKey
      );
    };
    window.addEventListener("keydown", onWord, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onWord, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ui, location, snap]);
  return null;
}

function taskListed(id: string) {
  return [
    ...document.querySelectorAll<HTMLElement>(
      "[data-task-list] [data-task-id]"
    ),
  ].some((el) => el.dataset.taskId === id && el.getClientRects().length > 0);
}

function scrollTask(id: string) {
  document
    .querySelector<HTMLElement>(`main [data-task-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

function moveSelection(
  current: string | null,
  delta: number,
  select: (id: string) => void
) {
  const ids = visibleTaskIds();
  if (ids.length === 0) return;
  const index = current ? ids.indexOf(current) : -1;
  const next =
    index === -1
      ? delta > 0
        ? ids[0]
        : ids[ids.length - 1]
      : ids[Math.max(0, Math.min(ids.length - 1, index + delta))];
  if (!next) return;
  select(next);
  scrollTask(next);
}

function ConfirmDialog() {
  const ui = useUi();
  const confirm = ui.confirm;
  if (!confirm) return null;
  const run = (action: (() => void) | undefined) => {
    action?.();
    ui.closeConfirm();
  };
  return (
    <Dialog
      title={confirm.title}
      onClose={ui.closeConfirm}
      onConfirm={() => run(confirm.onConfirm)}
    >
      <p className="mb-4 text-sm">{confirm.body}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          tone="solid"
          data-primary
          onClick={() => run(confirm.onConfirm)}
        >
          {confirm.confirm}
        </Button>
        {confirm.alt && (
          <Button onClick={() => run(confirm.onAlt)}>{confirm.alt}</Button>
        )}
      </div>
    </Dialog>
  );
}

function ChoiceDialog() {
  const ui = useUi();
  const choice = ui.choice;
  const [index, setIndex] = useState(0);
  useEffect(() => {
    document.getElementById(`choice-option-${index}`)?.focus();
  }, [index, choice]);
  if (!choice) return null;
  const pick = (id: string) => {
    choice.onPick(id);
    ui.closeChoice();
  };
  return (
    <Dialog
      title={choice.title}
      onClose={ui.closeChoice}
      onConfirm={() => {
        const option = choice.options[index];
        if (option) pick(option.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const last = choice.options.length - 1;
          setIndex((current) =>
            event.key === "ArrowDown"
              ? Math.min(last, current + 1)
              : Math.max(0, current - 1)
          );
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
        event.preventDefault();
        const option = choice.options[index];
        if (option) pick(option.id);
      }}
    >
      <div className="grid gap-2">
        {choice.options.map((option, optionIndex) => (
          <Button
            key={option.id}
            id={`choice-option-${optionIndex}`}
            tone={optionIndex === index ? "soft" : "ghost"}
            onFocus={() => setIndex(optionIndex)}
            onClick={() => pick(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </Dialog>
  );
}

function folderFromLocation(location: string): string | null {
  const match = location.match(/^\/folder\/([^/]+)/);
  return match?.[1] ?? null;
}

function PersonRoute() {
  const params = useParams<{ id: string }>();
  if (!params.id) return null;
  return <PersonPage personId={params.id} />;
}

function AddRoute() {
  return <p className="text-sm text-muted">Přidávám…</p>;
}

const CALENDAR_LAYOUT_KEY = "ordo.calendarLayout";

function readCalendarLayout(): "month" | "gantt" {
  try {
    return localStorage.getItem(CALENDAR_LAYOUT_KEY) === "gantt"
      ? "gantt"
      : "month";
  } catch {
    return "month";
  }
}

function CalendarRoute() {
  const { db } = useSnap();
  const [layout, setLayout] = useState(readCalendarLayout);
  const choose = (next: "month" | "gantt") => {
    setLayout(next);
    try {
      localStorage.setItem(CALENDAR_LAYOUT_KEY, next);
    } catch {
      // Remembering the layout is only a convenience.
    }
  };
  const items = db.items.filter(
    (item) => !item.isDeleted && item.type === "task"
  );
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-3xl">Kalendář</h1>
        <div
          className="flex items-center gap-0.5 rounded-lg bg-black/5 p-0.5 dark:bg-white/10"
          role="group"
          aria-label="Pohled"
        >
          {(
            [
              ["month", "Měsíc"],
              ["gantt", "Časová osa"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={layout === value}
              className={cx(
                "rounded-md px-2.5 py-1 text-sm whitespace-nowrap",
                layout === value
                  ? "bg-raised text-ink! shadow-[var(--shadow)]"
                  : "text-muted! hover:text-ink!"
              )}
              onClick={() => choose(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {layout === "gantt" ? (
        <GanttBoard items={visibleItems(db).filter((item) => item.type === "task")} global />
      ) : (
        <CalendarBoard items={items} external />
      )}
    </div>
  );
}

function setPickedClosed(
  db: Parameters<typeof placeMany>[0],
  ids: string[],
  done: boolean,
  clear: () => void
) {
  const groups = new Map<
    string,
    { folderId: string; statusId: string; ids: string[] }
  >();
  for (const id of ids) {
    const item = byId(db.items, id);
    if (!item || item.type !== "task") continue;
    const folder = byId(db.folders, item.folderId);
    if (!folder) continue;
    const target = done ? resolvedClosed(db, folder) : resolvedOpen(db, folder);
    if (!target || item.statusId === target.id) continue;
    const key = `${folder.id}:${target.id}`;
    const group = groups.get(key) ?? {
      folderId: folder.id,
      statusId: target.id,
      ids: [],
    };
    group.ids.push(id);
    groups.set(key, group);
  }
  const ops = [...groups.values()].flatMap((group) =>
    placeMany(db, group.ids, group.folderId, group.statusId)
  );
  const op =
    ops.length === 1
      ? ops[0]
      : ops.length > 1
      ? { type: "batch" as const, ops }
      : null;
  if (!op) return;
  dispatch(op);
  clear();
}

function BulkBar() {
  const { db } = useSnap();
  const ui = useUi();
  const [moving, setMoving] = useState(false);
  const move = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moving) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && move.current?.contains(event.target))
        return;
      setMoving(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [moving]);
  const moveTo = (folderId: string) => {
    const groups = new Map<string, string[]>();
    for (const id of ui.picked) {
      const item = byId(db.items, id);
      if (!item) continue;
      const mapped = mapStatus(db, item.statusId, folderId);
      const statusId = mapped.statusId ?? mapped.choices[0]?.id;
      if (!statusId) continue;
      groups.set(statusId, [...(groups.get(statusId) ?? []), id]);
    }
    const ops = [...groups].flatMap(([statusId, ids]) =>
      placeMany(db, ids, folderId, statusId)
    );
    if (ops.length > 0) dispatch({ type: "batch", ops });
    ui.clearPicked();
    setMoving(false);
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
      <span className="text-sm">{ui.picked.length} vybraných</span>
      <Button onClick={() => ui.setSelected(null)}>Zrušit</Button>
      <Button
        tone="soft"
        onClick={() => setPickedClosed(db, ui.picked, true, ui.clearPicked)}
      >
        Hotovo
      </Button>
      <Button
        onClick={() => setPickedClosed(db, ui.picked, false, ui.clearPicked)}
      >
        Otevřít
      </Button>
      <Button
        tone="danger"
        onClick={() => {
          const items = ui.picked.flatMap((id) => {
            const item = byId(db.items, id);
            return item ? [item] : [];
          });
          deleteItems(items, ui.pushToast, () => ui.clearPicked());
        }}
      >
        Smazat
      </Button>
      <div ref={move} className="relative">
        <Button
          aria-expanded={moving}
          onClick={() => setMoving((open) => !open)}
        >
          Přesunout do…
        </Button>
        {moving && (
          <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-line bg-raised p-2 shadow-[var(--shadow)]">
            <FolderPicker
              value={null}
              onPick={(folderId) => {
                if (folderId) moveTo(folderId);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryMenu() {
  const { past, future } = useSnap();
  const draft = useDraftFolder();
  const canUndo = past.length > 0 || draft;
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !ref.current?.contains(event.target)
      )
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const run = (action: () => void, enabled: boolean) => {
    if (!enabled) return;
    setOpen(false);
    action();
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Akce"
        aria-expanded={open}
        aria-haspopup="menu"
        data-history-undo=""
        className="grid size-8 place-items-center rounded-md text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
        onClick={() => {
          const rect = ref.current?.getBoundingClientRect();
          if (rect) setPlace({ top: rect.bottom + 4, left: rect.left });
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          role="menu"
          data-history-undo=""
          className="fixed z-50 min-w-36 rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow)]"
          style={{ top: place.top, left: place.left }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!canUndo}
            data-history-undo=""
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-black/5 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/10 dark:disabled:hover:bg-transparent"
            onClick={() => run(revertLast, canUndo)}
          >
            <Undo2 size={16} />
            Zpět
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={future.length === 0}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-black/5 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/10 dark:disabled:hover:bg-transparent"
            onClick={() => run(redo, future.length > 0)}
          >
            <Redo2 size={16} />
            Znovu
          </button>
        </div>
      )}
    </div>
  );
}

function Sidebar() {
  const { db } = useSnap();
  const ui = useUi();
  const tags = alive(db.tags);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-x-auto overflow-y-auto py-4">
      <div className="flex items-center gap-1 px-7">
        <p className="font-display text-3xl leading-none text-ink">Ordo</p>
        <HistoryMenu />
      </div>
      <div className="mt-5 grid min-w-full gap-0.5 [&>*]:min-w-0">
        <Side href="/" label="Domů" icon={<House size={18} />} tree />
        <FolderTree />
        <RootDrop />
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-md py-2 pr-0.5 pl-1 text-sm text-muted! hover:bg-black/5 hover:text-ink! dark:hover:bg-white/10"
          onClick={() => ui.setFolderEdit({ id: null, parentId: null })}
        >
          <span className="size-5 shrink-0" />
          <span className="grid size-6 place-items-center">
            <Plus size={16} />
          </span>
          Nová složka
        </button>
      </div>
      <div className="mt-auto grid gap-5 pt-8">
        <nav className="grid gap-1 px-4">
          <Side href="/today" label="Dnes" icon={<Sun size={18} />} />
          <Side
            href="/calendar"
            label="Kalendář"
            icon={<Calendar size={18} />}
          />
          <Side href="/people" label="Lidé" icon={<Users size={18} />} />
          <Side href="/aktivita" label="Aktivita" icon={<Clock size={18} />} />
        </nav>
        {tags.length > 0 && (
          <div className="grid gap-1 px-4">
            <p className="px-2 text-xs text-muted">Štítky</p>
            {tags.map((tag) => (
              <TagChip
                key={tag.id}
                id={tag.id}
                name={tag.name}
                color={tag.color}
              />
            ))}
          </div>
        )}
        <nav className="grid gap-1 px-4">
          <Side
            href="/settings"
            label="Nastavení"
            icon={<Settings size={18} />}
          />
          <Side
            href="/trash"
            label="Koš"
            icon={<Trash2 size={18} />}
            dropId="trash"
          />
        </nav>
      </div>
    </div>
  );
}

function TagChip({
  id,
  name,
  color,
}: {
  id: string;
  name: string;
  color: string | null;
}) {
  const ui = useUi();
  const [location] = useLocation();
  const drop = useDroppable({ id: `tag:${id}` });
  const href = `/tag/${id}`;
  const active = location === href;
  return (
    <Link
      href={href}
      ref={drop.setNodeRef}
      className={cx(
        "rounded-md px-3 py-1 text-sm",
        drop.isOver && "bg-accent-soft text-accent",
        active
          ? "bg-accent-soft text-accent"
          : "hover:bg-black/5 dark:hover:bg-white/10"
      )}
      onClick={() => {
        ui.setMenuOpen(false);
        ui.select(null);
      }}
    >
      <TagMark name={name} color={color} />
      <span className="sr-only">
        , filtr položek. Přetažením úkolu se přidá.
      </span>
    </Link>
  );
}

function Side({
  href,
  label,
  icon,
  tree = false,
  dropId,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  tree?: boolean;
  dropId?: string;
}) {
  const ui = useUi();
  const [location] = useLocation();
  const drop = useDroppable({
    id: dropId ?? `nav:${href}`,
    disabled: dropId === undefined,
  });
  const active = location === href;
  const over = dropId !== undefined && drop.isOver;
  return (
    <Link
      href={href}
      ref={drop.setNodeRef}
      data-note-trash={dropId === "trash" ? "" : undefined}
      className={cx(
        "flex min-w-0 items-center rounded-md py-2",
        tree ? "gap-1.5 pr-0.5 pl-1" : "gap-3 px-3",
        over
          ? "bg-danger/10 text-danger"
          : active
          ? "bg-accent-soft text-accent"
          : "hover:bg-black/5 dark:hover:bg-white/10"
      )}
      onClick={() => {
        ui.setMenuOpen(false);
        ui.select(null);
      }}
    >
      {tree && <span className="size-5 shrink-0" />}
      {tree ? (
        <span className="grid size-6 shrink-0 place-items-center">{icon}</span>
      ) : (
        icon
      )}
      <span className="truncate">{label}</span>
    </Link>
  );
}

function Tab({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: ReactNode;
}) {
  const [location] = useLocation();
  const ui = useUi();
  return (
    <Link
      href={href}
      className={cx(
        "grid flex-1 place-items-center py-2 text-xs",
        location === href ? "text-accent" : "text-muted"
      )}
      onClick={() => ui.select(null)}
    >
      {icon}
      {label}
    </Link>
  );
}
