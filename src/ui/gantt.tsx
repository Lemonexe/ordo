import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { dispatch, getDb, useSnap } from "../data/store.tsx";
import { paintCss } from "../domain/color.ts";
import { addDays, dueTime, formatDay, isoWeekday, todayKey } from "../domain/dates.ts";
import {
  alive,
  byId,
  descendantFolderIds,
  inboxFolder,
  resolvedOpen,
  wouldDependencyCycle,
} from "../domain/db.ts";
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
  type GanttRow,
  type Span,
  type SpanEdit,
} from "../domain/gantt.ts";
import { opsFromTaskDraft } from "../domain/quickAdd.ts";
import { folderTrail, isChecked, isOpenItem } from "../domain/select.ts";
import type { Db, Item, Milestone } from "../domain/types.ts";
import { FolderGlyph } from "./folders.tsx";
import { PaintPicker, PersonBadge } from "./paint.tsx";
import { useUi } from "./state.tsx";
import { clickItem, itemMarked, toggleComplete } from "./tasks.tsx";
import { Button, control, cx, IconButton } from "./ui.tsx";

const ROW = 36;
const LANE = 24;
const HEAD = 44 + LANE;
const MIN_DAY = 4;
const MAX_DAY = 72;
const HOLD_MS = 280;
const ZOOM_KEY = "ordo.ganttDay";
const LABEL_KEY = "ordo.ganttLabel";
// Room under the last row, so the horizontal scrollbar does not cover it.
const FOOT = 20;
const KNOB = 12;

type Mods = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

type Drag =
  | {
      type: "edit";
      edit: SpanEdit;
      itemId: string;
      span: Span;
      x0: number;
      delta: number;
      moved: boolean;
    }
  | {
      type: "create";
      folderId: string;
      itemId: string | null;
      anchor: string;
      day: string;
      moved: boolean;
    }
  | {
      type: "milestone";
      id: string;
      day: string;
      x0: number;
      delta: number;
      moved: boolean;
    }
  | {
      type: "link";
      fromId: string;
      side: "start" | "end";
      x: number;
      y: number;
      targetId: string | null;
      moved: boolean;
    }
  | {
      type: "row";
      itemId: string;
      siblings: string[];
      beforeId: string | null;
      y0: number;
      moved: boolean;
    }
  | { type: "resize"; x0: number; w0: number; moved: boolean }
  | {
      type: "pan";
      x0: number;
      y0: number;
      left0: number;
      top0: number;
      moved: boolean;
    };

type Gesture = {
  pointerId: number;
  mouse: boolean;
  drag: Drag;
  active: boolean;
  x0: number;
  y0: number;
  timer: number | null;
  mods: Mods;
};

type Draft = {
  folderId: string;
  start: string;
  end: string;
};

function clampDay(value: number): number {
  return Math.min(MAX_DAY, Math.max(MIN_DAY, value));
}

function readZoom(): number {
  try {
    const value = Number(localStorage.getItem(ZOOM_KEY));
    return value >= MIN_DAY && value <= MAX_DAY ? value : 28;
  } catch {
    return 28;
  }
}

function writeZoom(value: number) {
  try {
    localStorage.setItem(ZOOM_KEY, String(Math.round(value * 10) / 10));
  } catch {
    // Zoom is a convenience; losing it is fine.
  }
}

function readLabel(): number | null {
  try {
    const value = Number(localStorage.getItem(LABEL_KEY));
    return value >= 100 && value <= 640 ? value : null;
  } catch {
    return null;
  }
}

function useLabelWidth(): [number, (value: number, save?: boolean) => void] {
  const query = "(min-width: 768px)";
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  const [custom, setCustom] = useState<number | null>(readLabel);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const max = wide ? 520 : Math.max(140, Math.round(window.innerWidth * 0.6));
  const width = Math.round(Math.min(max, Math.max(110, custom ?? (wide ? 232 : 136))));
  const set = (value: number, save = false) => {
    const next = Math.round(Math.min(max, Math.max(110, value)));
    setCustom(next);
    if (!save) return;
    try {
      localStorage.setItem(LABEL_KEY, String(next));
    } catch {
      // Width is a convenience; losing it is fine.
    }
  };
  return [width, set];
}

// A task takes its own color, else its folder's. A folder without a color
// leaves the bar neutral.
export function itemPaint(db: Db, item: Item): string {
  if (item.color) return paintCss(item.color);
  const folder = byId(db.folders, item.folderId);
  return folder?.color ? paintCss(folder.color) : "var(--muted)";
}

function milestonePaint(db: Db, row: Milestone): string {
  if (row.color) return paintCss(row.color);
  const folder = row.folderId ? byId(db.folders, row.folderId) : null;
  return folder?.color ? paintCss(folder.color) : "var(--muted)";
}

// A smooth connector that always leaves to the right and enters from the
// left, so the arrowhead points into the start of the follower.
function connector(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { path: string; head: string } {
  const gap = x2 - x1;
  const bend =
    gap >= 24
      ? Math.min(80, Math.max(12, gap / 2))
      : Math.min(120, 36 + Math.abs(gap) * 0.25);
  return {
    path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    head: `M ${x2 - 7} ${y2 - 4} L ${x2} ${y2} L ${x2 - 7} ${y2 + 4} Z`,
  };
}

// autoFocus would scroll the timeline to fit the field and the axis jumps.
function useFocusInPlace() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

function dayCount(count: number): string {
  if (count === 1) return "1 den";
  if (count >= 2 && count <= 4) return `${count} dny`;
  return `${count} dní`;
}

function quoted(items: Item[]): string {
  const names = items.slice(0, 3).map((item) => `„${item.title}“`);
  const rest = items.length - names.length;
  return rest > 0 ? `${names.join(", ")} a ${rest} další` : names.join(", ");
}

function spanLabel(span: Span, today: string): string {
  if (span.start === span.end) return formatDay(span.start, today);
  return `${formatDay(span.start, today)} – ${formatDay(span.end, today)} · ${dayCount(
    daysBetween(span.start, span.end) + 1
  )}`;
}

// Like spanLabel, but always with the length, even for a single day.
function dragLabel(span: Span, today: string): string {
  if (span.start !== span.end) return spanLabel(span, today);
  return `${formatDay(span.start, today)} · 1 den`;
}

function ordered(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

export function GanttBoard({
  items,
  folderId = null,
  global = false,
}: {
  items: Item[];
  folderId?: string | null;
  global?: boolean;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const today = todayKey();
  const [labelW, setLabelW] = useLabelWidth();
  const [dw, setDw] = useState(readZoom);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [trays, setTrays] = useState<Set<string>>(() => new Set());
  const [newMilestone, setNewMilestone] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const dwRef = useRef(dw);
  const anchor = useRef<{ base: string; index: number; offset: number } | null>(
    null
  );

  const ranks = useRef(new Map<string, number>());
  const open = (item: Item) => isOpenItem(db, item);
  const fallback = folderId ?? inboxFolder(db)?.id ?? null;
  const rows = ganttRows(db, items, {
    isOpen: open,
    trayOpen: (id) => trays.has(id) === global,
    fallbackFolderId: fallback,
    rank: (id) => ranks.current.get(id),
    scheduledOnly: global,
  });
  for (const row of rows)
    if (row.kind === "item" && row.span && !ranks.current.has(row.item.id))
      ranks.current.set(row.item.id, ranks.current.size);
  const rowOf = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind === "item") rowOf.set(row.item.id, index);
  });

  const milestones = milestonesFor(
    db,
    folderId ? new Set([folderId, ...descendantFolderIds(db, folderId)]) : null
  );
  const spans: Span[] = [
    ...rows.flatMap((row) => (row.kind === "item" && row.span ? [row.span] : [])),
    ...milestones.map((row) => ({ kind: "due" as const, start: row.day, end: row.day })),
  ];
  const computed = ganttRange(spans, today);
  const [floor, setFloor] = useState(computed.start);
  const [ceil, setCeil] = useState(computed.end);
  if (computed.start < floor) setFloor(computed.start);
  if (computed.end > ceil) setCeil(computed.end);
  const start = computed.start < floor ? computed.start : floor;
  const end = computed.end > ceil ? computed.end : ceil;
  const days = daysBetween(start, end) + 1;
  const trackW = days * dw;
  const x = (day: string) => daysBetween(start, day) * dw;

  const shown = (item: Item, span: Span | null): Span | null => {
    if (!span || drag?.type !== "edit" || drag.itemId !== item.id) return span;
    return editSpan(drag.span, drag.edit, drag.delta);
  };
  const leftEdge = (span: Span) => x(span.start);
  const rightEdge = (span: Span) => x(span.end) + dw;
  const milestoneDay = (row: Milestone) =>
    drag?.type === "milestone" && drag.id === row.id
      ? addDays(row.day, drag.delta)
      : row.day;

  // Keep the day under the pointer still while zooming, and the visible
  // days still when the axis grows to the left.
  const prevStart = useRef(start);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const pending = anchor.current;
    if (pending) {
      anchor.current = null;
      const index = pending.index + daysBetween(start, pending.base);
      el.scrollLeft = index * dw - pending.offset;
    } else if (prevStart.current !== start) {
      el.scrollLeft += daysBetween(start, prevStart.current) * dw;
    }
    prevStart.current = start;
  }, [start, dw]);

  // The axis always reaches past the right edge, however far out the zoom.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const needed = Math.ceil((el.clientWidth - labelW) / dw) + 28;
    if (days < needed)
      setCeil(addDays(end, Math.ceil((needed - days) / 7) * 7));
  }, [dw, days, end, labelW]);

  const scrollToToday = () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollLeft = x(today) - (el.clientWidth - labelW) * 0.2;
  };
  useLayoutEffect(() => {
    scrollToToday();
    // Only on mount; later the person decides where to look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => writeZoom(dw), 300);
    return () => window.clearTimeout(timer);
  }, [dw]);

  const zoomAt = (clientX: number, next: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const value = clampDay(next);
    const current = dwRef.current;
    if (Math.abs(value - current) < 0.01) return;
    const rect = el.getBoundingClientRect();
    const offset = Math.max(0, clientX - rect.left - labelW);
    if (anchor.current) anchor.current.offset = offset;
    else
      anchor.current = {
        base: start,
        index: (el.scrollLeft + offset) / current,
        offset,
      };
    dwRef.current = value;
    setDw(value);
  };
  const zoomCenter = (factor: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAt(rect.left + labelW + (rect.width - labelW) / 2, dwRef.current * factor);
  };

  const cancelGesture = () => {
    const current = gesture.current;
    if (!current) return;
    if (current.timer !== null) window.clearTimeout(current.timer);
    if (current.mouse) {
      try {
        scrollerRef.current?.releasePointerCapture(current.pointerId);
      } catch {
        // Already released.
      }
    }
    gesture.current = null;
    setDrag(null);
  };

  const live = useRef({ zoomAt, cancelGesture });
  live.current = { zoomAt, cancelGesture };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let pinch: { dist: number; dw: number } | null = null;
    let gestureScale = 1;
    const distance = (event: TouchEvent) => {
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!a || !b) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };
    const middle = (event: TouchEvent) => {
      const [a, b] = [event.touches[0], event.touches[1]];
      return a && b ? (a.clientX + b.clientX) / 2 : 0;
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // Trackpad pinches send small deltas, mouse wheels big steps of ~100.
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-event.deltaY * 0.01)));
      live.current.zoomAt(event.clientX, dwRef.current * factor);
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      live.current.cancelGesture();
      pinch = { dist: distance(event), dw: dwRef.current };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault();
        if (pinch.dist > 0)
          live.current.zoomAt(
            middle(event),
            (pinch.dw * distance(event)) / pinch.dist
          );
        return;
      }
      if (gesture.current?.active) event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    // Safari reports trackpad pinches as gesture events, not ctrl + wheel.
    type Pinch = Event & { scale: number; clientX: number };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureScale = 1;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const scale = (event as Pinch).scale;
      live.current.zoomAt(
        (event as Pinch).clientX,
        (dwRef.current * scale) / gestureScale
      );
      gestureScale = scale;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      live.current.cancelGesture();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drag !== null]);

  const body = () => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { left: (rect?.left ?? 0) + labelW, top: (rect?.top ?? 0) + HEAD };
  };
  const dayAt = (clientX: number) =>
    addDays(start, Math.floor((clientX - body().left) / dw));

  const begin = (event: ReactPointerEvent, next: Drag) => {
    const mouse = event.pointerType === "mouse";
    if (mouse && event.button !== 0) return;
    event.stopPropagation();
    cancelGesture();
    if (mouse) event.preventDefault();
    const immediate =
      mouse || next.type === "link" || next.type === "row" || next.type === "resize";
    const current: Gesture = {
      pointerId: event.pointerId,
      mouse,
      drag: next,
      active: immediate,
      x0: event.clientX,
      y0: event.clientY,
      timer: null,
      mods: {
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      },
    };
    if (mouse) {
      try {
        scrollerRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // Pointer already gone.
      }
    }
    gesture.current = current;
    if (immediate) {
      setDrag(next);
      return;
    }
    current.timer = window.setTimeout(() => {
      current.timer = null;
      if (gesture.current !== current) return;
      current.active = true;
      navigator.vibrate?.(8);
      setDrag(current.drag);
    }, HOLD_MS);
  };

  const autoScroll = (clientX: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (clientX < rect.left + labelW + 28) el.scrollLeft -= 14;
    else if (clientX > rect.right - 28) el.scrollLeft += 14;
  };

  const advance = (current: Drag, clientX: number, clientY: number): Drag => {
    const origin = body();
    if (current.type === "edit") {
      const at = clientX - origin.left;
      return {
        ...current,
        delta: Math.round((at - current.x0) / dw),
        moved: current.moved || Math.abs(at - current.x0) > 3,
      };
    }
    if (current.type === "milestone") {
      const at = clientX - origin.left;
      return {
        ...current,
        delta: Math.round((at - current.x0) / dw),
        moved: current.moved || Math.abs(at - current.x0) > 3,
      };
    }
    if (current.type === "resize") {
      setLabelW(current.w0 + clientX - current.x0);
      return { ...current, moved: true };
    }
    if (current.type === "row") {
      const py = clientY - origin.top;
      let beforeId: string | null = null;
      for (const id of current.siblings) {
        if (id === current.itemId) continue;
        const index = rowOf.get(id);
        if (index !== undefined && py < index * ROW + ROW / 2) {
          beforeId = id;
          break;
        }
      }
      return {
        ...current,
        beforeId,
        moved: current.moved || Math.abs(clientY - current.y0) > 3,
      };
    }
    if (current.type === "create") {
      const day = dayAt(clientX);
      return { ...current, day, moved: current.moved || day !== current.anchor };
    }
    if (current.type === "link") {
      const px = clientX - origin.left;
      const py = clientY - origin.top;
      const row = rows[Math.floor(py / ROW)];
      const targetId =
        row?.kind === "item" && row.item.id !== current.fromId
          ? row.item.id
          : null;
      return { ...current, x: px, y: py, targetId, moved: true };
    }
    const el = scrollerRef.current;
    if (el) {
      el.scrollLeft = current.left0 - (clientX - current.x0);
      el.scrollTop = current.top0 - (clientY - current.y0);
    }
    return {
      ...current,
      moved:
        current.moved ||
        Math.hypot(clientX - current.x0, clientY - current.y0) > 3,
    };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.active) {
      if (Math.hypot(event.clientX - current.x0, event.clientY - current.y0) > 8)
        cancelGesture();
      return;
    }
    if (current.drag.type !== "pan" && current.drag.type !== "resize")
      autoScroll(event.clientX);
    current.drag = advance(current.drag, event.clientX, event.clientY);
    setDrag(current.drag);
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    cancelGesture();
    const moved = current.active && current.drag.moved;
    if (moved) commit(current.drag);
    else tap(current.drag, current.mods);
  };

  const offerShift = (itemId: string, delta: number) => {
    if (delta === 0) return;
    const now = getDb();
    const later = successors(now, itemId).filter(
      (item) => itemSpan(item) !== null && isOpenItem(now, item)
    );
    if (later.length === 0) return;
    ui.askConfirm({
      title: "Posunout navazující úkoly?",
      body: `Na tenhle úkol navazuje ${quoted(later)}. Posunout ${
        later.length === 1 ? "ho" : "je"
      } také o ${dayCount(Math.abs(delta))} ${delta > 0 ? "později" : "dříve"}?`,
      confirm: "Posunout",
      alt: "Nechat",
      onConfirm: () => dispatch({ type: "batch", ops: shiftOps(later, delta) }),
      onAlt: () => {},
    });
  };

  const schedule = (itemId: string, span: Span) => {
    const item = byId(getDb().items, itemId);
    if (!item) return;
    dispatch({ type: "updateItem", id: itemId, patch: spanPatch(item, span) });
  };

  const connect = (fromId: string, targetId: string, side: "start" | "end") => {
    const itemId = side === "end" ? targetId : fromId;
    const dependsOnId = side === "end" ? fromId : targetId;
    const before = getDb();
    if (
      alive(before.dependencies).some(
        (row) => row.itemId === itemId && row.dependsOnId === dependsOnId
      )
    ) {
      ui.pushToast("Tahle vazba už existuje.");
      return;
    }
    const after = dispatch({
      type: "addDependency",
      id: nanoid(10),
      itemId,
      dependsOnId,
    });
    if (after === before) {
      ui.pushToast("Tahle vazba by vytvořila kruh.");
      return;
    }
    const first = byId(after.items, dependsOnId);
    const next = byId(after.items, itemId);
    const a = first ? itemSpan(first) : null;
    const b = next ? itemSpan(next) : null;
    if (!first || !next || !a || !b || !startsTooEarly(a, b) || !isOpenItem(after, next)) {
      ui.pushToast("Vazba přidána", true);
      return;
    }
    const delta = catchUpDelta(a, b);
    const chain = [
      next,
      ...successors(after, next.id).filter(
        (item) => itemSpan(item) !== null && isOpenItem(after, item)
      ),
    ];
    ui.askConfirm({
      title: "Posunout navazující úkol?",
      body: `„${next.title}“ začíná dřív, než skončí „${first.title}“. Posunout ${
        chain.length === 1
          ? "ho"
          : `ho i navazující úkoly (${chain.length - 1})`
      } o ${dayCount(delta)} později?`,
      confirm: "Posunout",
      alt: "Nechat",
      onConfirm: () => dispatch({ type: "batch", ops: shiftOps(chain, delta) }),
      onAlt: () => {},
    });
  };

  const commit = (current: Drag) => {
    if (current.type === "resize") {
      setLabelW(labelW, true);
      return;
    }
    if (current.type === "row") {
      const ops = reorderOps(current.siblings, current.itemId, current.beforeId);
      if (ops) dispatch({ type: "batch", ops });
      return;
    }
    if (current.type === "edit") {
      if (current.delta === 0) return;
      const next = editSpan(current.span, current.edit, current.delta);
      schedule(current.itemId, next);
      if (current.edit !== "start" || current.span.kind === "due")
        offerShift(current.itemId, daysBetween(current.span.end, next.end));
      return;
    }
    if (current.type === "milestone") {
      if (current.delta !== 0)
        dispatch({
          type: "updateMilestone",
          id: current.id,
          day: addDays(current.day, current.delta),
        });
      return;
    }
    if (current.type === "create") {
      const [from, to] = ordered(current.anchor, current.day);
      if (current.itemId) {
        schedule(current.itemId, { kind: "plan", start: from, end: to });
        return;
      }
      setDraft({ folderId: current.folderId, start: from, end: to });
      return;
    }
    if (current.type === "link" && current.targetId)
      connect(current.fromId, current.targetId, current.side);
  };

  const tap = (current: Drag, mods: Mods) => {
    if (current.type === "edit") {
      clickItem(ui, current.itemId, mods);
      return;
    }
    if (current.type === "milestone") {
      setEditing(current.id);
      return;
    }
    if (current.type !== "create") return;
    if (current.itemId) {
      schedule(current.itemId, {
        kind: "plan",
        start: current.anchor,
        end: current.anchor,
      });
      return;
    }
    setDraft({
      folderId: current.folderId,
      start: current.anchor,
      end: current.anchor,
    });
  };

  const onScroll = () => {
    if (editing) setEditing(null);
    const el = scrollerRef.current;
    if (!el || gesture.current?.drag.type === "pan") return;
    if (el.scrollLeft < 7 * dw) setFloor((value) => addDays(value, -28));
    else if (el.scrollLeft + el.clientWidth > el.scrollWidth - 7 * dw)
      setCeil((value) => addDays(value, 28));
  };

  const editDrag = (
    event: ReactPointerEvent,
    item: Item,
    span: Span,
    edit: SpanEdit
  ) => {
    if (event.altKey && event.pointerType === "mouse") {
      begin(event, linkDrag(item.id, "end", span));
      return;
    }
    begin(event, {
      type: "edit",
      edit,
      itemId: item.id,
      span,
      x0: event.clientX - body().left,
      delta: 0,
      moved: false,
    });
  };
  const linkDrag = (fromId: string, side: "start" | "end", span: Span): Drag => {
    const row = rowOf.get(fromId) ?? 0;
    return {
      type: "link",
      fromId,
      side,
      x: side === "end" ? rightEdge(span) : leftEdge(span),
      y: row * ROW + ROW / 2,
      targetId: null,
      moved: false,
    };
  };
  const createDrag = (
    event: ReactPointerEvent,
    folderIdForRow: string,
    itemId: string | null
  ) => {
    const day = dayAt(event.clientX);
    begin(event, {
      type: "create",
      folderId: folderIdForRow,
      itemId,
      anchor: day,
      day,
      moved: false,
    });
  };
  const milestoneDrag = (event: ReactPointerEvent, row: Milestone) => {
    setEditing(null);
    begin(event, {
      type: "milestone",
      id: row.id,
      day: row.day,
      x0: event.clientX - body().left,
      delta: 0,
      moved: false,
    });
  };
  const rowDrag = (event: ReactPointerEvent, row: GanttRow) => {
    if (row.kind !== "item" || !row.span) return;
    const siblings = rows.flatMap((other) =>
      other.kind === "item" &&
      other.span &&
      other.item.folderId === row.item.folderId &&
      other.parentId === row.parentId
        ? [other.item.id]
        : []
    );
    begin(event, {
      type: "row",
      itemId: row.item.id,
      siblings,
      beforeId: null,
      y0: event.clientY,
      moved: false,
    });
  };
  const resizeDrag = (event: ReactPointerEvent) =>
    begin(event, { type: "resize", x0: event.clientX, w0: labelW, moved: false });
  const panDrag = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const el = scrollerRef.current;
    if (!el) return;
    begin(event, {
      type: "pan",
      x0: event.clientX,
      y0: event.clientY,
      left0: el.scrollLeft,
      top0: el.scrollTop,
      moved: false,
    });
  };

  const linkTarget = (() => {
    if (drag?.type !== "link" || !drag.targetId) return null;
    const source = byId(db.items, drag.fromId);
    const target = byId(db.items, drag.targetId);
    if (!source || !target) return null;
    const from = drag.side === "end" ? source : target;
    const to = drag.side === "end" ? target : source;
    const exists = alive(db.dependencies).some(
      (row) => row.itemId === to.id && row.dependsOnId === from.id
    );
    const reason = exists
      ? "Tahle vazba už existuje"
      : wouldDependencyCycle(db, to.id, from.id)
      ? "Tahle vazba by vytvořila kruh"
      : null;
    return { id: target.id, from, to, reason };
  })();

  const status = (() => {
    if (drag?.type === "edit" && drag.moved)
      return spanLabel(editSpan(drag.span, drag.edit, drag.delta), today);
    if (drag?.type === "create") {
      const [from, to] = ordered(drag.anchor, drag.day);
      return spanLabel({ kind: "plan", start: from, end: to }, today);
    }
    if (drag?.type === "milestone" && drag.moved) {
      const row = byId(db.milestones, drag.id);
      return row ? `${row.title} · ${formatDay(addDays(drag.day, drag.delta), today)}` : null;
    }
    if (drag?.type === "link") {
      if (!linkTarget) return "Najeď na úkol, ke kterému šipka povede";
      if (linkTarget.reason) return linkTarget.reason;
      return `Pusť: „${linkTarget.from.title}“ → „${linkTarget.to.title}“`;
    }
    if (drag?.type === "row" && drag.moved) return "Pusť na nové místo";
    return null;
  })();

  const weekendBg: CSSProperties = {
    backgroundImage: [
      `repeating-linear-gradient(to right, transparent 0 ${5 * dw}px, var(--weekend) ${
        5 * dw
      }px ${7 * dw}px)`,
      dw >= 20
        ? `repeating-linear-gradient(to right, var(--grid) 0 1px, transparent 1px ${dw}px)`
        : null,
    ]
      .filter(Boolean)
      .join(", "),
  };
  const todayX = x(today);
  const todayInRange = today >= start && today <= end;

  const arrows = alive(db.dependencies).flatMap((dep) => {
    const fromRow = rowOf.get(dep.dependsOnId);
    const toRow = rowOf.get(dep.itemId);
    if (fromRow === undefined || toRow === undefined) return [];
    const fromItem = byId(db.items, dep.dependsOnId);
    const toItem = byId(db.items, dep.itemId);
    if (!fromItem || !toItem) return [];
    const a = shown(fromItem, itemSpan(fromItem));
    const b = shown(toItem, itemSpan(toItem));
    if (!a || !b) return [];
    const { path, head } = connector(
      rightEdge(a),
      fromRow * ROW + ROW / 2,
      leftEdge(b),
      toRow * ROW + ROW / 2
    );
    return [
      {
        id: dep.id,
        path,
        head,
        late: startsTooEarly(a, b) && isOpenItem(db, toItem),
        label: `${fromItem.title} → ${toItem.title}`,
      },
    ];
  });

  const removeArrow = (id: string) => {
    dispatch({ type: "removeDependency", id });
    ui.pushToast("Vazba odebrána", true);
  };

  const linkLine = (() => {
    if (drag?.type !== "link") return null;
    const fromRow = rowOf.get(drag.fromId);
    const item = byId(db.items, drag.fromId);
    const span = item ? itemSpan(item) : null;
    if (fromRow === undefined || !span) return null;
    const x1 = drag.side === "end" ? rightEdge(span) : leftEdge(span);
    const y1 = fromRow * ROW + ROW / 2;
    return { x1, y1, x2: drag.x, y2: drag.y };
  })();
  // Once the pointer is over a task, preview the arrow exactly as it will land.
  const linkPreview = (() => {
    if (!linkTarget) return null;
    const a = itemSpan(linkTarget.from);
    const b = itemSpan(linkTarget.to);
    const fromRow = rowOf.get(linkTarget.from.id);
    const toRow = rowOf.get(linkTarget.to.id);
    if (!a || !b || fromRow === undefined || toRow === undefined) return null;
    return {
      ...connector(
        rightEdge(a),
        fromRow * ROW + ROW / 2,
        leftEdge(b),
        toRow * ROW + ROW / 2
      ),
      bad: Boolean(linkTarget.reason),
    };
  })();
  const rowGuide = (() => {
    if (drag?.type !== "row" || !drag.moved) return null;
    if (drag.beforeId) {
      const index = rowOf.get(drag.beforeId);
      return index === undefined ? null : index * ROW;
    }
    const last = [...drag.siblings].reverse().find((id) => id !== drag.itemId);
    let index = last ? rowOf.get(last) : undefined;
    if (index === undefined) return null;
    const depth = (rows[index] as Extract<GanttRow, { kind: "item" }>).depth;
    while (true) {
      const next = rows[index + 1];
      if (next?.kind !== "item" || next.depth <= depth) break;
      index += 1;
    }
    return (index + 1) * ROW;
  })();

  // Inline fields stay inside the visible part, or typing scrolls the axis.
  const fitLeft = (left: number, width: number) => {
    const el = scrollerRef.current;
    if (!el) return left;
    const right = el.scrollLeft + el.clientWidth - labelW - 8;
    return Math.max(el.scrollLeft + 4, Math.min(left, right - width));
  };
  const dense = dw < 20;
  const bodyH = rows.length * ROW;
  const segments = monthSegments(start, days);

  // The editor lives outside the scroller so a short chart does not clip it.
  const editor = (() => {
    const row = editing ? byId(db.milestones, editing) : null;
    const el = scrollerRef.current;
    if (!row || row.isDeleted || !el) return null;
    const wrapper = el.parentElement?.clientWidth ?? el.clientWidth;
    const left = Math.max(
      0,
      Math.min(
        el.offsetLeft + labelW + x(row.day) + dw / 2 - 13 - el.scrollLeft,
        wrapper - 296
      )
    );
    return (
      <MilestoneEditor
        key={row.id}
        milestone={row}
        left={left}
        top={el.offsetTop + HEAD + 4}
        onClose={() => setEditing(null)}
      />
    );
  })();

  return (
    <div className="relative grid gap-2">
      {editor}
      <div className="flex flex-wrap items-center gap-1">
        <Button onClick={scrollToToday}>Dnes</Button>
        <IconButton label="Oddálit" onClick={() => zoomCenter(1 / 1.4)}>
          <ZoomOut size={18} />
        </IconButton>
        <IconButton label="Přiblížit" onClick={() => zoomCenter(1.4)}>
          <ZoomIn size={18} />
        </IconButton>
        <span className="ml-1 min-w-0 truncate text-sm text-muted">
          {status ?? ""}
        </span>
      </div>
      <div
        ref={scrollerRef}
        className="relative isolate max-h-[calc(100dvh-13rem)] min-h-40 overflow-auto overscroll-x-contain rounded-xl border border-line bg-panel"
        style={{ touchAction: "pan-x pan-y" }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelGesture}
        onScroll={onScroll}
        onContextMenu={(event) => {
          if (gesture.current) event.preventDefault();
        }}
      >
        <div
          ref={canvasRef}
          className={cx(
            "relative select-none [--grid:color-mix(in_srgb,var(--line)_55%,transparent)] [--weekend:rgb(0_0_0/0.05)] dark:[--weekend:rgb(255_255_255/0.045)]",
            drag?.type === "pan" && "cursor-grabbing",
            drag?.type === "link" && "cursor-crosshair",
            drag?.type === "resize" && "cursor-col-resize",
            drag?.type === "row" && "cursor-grabbing",
            drag?.type === "edit" && drag.edit !== "move" && "cursor-ew-resize",
            (drag?.type === "milestone" ||
              (drag?.type === "edit" && drag.edit === "move")) &&
              "cursor-grabbing"
          )}
          style={{
            width: labelW + trackW,
            height: HEAD + rows.length * ROW + FOOT,
          }}
        >
          <div
            className="absolute z-0"
            style={{ left: labelW, top: HEAD, width: trackW, height: bodyH, ...weekendBg }}
          />
          {todayInRange && (
            <div
              className="absolute z-0 bg-accent/10 shadow-[inset_1px_0_0_var(--accent)]"
              style={{ left: labelW + todayX, top: HEAD, width: dw, height: bodyH }}
            />
          )}

          <div className="sticky top-0 z-30 flex" style={{ height: HEAD }}>
            <div
              className="sticky left-0 z-10 flex shrink-0 items-end border-r border-b border-line bg-panel px-3 text-xs text-muted"
              style={{ width: labelW }}
            >
              <ResizeGrip onBegin={resizeDrag} active={drag?.type === "resize"} />
              <span
                className="flex w-full items-center justify-between"
                style={{ height: LANE }}
              >
                Milníky
                <button
                  type="button"
                  className="grid size-5 place-items-center rounded-sm text-muted! hover:bg-black/5 hover:text-ink! dark:hover:bg-white/10"
                  aria-label="Nový milník"
                  title="Nový milník"
                  onClick={() => {
                    setEditing(null);
                    setNewMilestone(today);
                  }}
                >
                  <Plus size={14} />
                </button>
              </span>
            </div>
            <div
              className="relative shrink-0 cursor-grab border-b border-line bg-panel"
              style={{ width: trackW }}
              onPointerDown={panDrag}
            >
              <div className="absolute inset-0" style={weekendBg} />
              {segments.map((segment) => {
                const width = segment.length * dw;
                const date = new Date(`${segment.month}-01T00:00:00`);
                const name = date.toLocaleDateString("cs-CZ", {
                  month: width < 70 ? "short" : "long",
                  ...(width >= 110 ? { year: "numeric" } : {}),
                });
                return (
                  <div
                    key={segment.month}
                    className="absolute top-0 h-5 border-l border-line"
                    style={{ left: segment.offset * dw, width }}
                  >
                    <span
                      className="sticky block w-max truncate px-1.5 pt-0.5 text-xs font-medium capitalize"
                      style={{ left: labelW }}
                    >
                      {width >= 24 ? name : ""}
                    </span>
                  </div>
                );
              })}
              {Array.from({ length: days }, (_, offset) => {
                const day = addDays(start, offset);
                const isToday = day === today;
                const weekday = isoWeekday(day);
                if (dense && !isToday && weekday !== 1) return null;
                return (
                  <span
                    key={day}
                    className={cx(
                      "absolute top-5 flex h-6 items-center justify-center text-xs tabular-nums",
                      dense && !isToday && "justify-start pl-0.5",
                      weekday >= 6 && !isToday && "text-muted"
                    )}
                    style={{
                      left: dense && isToday ? x(day) + dw / 2 - 12 : x(day),
                      width: dense ? 24 : dw,
                    }}
                  >
                    <span
                      className={cx(
                        isToday &&
                          "grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 font-medium text-accent-ink"
                      )}
                    >
                      {Number(day.slice(8))}
                    </span>
                  </span>
                );
              })}
              <div
                className="absolute inset-x-0 cursor-cell border-t border-line/60"
                style={{ top: HEAD - LANE, height: LANE }}
                title="Klikni pro nový milník"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  if (event.target !== event.currentTarget) return;
                  setEditing(null);
                  setNewMilestone(dayAt(event.clientX));
                }}
              >
                {milestones.map((row, index, all) => {
                  const day = milestoneDay(row);
                  const after = all
                    .map(milestoneDay)
                    .filter((other, at) => at !== index && other > day)
                    .sort()[0];
                  const room = after
                    ? daysBetween(day, after) * dw - 18
                    : Number.POSITIVE_INFINITY;
                  const paint = milestonePaint(db, row);
                  return (
                    <span
                      key={row.id}
                      title={`${row.title} · ${formatDay(row.day, today)}`}
                      className={cx(
                        "absolute top-0 z-[2] flex h-full cursor-grab items-center gap-1 pr-1.5 text-xs active:cursor-grabbing",
                        editing === row.id && "font-medium"
                      )}
                      style={{ left: x(day) + dw / 2 - 5 }}
                      onPointerDown={(event) => milestoneDrag(event, row)}
                    >
                      <span
                        className="size-2.5 shrink-0 rotate-45 rounded-[1px]"
                        style={{ background: paint }}
                      />
                      {room >= 24 && (
                        <span
                          className="truncate rounded-sm bg-panel/90 px-0.5"
                          style={{ maxWidth: Math.min(room, 180) }}
                        >
                          {row.title}
                        </span>
                      )}
                    </span>
                  );
                })}
                {newMilestone && (
                  <MilestoneComposer
                    key={newMilestone}
                    day={newMilestone}
                    left={fitLeft(x(newMilestone) + dw / 2 - 5, 210)}
                    folderId={folderId}
                    onDone={() => setNewMilestone(null)}
                  />
                )}
              </div>
            </div>
          </div>

          {milestones.map((row) => {
            const paint = milestonePaint(db, row);
            return (
              <div
                key={row.id}
                className="pointer-events-none absolute z-[1] border-l-2 border-dashed"
                style={{
                  left: labelW + x(milestoneDay(row)) + dw / 2 - 1,
                  top: HEAD,
                  height: bodyH,
                  borderColor: `color-mix(in srgb, ${paint} 70%, transparent)`,
                }}
              />
            );
          })}

          {rows.map((row) => (
            <GanttRowView
              key={row.key}
              row={row}
              labelW={labelW}
              trackW={trackW}
              highlighted={
                row.kind === "item" && linkTarget?.id === row.item.id
                  ? linkTarget.reason
                    ? "bad"
                    : "ok"
                  : null
              }
              dragging={
                drag?.type === "row" && row.kind === "item" && drag.itemId === row.item.id
              }
              quiet={drag !== null}
              onGrip={(event) => rowDrag(event, row)}
              onResize={resizeDrag}
              onToggleTray={(id) =>
                setTrays((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              onTrackDown={(event) => {
                if (row.kind === "create") createDrag(event, row.folderId, null);
                else if (row.kind === "item" && !row.span)
                  createDrag(event, row.item.folderId, row.item.id);
                else panDrag(event);
              }}
              draft={
                row.kind === "create" && draft?.folderId === row.folderId
                  ? draft
                  : null
              }
              onDraftStart={() =>
                row.kind === "create" &&
                setDraft({
                  folderId: row.folderId,
                  start: today,
                  end: today,
                })
              }
              onDraftDone={() => setDraft(null)}
              hintX={todayInRange ? todayX : 0}
            >
              {row.kind === "item" && row.span && (
                <ItemMark
                  target={
                    linkTarget?.id === row.item.id
                      ? linkTarget.reason
                        ? "bad"
                        : "ok"
                      : null
                  }
                  item={row.item}
                  span={shown(row.item, row.span) ?? row.span}
                  x={x}
                  dw={dw}
                  badge={
                    drag?.type === "edit" && drag.itemId === row.item.id && drag.moved
                      ? dragLabel(editSpan(drag.span, drag.edit, drag.delta), today)
                      : null
                  }
                  onEdit={(event, edit) => editDrag(event, row.item, row.span!, edit)}
                  onLink={(event, side) =>
                    begin(event, linkDrag(row.item.id, side, row.span!))
                  }
                />
              )}
              {(() => {
                const preview =
                  drag?.type === "create" && drag.moved
                    ? (row.kind === "create" &&
                        !drag.itemId &&
                        drag.folderId === row.folderId) ||
                      (row.kind === "item" && drag.itemId === row.item.id)
                      ? ordered(drag.anchor, drag.day)
                      : null
                    : row.kind === "create" && draft?.folderId === row.folderId
                    ? ([draft.start, draft.end] as [string, string])
                    : null;
                if (!preview) return null;
                const count = daysBetween(preview[0], preview[1]) + 1;
                const width = count * dw;
                const dragging = drag?.type === "create";
                return (
                  <>
                    <span
                      className="pointer-events-none absolute top-1.5 z-[2] grid place-items-center overflow-hidden rounded-md border-2 border-dashed border-accent bg-accent/10 text-xs font-medium whitespace-nowrap text-accent"
                      style={{ left: x(preview[0]), width, height: ROW - 12 }}
                    >
                      {width >= 52 ? dayCount(count) : null}
                    </span>
                    {dragging && (
                      <DragBadge
                        left={x(preview[0]) + width + 6}
                        text={dragLabel(
                          { kind: "plan", start: preview[0], end: preview[1] },
                          today
                        )}
                      />
                    )}
                  </>
                );
              })()}
            </GanttRowView>
          ))}

          {rowGuide !== null && (
            <div
              className="pointer-events-none absolute left-0 z-[25] h-0.5 rounded-full bg-accent"
              style={{ top: HEAD + rowGuide - 1, width: labelW + trackW }}
            />
          )}
          <svg
            className="pointer-events-none absolute z-[1] overflow-visible"
            style={{ left: labelW, top: HEAD }}
            width={trackW}
            height={rows.length * ROW}
          >
            {arrows.map((arrow) => (
              <g key={arrow.id} className="group/arrow">
                <title>{`${arrow.label} · kliknutím odebereš`}</title>
                <path
                  d={arrow.path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={10}
                  className="cursor-pointer"
                  style={{ pointerEvents: "stroke" }}
                  onClick={() => removeArrow(arrow.id)}
                />
                <path
                  d={arrow.path}
                  fill="none"
                  strokeWidth={1.5}
                  className={cx(
                    "transition-colors",
                    arrow.late
                      ? "stroke-danger"
                      : "stroke-muted group-hover/arrow:stroke-ink"
                  )}
                />
                <path
                  d={arrow.head}
                  className={cx(
                    arrow.late
                      ? "fill-danger"
                      : "fill-muted group-hover/arrow:fill-ink"
                  )}
                />
              </g>
            ))}
            {linkPreview && (
              <g>
                <path
                  d={linkPreview.path}
                  fill="none"
                  strokeWidth={2}
                  className={linkPreview.bad ? "stroke-danger" : "stroke-accent"}
                />
                <path
                  d={linkPreview.head}
                  className={linkPreview.bad ? "fill-danger" : "fill-accent"}
                />
              </g>
            )}
            {linkLine && !linkPreview && (
              <line
                x1={linkLine.x1}
                y1={linkLine.y1}
                x2={linkLine.x2}
                y2={linkLine.y2}
                strokeWidth={2}
                strokeDasharray="4 3"
                className="stroke-accent"
              />
            )}
          </svg>
        </div>
      </div>
      <p className="px-1 text-xs leading-5 text-muted">
        Pruh posuneš tažením, délku změníš za okraj. Šipku natáhneš z kolečka
        před pruhem nebo za ním, případně tažením s klávesou Alt. Kliknutím na
        šipku ji odebereš. Na prázdném řádku tažením vznikne úkol od–do,
        kliknutím úkol na jeden den. Milník přidáš kliknutím do pásu Milníky
        pod datem, posuneš ho tažením a kliknutím upravíš. Přiblížení: sevření
        prstů nebo Ctrl + kolečko. Na dotykové obrazovce nejdřív podrž prst.
      </p>
    </div>
  );
}

function GanttRowView({
  row,
  labelW,
  trackW,
  highlighted,
  dragging,
  quiet,
  onGrip,
  onResize,
  onToggleTray,
  onTrackDown,
  draft,
  onDraftStart,
  onDraftDone,
  hintX,
  children,
}: {
  row: GanttRow;
  labelW: number;
  trackW: number;
  highlighted: "ok" | "bad" | null;
  dragging: boolean;
  quiet: boolean;
  onGrip: (event: ReactPointerEvent) => void;
  onResize: (event: ReactPointerEvent) => void;
  onToggleTray: (folderId: string) => void;
  onTrackDown: (event: ReactPointerEvent) => void;
  draft: Draft | null;
  onDraftStart: () => void;
  onDraftDone: () => void;
  hintX: number;
  children?: ReactNode;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const label = (() => {
    if (row.kind === "group") {
      const folder = byId(db.folders, row.folderId);
      return (
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <FolderGlyph color={folder?.color ?? null} className="h-3.5 shrink-0" />
          <span className="truncate">
            {folderTrail(db, row.folderId)
              .map((part) => part.name)
              .join(" / ")}
          </span>
        </span>
      );
    }
    if (row.kind === "tray")
      return (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 text-sm text-muted! hover:text-ink!"
          aria-expanded={row.open}
          onClick={() => onToggleTray(row.folderId)}
        >
          {row.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="truncate">Bez termínu</span>
          <span className="text-xs tabular-nums">{row.count}</span>
        </button>
      );
    if (row.kind === "create")
      return draft ? (
        <GanttComposer draft={draft} onDone={onDraftDone} />
      ) : (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-sm text-muted! hover:text-ink!"
          onClick={onDraftStart}
        >
          <Plus size={14} className="shrink-0" />
          <span className="truncate">Nový úkol</span>
        </button>
      );
    const item = row.item;
    const checked = isChecked(db, item);
    const person = byId(db.people, item.assigneeId);
    const lateDue =
      row.span?.kind === "due" &&
      row.span.start < todayKey() &&
      isOpenItem(db, item);
    return (
      <>
        {row.span && (
          <span
            role="presentation"
            title="Táhni pro změnu pořadí"
            className="absolute inset-y-0 left-0 grid w-3 cursor-grab place-items-center text-muted opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
            style={{ touchAction: "none" }}
            onPointerDown={onGrip}
          >
            <GripVertical size={12} />
          </span>
        )}
        <input
          type="checkbox"
          className="size-4 shrink-0"
          checked={checked}
          aria-label={checked ? "Označit jako otevřené" : "Označit jako hotové"}
          onChange={() => toggleComplete(db, item, ui.askConfirm)}
        />
        <button
          type="button"
          className={cx(
            "min-w-0 flex-1 truncate text-left text-sm",
            !isOpenItem(db, item) && "text-muted line-through",
            lateDue && "text-danger",
            !row.span && "text-muted"
          )}
          style={{ paddingLeft: row.depth * 12 }}
          title={item.title}
          onClick={(event) => clickItem(ui, item.id, event)}
        >
          {item.title}
        </button>
        {person && <PersonBadge person={person} />}
      </>
    );
  })();
  const marked =
    row.kind === "item" && itemMarked(ui.picked, ui.selectedId, row.item.id);
  return (
    <div
      className={cx(
        "group flex",
        row.kind === "group" && "bg-black/[0.03] dark:bg-white/[0.04]",
        dragging && "opacity-50"
      )}
      style={{ height: ROW }}
      data-task-id={row.kind === "item" ? row.item.id : undefined}
    >
      <div
        className={cx(
          "sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-b border-line/60 px-3",
          highlighted === "bad"
            ? "bg-[color-mix(in_srgb,var(--danger)_14%,var(--panel))]"
            : highlighted || marked
            ? "bg-accent-soft"
            : "bg-panel"
        )}
        style={{ width: labelW }}
      >
        {label}
        <ResizeGrip onBegin={onResize} active={false} />
      </div>
      <div
        className={cx(
          "relative shrink-0 border-b border-line/60",
          highlighted === "ok" && "bg-accent/10",
          highlighted === "bad" && "bg-danger/10",
          (row.kind === "create" || (row.kind === "item" && !row.span)) &&
            "cursor-cell",
          row.kind === "item" && row.span && "cursor-grab"
        )}
        style={{ width: trackW }}
        onPointerDown={row.kind === "tray" ? undefined : onTrackDown}
      >
        {(row.kind === "create" || (row.kind === "item" && !row.span)) &&
          !draft &&
          !quiet && (
            <span
              className="pointer-events-none absolute top-0 flex h-full items-center pl-2 text-xs whitespace-nowrap text-muted opacity-0 transition-opacity group-hover:opacity-100"
              style={{ left: hintX }}
            >
              {row.kind === "create"
                ? "Táhni pro úkol od–do · klikni pro úkol na jeden den"
                : "Táhni nebo klikni pro naplánování"}
            </span>
          )}
        {children}
      </div>
    </div>
  );
}

function ItemMark({
  item,
  span,
  x,
  dw,
  target,
  badge,
  onEdit,
  onLink,
}: {
  target: "ok" | "bad" | null;
  badge: string | null;
  item: Item;
  span: Span;
  x: (day: string) => number;
  dw: number;
  onEdit: (event: ReactPointerEvent, edit: SpanEdit) => void;
  onLink: (event: ReactPointerEvent, side: "start" | "end") => void;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const paint = itemPaint(db, item);
  const person = byId(db.people, item.assigneeId);
  const done = !isOpenItem(db, item);
  const marked = itemMarked(ui.picked, ui.selectedId, item.id);
  const today = todayKey();
  const time = span.kind === "due" ? dueTime(item.dueAt, item.dueHasTime) : null;
  const tooltip = `${item.title} · ${spanLabel(span, today)}${time ? ` ${time}` : ""}`;
  const left = x(span.start);
  const width = (daysBetween(span.start, span.end) + 1) * dw;
  // The person sits inside the bar whenever it fits; the title too.
  const personInside = Boolean(person) && width >= 26;
  const inside =
    width >= item.title.length * 6.5 + 20 + (personInside ? 22 : 0);
  const knob = (side: "start" | "end") => (
    <span
      role="presentation"
      title={side === "end" ? "Táhni na úkol, který navazuje" : "Táhni na úkol, na který tenhle čeká"}
      className={cx(
        "absolute z-[3] grid cursor-crosshair place-items-center opacity-0 transition-opacity group-hover:opacity-100",
        marked && "opacity-100"
      )}
      style={{
        left: side === "start" ? left - KNOB - 3 : left + width + 3,
        top: ROW / 2 - KNOB / 2,
        width: KNOB,
        height: KNOB,
        touchAction: "none",
      }}
      onPointerDown={(event) => onLink(event, side)}
    >
      <span className="size-2.5 rounded-full border-2 border-accent bg-raised" />
    </span>
  );
  return (
    <>
      <div
          title={tooltip}
          className={cx(
            "absolute top-1.5 z-[2] flex cursor-grab items-center overflow-hidden rounded-md border text-xs transition-shadow active:cursor-grabbing",
            done && "opacity-50",
            marked && "ring-2 ring-accent",
            target === "ok" &&
              "shadow-[0_0_0_3px_var(--accent),0_4px_14px_rgb(0_0_0/0.18)]",
            target === "bad" && "shadow-[0_0_0_3px_var(--danger)]"
          )}
          style={{
            left,
            width,
            height: ROW - 12,
            background: `color-mix(in srgb, ${paint} 28%, var(--raised))`,
            borderColor: `color-mix(in srgb, ${paint} 65%, transparent)`,
          }}
          onPointerDown={(event) => onEdit(event, "move")}
        >
          {inside && (
            <span className={cx("min-w-0 truncate px-2", done && "line-through")}>
              {item.title}
            </span>
          )}
          {personInside && person && (
            <span className="ml-auto shrink-0 pr-[3px] pl-0.5">
              <PersonBadge person={person} />
            </span>
          )}
          {width >= 18 && (
            <>
              <span
                className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
                onPointerDown={(event) => onEdit(event, "start")}
              />
              <span
                className="absolute inset-y-0 right-0 w-2 cursor-ew-resize"
                onPointerDown={(event) => onEdit(event, "end")}
              />
            </>
          )}
        </div>
      {knob("start")}
      {knob("end")}
      <span
        className="pointer-events-none absolute top-0 z-[2] flex h-full items-center gap-1.5 whitespace-nowrap text-xs"
        style={{ left: left + width + KNOB + 6 }}
      >
        {badge ? (
          <span className="rounded-md bg-ink px-1.5 py-0.5 font-medium tabular-nums text-bg shadow-[var(--shadow)]">
            {badge}
          </span>
        ) : (
          !inside && (
            <span className={cx("text-muted", done && "line-through")}>
              {item.title}
            </span>
          )
        )}
        {person && !personInside && <PersonBadge person={person} />}
      </span>
    </>
  );
}


function GanttComposer({
  draft,
  onDone,
}: {
  draft: Draft;
  onDone: () => void;
}) {
  const { db } = useSnap();
  const [text, setText] = useState("");
  const skip = useRef(false);
  const input = useFocusInPlace();
  const commit = () => {
    const trimmed = text.trim();
    const folder = byId(db.folders, draft.folderId) ?? inboxFolder(db);
    if (!trimmed || !folder) {
      onDone();
      return;
    }
    const { ops, itemIds } = opsFromTaskDraft(db, trimmed, {
      folderId: folder.id,
      statusId: resolvedOpen(db, folder)?.id ?? null,
      dateRole: "plan",
      applyRules: folder.system === "inbox",
      ids: () => nanoid(10),
      today: todayKey(),
    });
    if (itemIds.length > 0) {
      const created = new Set(itemIds);
      const when = {
        plannedFor: draft.start,
        planUntil: draft.end > draft.start ? draft.end : null,
        dueAt: null,
        dueHasTime: false,
      };
      dispatch({
        type: "batch",
        ops: ops.map((op) =>
          op.type === "createItem" && created.has(op.item.id)
            ? { ...op, item: { ...op.item, ...when } }
            : op
        ),
      });
    }
    onDone();
  };
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <Plus size={14} className="shrink-0 text-muted" />
      <input
        ref={input}
        aria-label="Nový úkol"
        placeholder="Nový úkol…"
        className="min-w-0 flex-1 border-0 bg-transparent py-1 text-sm outline-none placeholder:text-muted"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            skip.current = true;
            onDone();
            return;
          }
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          skip.current = true;
          commit();
        }}
        onBlur={() => {
          if (skip.current) {
            skip.current = false;
            return;
          }
          commit();
        }}
      />
    </span>
  );
}

function MilestoneComposer({
  day,
  left,
  folderId,
  onDone,
}: {
  day: string;
  left: number;
  folderId: string | null;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const skip = useRef(false);
  const input = useFocusInPlace();
  const commit = () => {
    const title = text.trim();
    if (title)
      dispatch({ type: "createMilestone", id: nanoid(10), folderId, title, day });
    onDone();
  };
  return (
    <span
      className="absolute top-0.5 z-[3] flex items-center gap-1 rounded-md border border-accent bg-raised px-1.5 shadow-[var(--shadow)]"
      style={{ left, height: LANE - 4 }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="size-2.5 shrink-0 rotate-45 rounded-[1px] bg-accent" />
      <input
        ref={input}
        aria-label="Nový milník"
        placeholder={`Milník ${formatDay(day, todayKey())}…`}
        className="w-44 border-0 bg-transparent text-xs outline-none placeholder:text-muted"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            skip.current = true;
            onDone();
            return;
          }
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          skip.current = true;
          commit();
        }}
        onBlur={() => {
          if (skip.current) {
            skip.current = false;
            return;
          }
          commit();
        }}
      />
    </span>
  );
}

function MilestoneEditor({
  milestone,
  left,
  top,
  onClose,
}: {
  milestone: Milestone;
  left: number;
  top: number;
  onClose: () => void;
}) {
  const ui = useUi();
  const { db } = useSnap();
  const ref = useRef<HTMLDivElement>(null);
  const titleInput = useFocusInPlace();
  const folder = milestone.folderId ? byId(db.folders, milestone.folderId) : null;
  const [title, setTitle] = useState(milestone.title);
  const latest = useRef(title);
  latest.current = title;
  const saveTitle = () => {
    const next = latest.current.trim();
    if (next && next !== milestone.title)
      dispatch({ type: "updateMilestone", id: milestone.id, title: next });
  };
  const save = useRef(saveTitle);
  save.current = saveTitle;
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target))
        return;
      save.current();
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Milník"
      className="absolute z-40 grid w-72 gap-2 rounded-lg border border-line bg-raised p-2.5 shadow-[var(--shadow)]"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        ref={titleInput}
        aria-label="Název milníku"
        className={control}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          saveTitle();
          onClose();
        }}
      />
      <input
        type="date"
        aria-label="Datum milníku"
        className={control}
        value={milestone.day}
        onChange={(event) => {
          if (event.target.value)
            dispatch({ type: "updateMilestone", id: milestone.id, day: event.target.value });
        }}
      />
      <PaintPicker
        value={milestone.color ?? null}
        inheritLabel={folder ? "Podle složky" : "Bez barvy"}
        inheritPaint={folder?.color ? paintCss(folder.color) : "var(--muted)"}
        onChange={(color) =>
          dispatch({ type: "updateMilestone", id: milestone.id, color })
        }
      />
      <Button
        tone="danger"
        onClick={() => {
          dispatch({ type: "deleteMilestone", id: milestone.id });
          ui.pushToast("Milník smazán", true);
          onClose();
        }}
      >
        <Trash2 size={14} /> Smazat milník
      </Button>
    </div>
  );
}

function ResizeGrip({
  onBegin,
  active,
}: {
  onBegin: (event: ReactPointerEvent) => void;
  active: boolean;
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Šířka sloupce s úkoly"
      title="Táhni pro změnu šířky"
      className={cx(
        "absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize transition-colors hover:bg-accent/40",
        active && "bg-accent/40"
      )}
      style={{ touchAction: "none" }}
      onPointerDown={onBegin}
    />
  );
}

// Live size of what is being dragged, right next to it.
function DragBadge({ left, text }: { left: number; text: string }) {
  return (
    <span
      className="pointer-events-none absolute top-0 z-[3] flex h-full items-center"
      style={{ left }}
    >
      <span className="rounded-md bg-ink px-1.5 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums text-bg shadow-[var(--shadow)]">
        {text}
      </span>
    </span>
  );
}
