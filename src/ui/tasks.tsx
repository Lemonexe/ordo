import { useDndContext, useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronsUp,
  ChevronUp,
  ListFilter,
  Plus,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Link } from "wouter";
import { dispatch, useSnap } from "../data/store.tsx";
import { todayKey } from "../domain/dates.ts";
import {
  byId,
  inboxFolder,
  resolvedClosed,
  resolvedOpen,
  statusesOf,
} from "../domain/db.ts";
import { newItem } from "../domain/factory.ts";
import { pullHashtags, removeToken } from "../domain/hashtags.ts";
import { whenLabel } from "../domain/horizon.ts";
import { priorityLabel } from "../domain/labels.ts";
import { phonesIn, smsHref, whatsAppHref } from "../domain/links.ts";
import {
  indentOutline,
  nestOutline,
  outdentOutline,
} from "../domain/outline.ts";
import { mapHref, routeHref } from "../domain/place.ts";
import {
  opsFromTaskDraft,
  suggestTags,
  tagQueryExact,
  tokenAtCaret,
} from "../domain/quickAdd.ts";
import { recurrenceLabel } from "../domain/recurrence.ts";
import {
  blockingItems,
  folderTrail,
  isChecked,
  isOpenItem,
  mapStatus,
  subtasksOf,
  suggestFolders,
  tagsOf,
} from "../domain/select.ts";
import type {
  Folder,
  Item,
  ItemSort,
  Priority,
  Status,
} from "../domain/types.ts";
import { PersonBadge } from "./paint.tsx";
import { useBoardSlot } from "./boardDrop.ts";
import { acceptCompletionToggle } from "./completionGuard.ts";
import { DictateButton } from "./dictate.tsx";
import { LinkedText } from "./links.tsx";
import { MarkdownField } from "./markdownField.tsx";
import { completionOps, placeOp } from "./move.ts";
import { useUi, type ConfirmState } from "./state.tsx";
import { dispatchTaskText, TagMenu, useTagHint } from "./tagHint.tsx";
import { cx, TagMark, useDragDisplaced } from "./ui.tsx";

export function visibleTaskIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>(
    "main [data-task-id]"
  )) {
    const id = el.dataset.taskId;
    if (!id || seen.has(id) || el.getClientRects().length === 0) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function itemMarked(
  picked: string[],
  selectedId: string | null,
  id: string
) {
  return picked.length > 0 ? picked.includes(id) : selectedId === id;
}

export function clickItem(
  ui: {
    select: (id: string) => void;
    toggleInSelection: (id: string) => void;
    selectRange: (id: string, orderedIds: string[]) => void;
  },
  id: string,
  event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
) {
  if (event.shiftKey) {
    ui.selectRange(id, visibleTaskIds());
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    ui.toggleInSelection(id);
    return;
  }
  ui.select(id);
}

function useDragGuard(isDragging: boolean) {
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) {
      dragged.current = true;
      return;
    }
    if (!dragged.current) return;
    const timer = window.setTimeout(() => {
      dragged.current = false;
    }, 300);
    return () => window.clearTimeout(timer);
  }, [isDragging]);
  return () => {
    if (!dragged.current) return false;
    dragged.current = false;
    return true;
  };
}

export function ItemTitle({
  item,
  className,
  struck = false,
  truncate = true,
  clamp = false,
  dragClick,
}: {
  item: Item;
  className?: string;
  struck?: boolean;
  truncate?: boolean;
  clamp?: boolean;
  dragClick?: () => boolean;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const [draft, setDraft] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const cancel = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  const hint = useTagHint(
    item.type === "task" && draft !== null ? draft : "",
    caret
  );
  useEffect(() => {
    if (!editing) return;
    const field = inputRef.current;
    if (!field) return;
    field.focus();
    field.select();
  }, [editing]);
  useLayoutEffect(() => {
    const field = inputRef.current;
    const next = pendingCaret.current;
    if (!field || next === null) return;
    pendingCaret.current = null;
    field.setSelectionRange(next, next);
  }, [draft]);
  const saveTitle = (raw: string) => {
    if (item.type !== "task") {
      const next = raw.trim();
      if (!next || next === item.title) return;
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { title: next },
        fileInbox: true,
      });
      return;
    }
    const pulled = pullHashtags(raw);
    const title = pulled.text.trim();
    dispatchTaskText(
      db,
      item,
      title && title !== item.title ? { title } : {},
      pulled.names
    );
  };
  const pickTag = (name: string) => {
    if (!hint.token || draft === null) return;
    const cleaned = removeToken(draft, hint.token.start, hint.token.end);
    const title = cleaned.trim();
    const nextDraft = title || item.title;
    const nextCaret = Math.min(hint.token.start, nextDraft.length);
    pendingCaret.current = nextCaret;
    setCaret(nextCaret);
    setDraft(nextDraft);
    dispatchTaskText(db, item, title && title !== item.title ? { title } : {}, [
      name,
    ]);
  };
  const frame = cx(
    "min-w-0",
    editing || truncate
      ? "block truncate"
      : clamp
      ? "line-clamp-2"
      : "block break-words whitespace-normal",
    struck && "text-muted line-through",
    className
  );
  if (!editing) {
    return (
      <span
        className={frame}
        onClick={(event) => {
          if (dragClick?.()) {
            event.stopPropagation();
            return;
          }
          if (event.shiftKey || event.metaKey || event.ctrlKey) return;
          event.stopPropagation();
          ui.setSelected(item.id);
        }}
      >
        <LinkedText text={item.title} onActivate={keepControl} />
      </span>
    );
  }
  const commit = () => {
    if (cancel.current) {
      cancel.current = false;
      setDraft(null);
      return;
    }
    const next = draft ?? "";
    setDraft(null);
    saveTitle(next);
  };
  return (
    <span className={frame}>
      <input
        ref={inputRef}
        className="block w-full min-w-0 cursor-grab border-0 bg-transparent p-0 whitespace-nowrap outline-none"
        value={draft}
        aria-label="Název"
        onPointerDown={keepControl}
        onMouseDown={keepControl}
        onClick={keepControl}
        onChange={(event) => {
          setDraft(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Element && next.closest("[role=listbox]")) return;
          commit();
        }}
        onKeyDown={(event) => {
          const key = hint.onKey(event);
          if (key.handled) {
            if (key.name) pickTag(key.name);
            return;
          }
          if (
            event.key === "Enter" &&
            event.shiftKey &&
            !event.altKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            event.currentTarget.closest("[data-task-list]")
          ) {
            event.preventDefault();
            event.stopPropagation();
            const next = draft ?? "";
            cancel.current = true;
            setDraft(null);
            saveTitle(next);
            ui.editBody(item.id);
            return;
          }
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") cancel.current = true;
          event.currentTarget.blur();
        }}
      />
      {hint.open && (
        <TagMenu
          anchor={inputRef.current}
          tags={hint.tags}
          picked={hint.picked}
          onHover={hint.setHighlight}
          onPick={pickTag}
        />
      )}
    </span>
  );
}

function TaskBodyEditor({ item, struck }: { item: Item; struck: boolean }) {
  const { db } = useSnap();
  const ui = useUi();
  const anchor = useRef<HTMLElement | null>(null);
  const skip = useRef(false);
  const closed = useRef(false);
  const [draft, setDraft] = useState(item.body ?? "");
  const [caret, setCaret] = useState((item.body ?? "").length);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const hint = useTagHint(item.type === "task" ? draft : "", caret);
  const pickTag = (name: string) => {
    if (!hint.token) return;
    const cleaned = removeToken(
      draftRef.current,
      hint.token.start,
      hint.token.end
    );
    const body = cleaned.trim() ? cleaned.replace(/\s+$/, "") : null;
    setCaret(Math.min(hint.token.start, cleaned.length));
    setDraft(cleaned);
    dispatchTaskText(db, item, (item.body ?? null) === body ? {} : { body }, [
      name,
    ]);
  };
  const finish = (save: boolean) => {
    if (closed.current) return;
    closed.current = true;
    const text = draftRef.current;
    ui.editBody(null);
    if (!save) return;
    if (item.type !== "task") {
      const body = text.trim() ? text.replace(/\s+$/, "") : null;
      if ((item.body ?? null) === body) return;
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { body },
        fileInbox: true,
      });
      return;
    }
    const pulled = pullHashtags(text);
    const body = pulled.names.length
      ? pulled.text || null
      : text.trim()
      ? text.replace(/\s+$/, "")
      : null;
    dispatchTaskText(
      db,
      item,
      (item.body ?? null) === body ? {} : { body },
      pulled.names
    );
  };
  return (
    <div
      className={cx("text-sm leading-5 text-muted", struck && "line-through")}
      onPointerDown={keepControl}
      onMouseDown={keepControl}
      onClick={keepControl}
      onKeyDownCapture={(event) => {
        const key = hint.onKey(event);
        if (!key.handled) return;
        if (key.name) pickTag(key.name);
      }}
    >
      <MarkdownField
        value={draft}
        label="Popis"
        placeholder="Popis…"
        autoFocus
        caret={caret}
        density="inline"
        taskBody
        onCaret={(at, node) => {
          anchor.current = node;
          setCaret(at);
        }}
        onChange={(next, at) => {
          draftRef.current = next;
          setDraft(next);
          setCaret(at);
        }}
        onEscape={() => {
          skip.current = true;
        }}
        onBlur={() => {
          const save = !skip.current;
          skip.current = false;
          window.setTimeout(() => {
            const active = document.activeElement;
            if (active instanceof Element && active.closest("[role=listbox]"))
              return;
            if (active instanceof Element && active.closest("[data-task-body]"))
              return;
            finish(save);
          }, 0);
        }}
      />
      {hint.open && (
        <TagMenu
          anchor={anchor.current}
          tags={hint.tags}
          picked={hint.picked}
          onHover={hint.setHighlight}
          onPick={pickTag}
        />
      )}
    </div>
  );
}

function Dictated({ item }: { item: Item }) {
  const phones = phonesIn(item.title);
  if (
    !item.origin &&
    !item.place &&
    !item.spot &&
    !item.amount &&
    !item.variableSymbol &&
    phones.length === 0
  )
    return null;
  return (
    <>
      {item.origin && <span>{item.origin} →</span>}
      {item.place && (
        <a
          href={mapHref(item.place)}
          target="_blank"
          rel="noreferrer"
          title="Otevřít na mapě"
          className="underline underline-offset-2 hover:text-ink"
          onPointerDown={keepControl}
          onMouseDown={keepControl}
          onClick={keepControl}
        >
          {item.place}
        </a>
      )}
      {item.place && (
        <a
          href={routeHref(item.place, item.origin)}
          target="_blank"
          rel="noreferrer"
          title="Navigovat"
          className="underline underline-offset-2 hover:text-ink"
          onPointerDown={keepControl}
          onMouseDown={keepControl}
          onClick={keepControl}
        >
          Trasa
        </a>
      )}
      {item.spot && <span>{item.spot}</span>}
      {item.amount && <span>{item.amount}</span>}
      {item.variableSymbol && <span>VS {item.variableSymbol}</span>}
      {phones.map((phone) => {
        const sms = smsHref(phone.value);
        const whatsApp = whatsAppHref(phone.value);
        return (
          <span key={phone.href} className="inline-flex gap-2">
            {sms && (
              <a
                href={sms}
                className="underline underline-offset-2 hover:text-ink"
                onPointerDown={keepControl}
                onMouseDown={keepControl}
                onClick={keepControl}
              >
                SMS
              </a>
            )}
            {whatsApp && (
              <a
                href={whatsApp}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-ink"
                onPointerDown={keepControl}
                onMouseDown={keepControl}
                onClick={keepControl}
              >
                WhatsApp
              </a>
            )}
          </span>
        );
      })}
    </>
  );
}

function keepControl(
  event: PointerEvent | MouseEvent | { stopPropagation: () => void }
) {
  event.stopPropagation();
}

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

function PriorityNudge({ item }: { item: Item }) {
  const [live, setLive] = useState<Priority | null | undefined>(undefined);
  const origin = useRef<{ y: number; index: number } | null>(null);
  const dragged = useRef(false);
  const shown = live === undefined ? item.priority : live;
  const write = (priority: Priority | null) => {
    if (priority === item.priority) return;
    dispatch({
      type: "updateItem",
      id: item.id,
      patch: { priority },
    });
  };
  return (
    <button
      type="button"
      aria-label={`Priorita ${priorityLabel(shown)}. Táhni nahoru nebo dolů.`}
      title="Táhni nahoru pro vyšší prioritu"
      className="relative grid h-10 w-8 shrink-0 cursor-ns-resize touch-none place-items-center"
      onPointerDown={(event) => {
        keepControl(event);
        if (event.button !== 0) return;
        origin.current = {
          y: event.clientY,
          index: priorityIndex(item.priority),
        };
        dragged.current = false;
        setLive(item.priority);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Prohlížeč pointer nepustí, gesto stejně doběhne.
        }
      }}
      onPointerMove={(event) => {
        const start = origin.current;
        if (!start) return;
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
        const delta = start.y - event.clientY;
        if (Math.abs(delta) >= 8) {
          const index = Math.min(
            PRIORITY_LADDER.length - 1,
            Math.max(0, start.index + Math.round(delta / 22))
          );
          write(PRIORITY_LADDER[index] ?? null);
        }
        setLive(undefined);
      }}
      onPointerCancel={() => {
        origin.current = null;
        setLive(undefined);
      }}
      onClick={(event) => {
        keepControl(event);
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        write(priorityNext(item.priority));
      }}
    >
      {live !== undefined && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1 -translate-x-1/2 rounded-sm bg-raised px-1.5 py-0.5 text-xs whitespace-nowrap text-ink shadow-[var(--shadow)]">
          {priorityLabel(shown)}
        </span>
      )}
      <PriorityGlyph priority={shown} />
    </button>
  );
}

export function toggleComplete(
  db: Parameters<typeof completionOps>[0],
  item: Item,
  askConfirm: (value: ConfirmState) => void
) {
  if (!acceptCompletionToggle()) return;
  const ops = completionOps(db, item, false);
  const checked = isChecked(db, item);
  const openChildren = subtasksOf(db, item.id).filter((child) =>
    isOpenItem(db, child)
  );
  if (!checked && openChildren.length > 0) {
    askConfirm({
      title: "Zbývají podúkoly",
      body: `${openChildren.length} podúkolů ještě není hotových.`,
      confirm: "Dokončit i je",
      alt: "Nechat otevřené",
      onConfirm: () =>
        dispatch({ type: "batch", ops: completionOps(db, item, true) }),
      onAlt: () => dispatch({ type: "batch", ops }),
    });
    return;
  }
  if (ops.length > 0) dispatch({ type: "batch", ops });
}

export function deleteItems(
  items: Item[],
  notify: (text: string, undo?: boolean, action?: string) => void,
  after?: () => void
) {
  const live = items.filter((item) => !item.isDeleted);
  if (live.length === 0) return;
  const one = live.length === 1 ? live[0] : null;
  dispatch(
    one
      ? { type: "deleteItem", id: one.id }
      : {
          type: "batch",
          ops: live.map((item) => ({
            type: "deleteItem" as const,
            id: item.id,
          })),
        }
  );
  after?.();
  notify(
    one
      ? `„${one.title.trim() || "Bez názvu"}“ je v koši`
      : `${live.length} vybraných je v koši`,
    true,
    "Obnovit"
  );
}

export function deleteFolderToTrash(
  folder: Folder,
  notify: (text: string, undo?: boolean, action?: string) => void,
  after?: () => void
) {
  dispatch({ type: "deleteFolder", id: folder.id });
  after?.();
  notify(`Složka „${folder.name}“ je v koši`, true, "Obnovit");
}

const DISMISSED_SUGGESTIONS = "ukoly-dismissed-suggestions";

function dismissedSuggestions() {
  try {
    const raw = localStorage.getItem(DISMISSED_SUGGESTIONS);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((entry) => typeof entry === "string"));
  } catch {
    return new Set<string>();
  }
}

function rememberDismissal(itemId: string, folderId: string) {
  const next = dismissedSuggestions();
  next.add(`${itemId}:${folderId}`);
  try {
    localStorage.setItem(
      DISMISSED_SUGGESTIONS,
      JSON.stringify([...next].slice(-400))
    );
  } catch {
    // Soukromý režim návrh jen schová do dalšího načtení.
  }
}

export function FolderHint({ item }: { item: Item }) {
  const { db } = useSnap();
  const ui = useUi();
  const [skipped, setSkipped] = useState(dismissedSuggestions);
  const folder = suggestFolders(db, item.title).find(
    (entry) =>
      entry.id !== item.folderId && !skipped.has(`${item.id}:${entry.id}`)
  );
  if (!folder) return null;
  const file = () => {
    const mapped = mapStatus(db, item.statusId, folder.id);
    const go = (statusId: string) => {
      dispatch(placeOp(db, item.id, folder.id, statusId));
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
      return;
    }
    if (mapped.statusId) go(mapped.statusId);
  };
  const reject = () => {
    rememberDismissal(item.id, folder.id);
    setSkipped(dismissedSuggestions());
  };
  return (
    <span className="flex shrink-0 items-center rounded-md bg-raised text-xs text-accent ring-1 ring-inset ring-accent">
      <button
        type="button"
        className="px-2 py-1"
        title={`Zařadit do ${folder.name}`}
        onPointerDown={keepControl}
        onMouseDown={keepControl}
        onClick={(event) => {
          keepControl(event);
          file();
        }}
      >
        {folder.name}
      </button>
      <button
        type="button"
        className="px-1.5 py-1 text-muted hover:text-ink"
        aria-label={`Odmítnout návrh ${folder.name}`}
        title="Odmítnout"
        onPointerDown={keepControl}
        onMouseDown={keepControl}
        onClick={(event) => {
          keepControl(event);
          reject();
        }}
      >
        ×
      </button>
    </span>
  );
}

export function TaskRow({
  item,
  showFolder = false,
  depth = 0,
}: {
  item: Item;
  showFolder?: boolean;
  depth?: number;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `item:${item.id}`,
    data: { kind: "item", itemId: item.id },
  });
  const dragClick = useDragGuard(isDragging);
  const checked = isChecked(db, item);
  const status = byId(db.statuses, item.statusId);
  const folder = byId(db.folders, item.folderId);
  const closed = folder ? resolvedClosed(db, folder) : null;
  const middle =
    status && closed && status.id !== closed.id && status.meaning !== "todo";
  const today = todayKey();
  const when = whenLabel(item, today);
  const overdue = Boolean(
    item.dueAt && item.dueAt.slice(0, 10) < today && isOpenItem(db, item)
  );
  const tags = tagsOf(db, item.id);
  const person = byId(db.people, item.assigneeId);
  const blocked = blockingItems(db, item.id).length > 0;
  const children = subtasksOf(db, item.id);
  const repeat = recurrenceLabel(item);
  const preview = item.body?.trim() ?? "";

  const toggle = () => toggleComplete(db, item, ui.askConfirm);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        paddingLeft: 12 + depth * 20,
      }}
      className={cx(
        "group flex cursor-grab items-start gap-0.5 rounded-lg pr-1 active:cursor-grabbing",
        itemMarked(ui.picked, ui.selectedId, item.id)
          ? "bg-accent/20"
          : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
        isDragging && "opacity-0"
      )}
      {...attributes}
      {...listeners}
      tabIndex={-1}
      role={undefined}
      data-task-id={item.id}
      data-activity-focus={ui.focusId === item.id ? "" : undefined}
      onMouseDown={(event) => {
        listeners?.onMouseDown?.(event);
        if (event.shiftKey || event.metaKey || event.ctrlKey)
          event.preventDefault();
      }}
      onClick={(event) => {
        if (dragClick()) return;
        clickItem(ui, item.id, event);
      }}
    >
      <label
        className="grid size-11 shrink-0 place-items-center"
        onPointerDown={keepControl}
        onMouseDown={keepControl}
        onTouchStart={keepControl}
        onClick={keepControl}
      >
        <input
          className="size-6 accent-[var(--accent)]"
          type="checkbox"
          checked={checked}
          onChange={toggle}
          aria-label={checked ? "Označit jako otevřené" : "Označit jako hotové"}
        />
      </label>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="w-full min-w-0 pt-2.5 pb-2 text-left">
          <div className="flex w-full min-w-0 items-center gap-1.5">
            <ItemTitle
              item={item}
              struck={checked}
              dragClick={dragClick}
              truncate={false}
              clamp
              className="min-w-0 flex-1 leading-6"
            />
            {person && <PersonBadge person={person} />}
          </div>
          {ui.editingBodyId === item.id ? (
            <TaskBodyEditor item={item} struck={checked} />
          ) : (
            preview && (
              <div
                className={cx(
                  "mt-0.5 cursor-text text-sm leading-5 text-muted",
                  checked && "line-through"
                )}
                onPointerDown={keepControl}
                onMouseDown={keepControl}
                onClick={(event) => {
                  keepControl(event);
                  ui.editBody(item.id);
                }}
              >
                <MarkdownField
                  value={item.body ?? ""}
                  editable={false}
                  density="inline"
                />
              </div>
            )
          )}
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {isOpenItem(db, item) && <FolderHint item={item} />}
            <Dictated item={item} />
            {showFolder && folder && (
              <span>
                {folderTrail(db, folder.id).map((entry, index) => (
                  <span key={entry.id}>
                    {index > 0 && " / "}
                    <Link
                      href={
                        entry.system === "inbox"
                          ? "/inbox"
                          : `/folder/${entry.id}`
                      }
                      className="hover:text-ink"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {entry.name}
                    </Link>
                  </span>
                ))}
              </span>
            )}
            {middle && status && (
              <span className="text-accent">{status.name}</span>
            )}
            {when && (
              <span className={overdue ? "text-danger" : ""}>{when}</span>
            )}
            {repeat && <span>{repeat}</span>}
            {blocked && <span>čeká</span>}
            {children.length > 0 && (
              <span>
                {children.filter((child) => !isOpenItem(db, child)).length}/
                {children.length}
              </span>
            )}
            {tags.map((tag) => (
              <Link
                key={tag.id}
                href={`/tag/${tag.id}`}
                className="hover:text-ink"
                onClick={(event) => event.stopPropagation()}
              >
                <TagMark name={tag.name} color={tag.color} />
              </Link>
            ))}
          </span>
        </div>
      </div>
      {item.type === "task" && (
        <span className="mt-0.5">
          <PriorityNudge item={item} />
        </span>
      )}
    </div>
  );
}

export function ListView({ folder, items }: { folder: Folder; items: Item[] }) {
  const { db } = useSnap();
  const ui = useUi();
  const showDone = ui.showDone;
  const statuses = statusesOf(db, folder.id);
  const rank = (item: Item) => {
    const index = statuses.findIndex((status) => status.id === item.statusId);
    return index === -1 ? statuses.length : index;
  };
  const visible = items
    .filter((item) => showDone || isOpenItem(db, item))
    .sort((a, b) => rank(a) - rank(b) || (a.sortOrder < b.sortOrder ? -1 : 1));
  return (
    <div>
      <div className="mb-1 flex items-center justify-end gap-1">
        <SortMenu folder={folder} />
        <DoneFilter showDone={showDone} onChange={ui.setShowDone} />
      </div>
      <ItemList items={visible} />
      <TaskComposer folder={folder} />
    </div>
  );
}

function TaskComposer({ folder }: { folder: Folder }) {
  const { db } = useSnap();
  const ui = useUi();
  const ref = useRef<HTMLTextAreaElement>(null);
  const skip = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const token = tokenAtCaret(draft, caret);
  const tokenKey = token?.kind === "tag" ? `${token.start}:${token.query}` : "";
  const tags =
    token?.kind === "tag" && !tagQueryExact(db, token.query)
      ? suggestTags(db, token.query)
      : [];
  const open =
    token?.kind === "tag" && dismissedKey !== tokenKey && tags.length > 0;
  const picked = Math.min(highlight, Math.max(tags.length - 1, 0));
  useEffect(() => {
    setHighlight(0);
  }, [tokenKey]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
    const next = pendingCaret.current;
    if (next === null) return;
    pendingCaret.current = null;
    node.focus();
    node.setSelectionRange(next, next);
    setCaret(next);
  });
  const acceptTag = (name: string) => {
    if (token?.kind !== "tag") return;
    const after = draft.slice(token.end);
    const insertion =
      after.length > 0 && !/^\s/.test(after) ? `#${name} ` : `#${name}`;
    pendingCaret.current = token.start + insertion.length;
    setDraft(`${draft.slice(0, token.start)}${insertion}${after}`);
    setDismissedKey(null);
  };
  const commit = () => {
    const inbox = inboxFolder(db);
    const { ops, itemIds } = opsFromTaskDraft(db, draft, {
      folderId: folder.id,
      statusId: resolvedOpen(db, folder)?.id ?? null,
      dateRole: "due",
      applyRules: folder.system === "inbox",
      ids: () => nanoid(10),
      today: todayKey(),
    });
    if (itemIds.length === 0) return;
    const next = dispatch({ type: "batch", ops });
    setDraft("");
    if (!inbox || folder.system !== "inbox") return;
    const moved = itemIds.flatMap((id) => {
      const item = byId(next.items, id);
      return item && item.folderId !== inbox.id ? [item] : [];
    });
    if (moved.length === 1) {
      const home = byId(next.folders, moved[0]?.folderId ?? null);
      ui.pushToast(home ? `Zařazeno do ${home.name}` : "Zařazeno", true);
    } else if (moved.length > 1) {
      ui.pushToast("Zařazeno podle pravidel.", true);
    }
  };
  return (
    <div className="relative mt-1 py-2 pl-12 pr-3 text-base leading-6">
      {open && (
        <div
          role="listbox"
          aria-label="Tagy"
          className="absolute bottom-full left-12 z-30 mb-1 w-64 overflow-hidden rounded-lg border border-line bg-raised shadow-[var(--shadow)]"
        >
          {tags.map((tag, index) => (
            <button
              key={tag.id}
              type="button"
              role="option"
              aria-selected={index === picked}
              className={cx(
                "flex w-full items-center px-3 py-1.5 text-left text-sm",
                index === picked
                  ? "bg-accent-soft"
                  : "hover:bg-black/5 dark:hover:bg-white/10"
              )}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => acceptTag(tag.name)}
            >
              <TagMark name={tag.name} color={tag.color} />
            </button>
          ))}
        </div>
      )}
      <div className="flex items-start gap-1">
        <textarea
          ref={ref}
          autoFocus
          rows={1}
          aria-label="Nový úkol"
          placeholder="Nový úkol…"
          data-task-composer=""
          className="block min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none placeholder:text-muted"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setCaret(event.target.selectionStart ?? 0);
          }}
          onSelect={(event) =>
            setCaret(event.currentTarget.selectionStart ?? 0)
          }
          onKeyDown={(event) => {
            if (
              open &&
              (event.key === "ArrowDown" || event.key === "ArrowUp")
            ) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((index) => {
                const current = Math.min(index, tags.length - 1);
                return (current + step + tags.length) % tags.length;
              });
              return;
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (open) {
                const tag = tags[picked];
                if (tag) acceptTag(tag.name);
                return;
              }
              commit();
              return;
            }
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (open) {
              setDismissedKey(tokenKey);
              return;
            }
            skip.current = true;
            setDraft("");
            event.currentTarget.blur();
          }}
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof Element &&
              event.relatedTarget.closest("[data-dictate]")
            )
              return;
            if (skip.current) {
              skip.current = false;
              return;
            }
            commit();
          }}
        />
        <DictateButton
          value={draft}
          onChange={(next) => {
            setDraft(next);
            setCaret(next.length);
          }}
        />
      </div>
    </div>
  );
}

export function DoneFilter({
  showDone,
  onChange,
}: {
  showDone: boolean;
  onChange: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
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
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Filtr"
        aria-expanded={open}
        aria-pressed={showDone}
        className={cx(
          "grid size-8 place-items-center rounded-md",
          showDone
            ? "text-accent"
            : "text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <ListFilter size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 min-w-48 rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow)]">
          <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(event) => onChange(event.target.checked)}
            />
            Zobrazit hotové
          </label>
        </div>
      )}
    </div>
  );
}

export function BoardView({ folder }: { folder: Folder }) {
  const { db } = useSnap();
  const ui = useUi();
  const statuses = statusesOf(db, folder.id).filter(
    (status) =>
      ui.showDone ||
      (status.meaning !== "done" && status.meaning !== "cancelled")
  );
  const items = db.items.filter(
    (item) =>
      !item.isDeleted &&
      !item.isArchived &&
      item.folderId === folder.id &&
      item.type === "task" &&
      (ui.showDone || isOpenItem(db, item))
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 items-center justify-end gap-1">
        <SortMenu folder={folder} />
        <DoneFilter showDone={ui.showDone} onChange={ui.setShowDone} />
      </div>
      <div className="board-row board-fill -mx-4 min-h-0 w-[calc(100%+2rem)] flex-1 px-4 lg:-mx-8 lg:w-[calc(100%+4rem)] lg:px-8">
        {statuses.map((status) => {
          const column = items
            .filter((item) => item.statusId === status.id)
            .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
          return (
            <BoardColumn
              key={status.id}
              status={status}
              folder={folder}
              items={column}
            />
          );
        })}
      </div>
    </div>
  );
}

function boardSort() {
  return null;
}

const SORT_MODES: { id: ItemSort | null; label: string }[] = [
  { id: null, label: "Ručně" },
  { id: "priority", label: "Priorita" },
  { id: "created", label: "Datum přidání" },
];

function SortMenu({ folder }: { folder: Folder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = folder.itemSort ?? null;
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
  const pick = (mode: ItemSort | null) => {
    setOpen(false);
    if (mode === active) return;
    dispatch({
      type: "updateFolder",
      id: folder.id,
      patch: { itemSort: mode },
    });
  };
  const current =
    SORT_MODES.find((mode) => mode.id === active)?.label ?? "Ručně";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={active ? `Řazení: ${current}` : "Řazení"}
        aria-expanded={open}
        aria-pressed={active !== null}
        title="Řazení"
        className={cx(
          "grid size-8 place-items-center rounded-md",
          active
            ? "text-accent"
            : "text-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/10"
        )}
        onClick={() => setOpen((value) => !value)}
      >
        <ArrowDownWideNarrow size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 min-w-44 rounded-lg border border-line bg-raised p-1 shadow-[var(--shadow)]">
          {SORT_MODES.map((mode) => (
            <button
              key={mode.label}
              type="button"
              role="menuitemradio"
              aria-checked={mode.id === active}
              className={cx(
                "flex w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10",
                mode.id === active && "text-accent"
              )}
              onClick={() => pick(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  status,
  folder,
  items,
}: {
  status: Status;
  folder: Folder;
  items: Item[];
}) {
  const { active } = useDndContext();
  const slot = useBoardSlot();
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  useLayoutEffect(() => {
    const node = draftRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, [title, adding]);
  const add = () => {
    const raw = title.replace(/\r\n/g, "\n");
    const breakAt = raw.indexOf("\n");
    const name = (breakAt === -1 ? raw : raw.slice(0, breakAt)).trim();
    const body = breakAt === -1 ? "" : raw.slice(breakAt + 1).trim();
    if (!name) {
      setAdding(false);
      return;
    }
    dispatch({
      type: "createItem",
      item: newItem({
        id: nanoid(10),
        folderId: folder.id,
        title: name,
        statusId: status.id,
        ...(body ? { body } : {}),
      }),
    });
    setTitle("");
    requestAnimationFrame(() =>
      draftRef.current?.scrollIntoView({ block: "nearest" })
    );
  };
  const { setNodeRef } = useDroppable({
    id: `status:${status.id}`,
    data: { kind: "status", statusId: status.id, folderId: folder.id },
  });
  const activeItemId =
    active && String(active.id).startsWith("item:")
      ? String(active.id).slice("item:".length)
      : null;
  const showMark =
    slot !== null && slot.statusId === status.id && activeItemId !== null;
  return (
    <section
      ref={setNodeRef}
      className={cx(
        "board-col flex max-h-[70dvh] min-h-0 flex-col rounded-lg border bg-panel p-3",
        showMark ? "border-accent" : "border-line"
      )}
      data-meaning={status.meaning}
      data-board-status={status.id}
      data-board-folder={folder.id}
    >
      <header className="mb-3 flex items-center gap-3 px-1">
        <span className="min-w-0 flex-1 truncate font-display text-lg">
          {status.name}
        </span>
        <span className="rounded-sm bg-black/5 px-1.5 py-0.5 text-xs text-muted dark:bg-white/10">
          {items.length}
        </span>
      </header>
      <div className="relative min-h-24 flex-1 overflow-y-auto">
        <SortableContext
          items={items.map((item) => `item:${item.id}`)}
          strategy={boardSort}
        >
          {items.map((item) => (
            <div key={item.id}>
              {showMark && slot?.beforeId === item.id && <BoardGap />}
              <BoardCard item={item} />
            </div>
          ))}
        </SortableContext>
        {showMark && slot?.beforeId == null && <BoardGap />}
        {adding ? (
          <form
            className="mb-2 min-h-10 rounded-md border border-dashed border-accent bg-black/[0.04] px-3 py-2.5 dark:bg-white/[0.06]"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <div className="flex items-start gap-1">
              <textarea
                ref={draftRef}
                autoFocus
                rows={1}
                className="block min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-5 outline-none"
                placeholder="Název a Enter"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={(event) => {
                  if (
                    event.relatedTarget instanceof Element &&
                    event.relatedTarget.closest("[data-dictate]")
                  )
                    return;
                  if (!title.trim()) setAdding(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setTitle("");
                    setAdding(false);
                    return;
                  }
                  if (
                    event.key !== "Enter" ||
                    event.shiftKey ||
                    event.altKey ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  event.preventDefault();
                  add();
                }}
              />
              <DictateButton value={title} onChange={setTitle} />
            </div>
          </form>
        ) : (
          <button
            type="button"
            aria-label={`Přidat kartu do sloupce ${status.name}`}
            className="board-add mb-2 flex h-10 w-full items-center gap-2 rounded-md border border-dashed border-line bg-raised px-3 text-sm hover:bg-black/[0.05] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]"
            onClick={() => setAdding(true)}
          >
            <Plus size={15} />
            Přidat
          </button>
        )}
      </div>
    </section>
  );
}

function BoardGap() {
  return (
    <div
      aria-hidden
      data-board-gap=""
      className="pointer-events-none mb-2 h-10 rounded-md border-2 border-dashed border-accent bg-accent/20"
    />
  );
}

function BoardCard({ item }: { item: Item }) {
  const ui = useUi();
  const { db } = useSnap();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `item:${item.id}`,
    data: { kind: "item", itemId: item.id },
  });
  const dragClick = useDragGuard(isDragging);
  const displaced = useDragDisplaced(isDragging);
  const tags = tagsOf(db, item.id);
  const person = byId(db.people, item.assigneeId);
  const repeat = recurrenceLabel(item);
  const when = whenLabel(item, todayKey());
  const hasMeta = Boolean(
    when ||
      repeat ||
      tags.length > 0 ||
      item.place ||
      item.origin ||
      item.spot ||
      item.amount ||
      item.variableSymbol ||
      phonesIn(item.title).length > 0
  );
  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(displaced
          ? {
              height: 0,
              minHeight: 0,
              margin: 0,
              padding: 0,
              borderWidth: 0,
              overflow: "hidden",
              opacity: 0,
            }
          : null),
      }}
      className={cx(
        "group mb-2 flex cursor-grab flex-col rounded-md border px-3 active:cursor-grabbing",
        itemMarked(ui.picked, ui.selectedId, item.id)
          ? "border-accent bg-accent/25"
          : "border-line bg-black/[0.04] hover:border-muted/40 dark:bg-white/[0.06] dark:hover:border-white/20",
        isDragging && "pointer-events-none opacity-0"
      )}
      {...attributes}
      {...listeners}
      tabIndex={-1}
      role={undefined}
      data-task-id={item.id}
      data-activity-focus={ui.focusId === item.id ? "" : undefined}
      onMouseDown={(event) => {
        listeners?.onMouseDown?.(event);
        if (event.shiftKey || event.metaKey || event.ctrlKey)
          event.preventDefault();
      }}
      onClick={(event) => {
        if (dragClick()) return;
        clickItem(ui, item.id, event);
      }}
    >
      <div className="flex min-h-10 items-center gap-2">
        <ItemTitle
          item={item}
          dragClick={dragClick}
          truncate={false}
          className="min-w-0 flex-1 py-2 text-sm font-medium leading-5"
        />
        {person && <PersonBadge person={person} />}
        <PriorityNudge item={item} />
      </div>
      {hasMeta && (
        <span className="-mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-2 text-xs leading-4 text-muted">
          {when && <span>{when}</span>}
          {repeat && <span>{repeat}</span>}
          <Dictated item={item} />
          {tags.map((tag) => (
            <Link
              key={tag.id}
              href={`/tag/${tag.id}`}
              className="hover:text-ink"
              onClick={(event) => event.stopPropagation()}
            >
              <TagMark name={tag.name} color={tag.color} />
            </Link>
          ))}
        </span>
      )}
      {isOpenItem(db, item) && (
        <div className="w-fit pb-2 empty:hidden">
          <FolderHint item={item} />
        </div>
      )}
    </article>
  );
}

export function ItemList({
  items,
  showFolder = false,
}: {
  items: Item[];
  showFolder?: boolean;
}) {
  if (items.length === 0) return null;
  const rows = nestOutline(items);
  return (
    <SortableContext
      items={rows.map((row) => `item:${row.item.id}`)}
      strategy={verticalListSortingStrategy}
    >
      <div className="grid gap-0.5" data-task-list="">
        {rows.map((row) => (
          <TaskRow
            key={row.item.id}
            item={row.item}
            showFolder={showFolder}
            depth={row.depth}
          />
        ))}
      </div>
    </SortableContext>
  );
}

export function indentListedTask(
  db: { items: Item[] },
  id: string,
  outdent: boolean
) {
  const ids = taskListIds(id);
  if (!ids.includes(id)) return false;
  const visible = ids.flatMap((taskId) => {
    const item = byId(db.items, taskId);
    return item ? [item] : [];
  });
  const item = byId(db.items, id);
  if (!item || item.type !== "task") return false;
  const pool = db.items.filter(
    (entry) =>
      !entry.isDeleted &&
      entry.type === "task" &&
      entry.folderId === item.folderId
  );
  const patches = outdent
    ? outdentOutline(visible, pool, id)
    : indentOutline(visible, pool, id);
  if (patches.length > 0) {
    const ops = patches.map((patch) => ({
      type: "updateItem" as const,
      id: patch.id,
      patch: { parentItemId: patch.parentItemId, sortOrder: patch.sortOrder },
    }));
    const [only] = ops;
    dispatch(ops.length === 1 && only ? only : { type: "batch", ops });
  }
  return true;
}

function taskListIds(id: string): string[] {
  const row = [
    ...document.querySelectorAll<HTMLElement>(
      "[data-task-list] [data-task-id]"
    ),
  ].find((el) => el.dataset.taskId === id);
  const list = row?.closest("[data-task-list]");
  if (!list) return [];
  const ids: string[] = [];
  for (const el of list.querySelectorAll<HTMLElement>("[data-task-id]")) {
    const taskId = el.dataset.taskId;
    if (!taskId || el.getClientRects().length === 0) continue;
    ids.push(taskId);
  }
  return ids;
}

export function DescendantLists({ folders }: { folders: Folder[] }) {
  const { db } = useSnap();
  const ui = useUi();
  return (
    <div className="mt-6 grid gap-5">
      {folders.map((folder) => {
        const items = db.items
          .filter(
            (item) =>
              !item.isDeleted &&
              !item.isArchived &&
              item.folderId === folder.id &&
              item.type === "task" &&
              (ui.showDone || isOpenItem(db, item))
          )
          .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
        if (items.length === 0) return null;
        const rows = nestOutline(items);
        return (
          <section key={folder.id}>
            <h3 className="mb-1 px-2 text-sm text-muted">{folder.name}</h3>
            <SortableContext
              items={rows.map((row) => `item:${row.item.id}`)}
              strategy={verticalListSortingStrategy}
            >
              <div data-task-list="">
                {rows.map((row) => (
                  <TaskRow
                    key={row.item.id}
                    item={row.item}
                    depth={row.depth}
                  />
                ))}
              </div>
            </SortableContext>
          </section>
        );
      })}
    </div>
  );
}
