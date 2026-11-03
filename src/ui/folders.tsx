import {
  useDndContext,
  useDraggable,
  useDroppable,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { nanoid } from "nanoid";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Link, useLocation } from "wouter";
import { dispatch, useSnap } from "../data/store.tsx";
import {
  DEFAULT_FOLDER_COLOR,
  isPaletteColor,
  paintCss,
  type FolderPaint,
} from "../domain/color.ts";
import { byId, descendantFolderIds, statusesOf } from "../domain/db.ts";
import { viewLabel } from "../domain/labels.ts";
import {
  folderTrail,
  inboxWaitingCount,
  openTaskCount,
  shownChildFolders,
} from "../domain/select.ts";
import {
  FOLDER_COLOR_LABELS,
  FOLDER_COLOR_ORDER,
  type Folder,
  type StatusMeaning,
  type ViewMode,
} from "../domain/types.ts";
import { folderEmoji } from "./emoji.ts";
import {
  folderDropLabel,
  useFolderDrag,
  type FolderDropIntent,
} from "./folderDrop.ts";
import { FolderPicker } from "./folderPick.tsx";
import { useUi } from "./state.tsx";
import { deleteFolderToTrash } from "./tasks.tsx";
import {
  Button,
  control,
  cx,
  Dialog,
  Disclosure,
  Field,
  useDragDisplaced,
} from "./ui.tsx";

const ICONS = ["🏠", "🛒", "🔨", "💡", "📐", "🌿", "💊", "📞", "📦", "✏️"];

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

function rowListeners(listeners: DraggableSyntheticListeners) {
  if (!listeners) return undefined;
  return {
    ...listeners,
    onKeyDown(event: ReactKeyboardEvent) {
      if (event.target !== event.currentTarget) return;
      listeners.onKeyDown?.(event);
    },
  };
}

function keepRowControl(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

type TreeOpen = {
  isOpen: (id: string, depth: number) => boolean;
  toggle: (id: string, depth: number) => void;
  ensureOpen: (id: string) => void;
  openOnly: (id: string) => void;
};

const TreeOpenContext = createContext<TreeOpen | null>(null);

function useOpenForNote(folderId: string, open: (id: string) => void) {
  useEffect(() => {
    const onOver = (event: Event) => {
      if ((event as CustomEvent<string>).detail === folderId) open(folderId);
    };
    document.addEventListener("ordo-note-over", onOver);
    return () => document.removeEventListener("ordo-note-over", onOver);
  }, [folderId, open]);
}

function TreeOpenProvider({
  children,
  openRoots = true,
}: {
  children: ReactNode;
  openRoots?: boolean;
}) {
  const { db } = useSnap();
  const [forced, setForced] = useState<Record<string, boolean>>({});
  const api = useMemo<TreeOpen>(() => {
    const startsOpen = (depth: number) => openRoots && depth < 1;
    return {
      isOpen(id, depth) {
        const stored = forced[id];
        return stored === undefined ? startsOpen(depth) : stored;
      },
      toggle(id, depth) {
        setForced((current) => {
          const stored = current[id];
          const open = stored === undefined ? startsOpen(depth) : stored;
          return { ...current, [id]: !open };
        });
      },
      ensureOpen(id) {
        setForced((current) =>
          current[id] === true ? current : { ...current, [id]: true }
        );
      },
      openOnly(id) {
        const trail = new Set(folderTrail(db, id).map((folder) => folder.id));
        const next: Record<string, boolean> = {};
        for (const folder of db.folders) {
          if (folder.isDeleted) continue;
          next[folder.id] = trail.has(folder.id);
        }
        setForced(next);
      },
    };
  }, [db, forced, openRoots]);
  return (
    <TreeOpenContext.Provider value={api}>{children}</TreeOpenContext.Provider>
  );
}

function useTreeOpen() {
  const value = useContext(TreeOpenContext);
  if (!value) throw new Error("Strom složek nemá stav rozbalení.");
  return value;
}

function FolderMenu({ folder }: { folder: Folder }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, right: 0 });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !ref.current?.contains(event.target)
      )
        close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);
  return (
    <div ref={ref}>
      <button
        type="button"
        className={cx(
          "grid size-7 shrink-0 place-items-center rounded-lg hover:bg-black/5 focus-visible:opacity-100 dark:hover:bg-white/10",
          open
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 max-lg:opacity-100"
        )}
        aria-label="Akce složky"
        aria-expanded={open}
        aria-haspopup="menu"
        onPointerDown={keepRowControl}
        onMouseDown={keepRowControl}
        onTouchStart={keepRowControl}
        onClick={() => {
          const rect = ref.current?.getBoundingClientRect();
          if (rect)
            setPlace({
              top: rect.bottom + 4,
              right: window.innerWidth - rect.right,
            });
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={16} className="text-muted" />
      </button>
      {open && (
        <div
          role="menu"
          className="fixed z-40 min-w-44 rounded-xl border border-line bg-raised p-1 shadow-[var(--shadow)]"
          style={{ top: place.top, right: place.right }}
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => {
              setOpen(false);
              ui.setFolderEdit({ id: folder.id, parentId: folder.parentId });
            }}
          >
            Upravit
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => {
              setOpen(false);
              ui.setFolderEdit({ id: null, parentId: folder.id });
            }}
          >
            Přidat podsložku
          </button>
          {folder.system !== "inbox" && (
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
              onClick={() => {
                setOpen(false);
                dispatch({
                  type: "updateFolder",
                  id: folder.id,
                  patch: { hidden: !folder.hidden },
                });
              }}
            >
              {folder.hidden ? "Zrušit skrytí" : "Skrýt"}
            </button>
          )}
          {folder.system !== "inbox" && (
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-danger/10"
              onClick={() => {
                setOpen(false);
                deleteFolderToTrash(folder, ui.pushToast);
              }}
            >
              <span className="text-danger">Smazat</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function gapLabel(folders: Folder[], folder: Folder, intent: FolderDropIntent) {
  const parent = byId(folders, folder.parentId);
  return folderDropLabel(intent, folder.name, parent?.name ?? null);
}

const treeStep = 24;

export function treePad(depth: number) {
  return 4 + depth * treeStep;
}

function FolderGap({
  depth,
  label,
  tall = false,
  indent,
}: {
  depth: number;
  label: string;
  tall?: boolean;
  indent?: number;
}) {
  return (
    <div
      data-folder-gap=""
      className={cx(
        "pointer-events-none flex items-center rounded-md border-2 border-dashed border-accent bg-accent/20 px-2 text-xs font-medium text-accent",
        tall ? "h-11" : "h-9"
      )}
      style={{ marginLeft: indent ?? treePad(depth), marginRight: 4 }}
    >
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

export function FolderTree({
  parentId = null,
  depth = 0,
  scope = "side",
}: {
  parentId?: string | null;
  depth?: number;
  scope?: string;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const folders = shownChildFolders(db, parentId, ui.showHidden);
  const tree = (
    <div
      className="min-w-0"
      {...(parentId === null
        ? { "data-folder-tree": "", "data-folder-scope": scope }
        : {})}
    >
      {folders.map((folder) => (
        <FolderNode
          key={folder.id}
          folder={folder}
          depth={depth}
          scope={scope}
        />
      ))}
    </div>
  );
  if (parentId !== null) return tree;
  return <TreeOpenProvider>{tree}</TreeOpenProvider>;
}

function FolderNode({
  folder,
  depth,
  scope,
}: {
  folder: Folder;
  depth: number;
  scope: string;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const [location] = useLocation();
  const tree = useTreeOpen();
  const open = tree.isOpen(folder.id, depth);
  useOpenForNote(folder.id, tree.ensureOpen);
  const children = shownChildFolders(db, folder.id, ui.showHidden);
  const movable = folder.system !== "inbox";
  const drag = useDraggable({
    id: `folder:${folder.id}`,
    data: { kind: "folder", folderId: folder.id },
    disabled: !movable,
  });
  const drop = useDroppable({
    id: `folder-drop:${folder.id}`,
    data: { kind: "folder", folderId: folder.id },
  });
  const dragged = useDragGuard(drag.isDragging);
  const displaced = useDragDisplaced(drag.isDragging);
  const { active: dragActive } = useDndContext();
  const itemOver =
    drop.isOver && String(dragActive?.id ?? "").startsWith("item:");
  const folderDrag = useFolderDrag();
  const scopeMatch = folderDrag.scope === scope;
  const placing = scopeMatch && folderDrag.targetId === folder.id;
  const holdsReorder =
    scopeMatch &&
    !placing &&
    folderDrag.intent !== "inside" &&
    folderDrag.targetId !== null &&
    children.some((child) => child.id === folderDrag.targetId);
  const intent = folderDrag.intent;
  const label = gapLabel(db.folders, folder, intent);
  const href = folder.system === "inbox" ? "/inbox" : `/folder/${folder.id}`;
  const active = location === href;
  const waiting = folder.system === "inbox";
  const count = waiting ? inboxWaitingCount(db) : openTaskCount(db, folder.id);

  useEffect(() => {
    if (!location.startsWith("/folder/")) return;
    const currentId = location.slice("/folder/".length);
    if (currentId === folder.id) return;
    if (folderTrail(db, currentId).some((entry) => entry.id === folder.id))
      tree.ensureOpen(folder.id);
  }, [location, folder.id]);

  useEffect(() => {
    if ((placing && intent === "inside") || itemOver)
      tree.ensureOpen(folder.id);
  }, [placing, intent, itemOver]);

  return (
    <div
      className={
        displaced ? "hidden" : drag.isDragging ? "opacity-0" : undefined
      }
      data-folder-dragging={drag.isDragging ? "" : undefined}
    >
      {placing && intent === "before" && (
        <FolderGap depth={depth} label={label} />
      )}
      <div
        data-folder-row={folder.id}
        ref={(node) => {
          drag.setNodeRef(node);
          drop.setNodeRef(node);
        }}
        className={cx(
          "group flex h-9 min-w-0 items-center gap-1.5 rounded-md pr-0.5",
          itemOver || (placing && intent === "inside")
            ? "bg-accent-soft ring-2 ring-inset ring-accent"
            : active
            ? "bg-accent-soft text-accent"
            : "hover:bg-black/5 dark:hover:bg-white/10",
          holdsReorder && "bg-accent-soft ring-1 ring-inset ring-accent",
          movable && "cursor-grab active:cursor-grabbing"
        )}
        style={{ paddingLeft: treePad(depth) }}
        {...(movable ? drag.attributes : {})}
        {...(movable ? rowListeners(drag.listeners) : {})}
        tabIndex={-1}
        role={undefined}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="grid size-5 shrink-0 place-items-center rounded-md text-muted hover:bg-black/10 hover:text-ink dark:hover:bg-white/15"
            aria-expanded={open}
            aria-label={open ? "Sbalit" : "Rozbalit"}
            onPointerDown={keepRowControl}
            onMouseDown={keepRowControl}
            onTouchStart={keepRowControl}
            onClick={() => tree.toggle(folder.id, depth)}
          >
            <ChevronRight
              size={16}
              className={cx("transition-transform", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="size-5" />
        )}
        <Link
          href={href}
          className="flex h-full min-w-0 flex-1 items-center gap-2"
          onClick={(event) => {
            if (dragged()) {
              event.preventDefault();
              return;
            }
            if (children.length > 0 && active) {
              event.preventDefault();
              tree.toggle(folder.id, depth);
              return;
            }
            tree.openOnly(folder.id);
            ui.setMenuOpen(false);
            ui.select(null);
          }}
        >
          <Dot color={folder.color} icon={folder.icon} />
          <span className={cx("truncate", folder.hidden && "text-muted")}>
            {folder.name}
          </span>
          {(waiting || (children.length === 0 && count > 0)) && (
            <span
              title={waiting ? "Ještě čeká na zařazení" : undefined}
              className={cx(
                "ml-auto rounded-sm px-1.5 text-xs",
                active
                  ? "bg-accent/15 text-accent"
                  : "bg-black/5 text-muted dark:bg-white/10"
              )}
            >
              {count}
            </span>
          )}
        </Link>
        <FolderMenu folder={folder} />
      </div>
      {placing && intent === "inside" && (
        <FolderGap depth={depth + 1} label={label} />
      )}
      {open && children.length > 0 && (
        <FolderTree parentId={folder.id} depth={depth + 1} scope={scope} />
      )}
      {placing && intent === "after" && (
        <FolderGap depth={depth} label={label} />
      )}
    </div>
  );
}

export function FolderChildren({ parentId }: { parentId: string }) {
  const { db } = useSnap();
  const ui = useUi();
  const folders = shownChildFolders(db, parentId, ui.showHidden);
  if (folders.length === 0) return null;
  return (
    <TreeOpenProvider openRoots={false}>
      <div
        className="mb-4 grid gap-0.5"
        data-folder-tree=""
        data-folder-scope="page"
      >
        {folders.map((folder) => (
          <PageFolderRow
            key={folder.id}
            folder={folder}
            scope="page"
            depth={0}
          />
        ))}
      </div>
    </TreeOpenProvider>
  );
}

function PageFolderRow({
  folder,
  scope,
  depth,
}: {
  folder: Folder;
  scope: string;
  depth: number;
}) {
  const { db } = useSnap();
  const [location] = useLocation();
  const tree = useTreeOpen();
  const open = tree.isOpen(folder.id, depth);
  useOpenForNote(folder.id, tree.ensureOpen);
  const ui = useUi();
  const children = shownChildFolders(db, folder.id, ui.showHidden);
  const drag = useDraggable({
    id: `page-folder:${folder.id}`,
    data: { kind: "folder", folderId: folder.id },
    disabled: folder.system === "inbox",
  });
  const drop = useDroppable({
    id: `page-folder-drop:${folder.id}`,
    data: { kind: "folder", folderId: folder.id },
  });
  const dragged = useDragGuard(drag.isDragging);
  const displaced = useDragDisplaced(drag.isDragging);
  const { active: dragActive } = useDndContext();
  const itemOver =
    drop.isOver && String(dragActive?.id ?? "").startsWith("item:");
  const folderDrag = useFolderDrag();
  const placing =
    folderDrag.scope === scope && folderDrag.targetId === folder.id;
  const intent = folderDrag.intent;
  const label = gapLabel(db.folders, folder, intent);
  const count = openTaskCount(db, folder.id);
  const href = folder.system === "inbox" ? "/inbox" : `/folder/${folder.id}`;
  const active = location === href;
  const pad = 12 + depth * 20;
  useEffect(() => {
    if (!location.startsWith("/folder/")) return;
    const currentId = location.slice("/folder/".length);
    if (currentId === folder.id) return;
    if (folderTrail(db, currentId).some((entry) => entry.id === folder.id))
      tree.ensureOpen(folder.id);
  }, [location, folder.id]);
  return (
    <div
      className={
        displaced ? "hidden" : drag.isDragging ? "opacity-0" : undefined
      }
      data-folder-dragging={drag.isDragging ? "" : undefined}
    >
      {placing && intent === "before" && (
        <FolderGap depth={depth} indent={pad} label={label} tall />
      )}
      <div
        data-folder-row={folder.id}
        ref={(node) => {
          drag.setNodeRef(node);
          drop.setNodeRef(node);
        }}
        className={cx(
          "flex h-11 items-center gap-2 rounded-md pr-3",
          itemOver || (placing && intent === "inside")
            ? "bg-accent-soft ring-2 ring-inset ring-accent"
            : "hover:bg-black/5 dark:hover:bg-white/10",
          folder.system !== "inbox" && "cursor-grab active:cursor-grabbing"
        )}
        style={{ paddingLeft: pad }}
        {...(folder.system === "inbox" ? {} : drag.attributes)}
        {...(folder.system === "inbox" ? {} : rowListeners(drag.listeners))}
        tabIndex={-1}
        role={undefined}
      >
        {children.length > 0 ? (
          <button
            type="button"
            className="grid size-5 shrink-0 place-items-center rounded-md text-muted hover:bg-black/10 hover:text-ink dark:hover:bg-white/15"
            aria-expanded={open}
            aria-label={open ? "Sbalit" : "Rozbalit"}
            onPointerDown={keepRowControl}
            onMouseDown={keepRowControl}
            onTouchStart={keepRowControl}
            onClick={() => tree.toggle(folder.id, depth)}
          >
            <ChevronRight
              size={16}
              className={cx("transition-transform", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="size-5" />
        )}
        <Link
          href={href}
          className="flex h-full min-w-0 flex-1 items-center gap-3"
          onClick={(event) => {
            if (dragged()) {
              event.preventDefault();
              return;
            }
            if (children.length > 0 && active) {
              event.preventDefault();
              tree.toggle(folder.id, depth);
              return;
            }
            tree.openOnly(folder.id);
          }}
        >
          <Dot color={folder.color} icon={folder.icon} />
          <span
            className={cx(
              "min-w-0 flex-1 truncate",
              folder.hidden && "text-muted"
            )}
          >
            {folder.name}
          </span>
          {count > 0 && <span className="text-xs text-muted">{count}</span>}
        </Link>
      </div>
      {placing && intent === "inside" && (
        <FolderGap depth={depth + 1} indent={pad + 20} label={label} tall />
      )}
      {open &&
        children.map((child) => (
          <PageFolderRow
            key={child.id}
            folder={child}
            scope={scope}
            depth={depth + 1}
          />
        ))}
      {placing && intent === "after" && (
        <FolderGap depth={depth} indent={pad} label={label} tall />
      )}
    </div>
  );
}

export function RootDrop() {
  const { active } = useDndContext();
  const data = active?.data.current as { kind?: string } | undefined;
  const dragging = data?.kind === "folder";
  const drop = useDroppable({
    id: "folder-drop:root",
    data: { kind: "folder", folderId: null },
  });
  return (
    <div
      ref={drop.setNodeRef}
      data-folder-root=""
      className={cx(
        "mx-2 mt-2 rounded-xl border border-dashed border-line px-3 py-2 text-xs text-muted",
        !dragging && !drop.isOver && "hidden",
        drop.isOver && "border-accent bg-accent-soft text-accent"
      )}
    >
      Sem přetáhni složku na nejvyšší úroveň
    </div>
  );
}

export function FolderCrumbs({
  folderId,
  parentsOnly = false,
  scope = "page",
}: {
  folderId: string | null;
  parentsOnly?: boolean;
  scope?: string;
}) {
  const { db } = useSnap();
  const ui = useUi();
  const anchor = parentsOnly
    ? byId(db.folders, folderId)?.parentId ?? null
    : folderId;
  const crumbs = [
    { key: "home", folderId: null as string | null, name: "Domů", href: "/" },
    ...folderTrail(db, anchor).map((folder) => ({
      key: folder.id,
      folderId: folder.id,
      name: folder.name,
      href: folder.system === "inbox" ? "/inbox" : `/folder/${folder.id}`,
    })),
  ];
  return (
    <nav
      aria-label="Cesta"
      className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted"
    >
      {crumbs.map((crumb, index) => (
        <span key={crumb.key} className="inline-flex items-center gap-1.5">
          {index > 0 && <span aria-hidden="true">/</span>}
          <Crumb
            scope={scope}
            folderId={crumb.folderId}
            href={crumb.href}
            name={crumb.name}
            onNavigate={() => {
              ui.setMenuOpen(false);
              ui.select(null);
            }}
          />
        </span>
      ))}
    </nav>
  );
}

function Crumb({
  scope,
  folderId,
  href,
  name,
  onNavigate,
}: {
  scope: string;
  folderId: string | null;
  href: string;
  name: string;
  onNavigate: () => void;
}) {
  const drop = useDroppable({
    id: folderId ? `crumb-drop:${scope}:${folderId}` : `crumb-idle:${scope}`,
    disabled: !folderId,
    data: { kind: "folder", folderId },
  });
  const { active } = useDndContext();
  const hot =
    Boolean(folderId) &&
    drop.isOver &&
    String(active?.id ?? "").startsWith("item:");
  return (
    <span
      ref={drop.setNodeRef}
      data-note-folder={folderId ?? undefined}
      className={cx(
        "inline-flex rounded-sm px-0.5",
        hot && "bg-accent-soft ring-2 ring-inset ring-accent"
      )}
    >
      <Link
        href={href}
        className={cx("rounded-sm", hot ? "text-accent" : "hover:text-ink")}
        onClick={onNavigate}
      >
        {name}
      </Link>
    </span>
  );
}

export function FolderGlyph({
  color,
  className = "h-6",
}: {
  color: string | null;
  className?: string;
}) {
  const paint = paintCss(color);
  return (
    <svg
      viewBox="0 0 24 26"
      aria-hidden="true"
      className={cx("aspect-[12/13] w-auto shrink-0", className)}
    >
      <path
        fill={`color-mix(in srgb, ${paint} 72%, black)`}
        d="M1.8 9.2V5.2c0-1.2 1-2.2 2.2-2.2h6.6c.6 0 1.2.3 1.5.9l.9 1.4c.3.5.9.8 1.5.8h5.9c1.1 0 2 .9 2 2v1.5H1.8z"
      />
      <path
        fill={paint}
        d="M1.8 8h20.4c1 0 1.8.8 1.8 1.8v11.8c0 2-1.6 3.6-3.6 3.6H3.6C1.6 25.2 0 23.6 0 21.6V9.8C0 8.8.8 8 1.8 8z"
      />
    </svg>
  );
}

export function Dot({
  color,
  icon,
}: {
  color: string | null;
  icon: string | null;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <FolderGlyph color={color} />
      {icon ? <span className="text-[22px] leading-none">{icon}</span> : null}
    </span>
  );
}

function colorInputValue(color: FolderPaint): string {
  if (!isPaletteColor(color)) return color;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--${color}`)
    .trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : "#12826c";
}

export function FolderDialog() {
  const { db } = useSnap();
  const ui = useUi();
  const edit = ui.folderEdit;
  const folder = edit?.id
    ? db.folders.find((entry) => entry.id === edit.id) ?? null
    : null;
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState<FolderPaint>(DEFAULT_FOLDER_COLOR);
  const [keywords, setKeywords] = useState("");
  const [view, setView] = useState<ViewMode>("list");
  const [parentId, setParentId] = useState<string | null>(null);
  const [statusesOpen, setStatusesOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);

  useEffect(() => {
    if (!edit) return;
    const current = edit.id
      ? db.folders.find((entry) => entry.id === edit.id) ?? null
      : null;
    setName(current?.name ?? "");
    setIcon(current?.icon ?? null);
    setColor(current?.color ?? DEFAULT_FOLDER_COLOR);
    setKeywords(current?.keywords ?? "");
    setView(current?.defaultView ?? "list");
    setParentId(current?.parentId ?? edit.parentId);
    setStatusesOpen(false);
    setColumnsOpen(false);
  }, [edit]);

  if (!edit) return null;
  const statuses = folder ? statusesOf(db, folder.id) : [];
  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!folder) {
      const id = nanoid(10);
      dispatch({
        type: "batch",
        ops: [
          {
            type: "createFolder",
            id,
            parentId,
            name: trimmed,
            icon,
            color,
            statusIds: {
              todo: nanoid(10),
              doing: nanoid(10),
              done: nanoid(10),
            },
          },
          {
            type: "updateFolder",
            id,
            patch: { keywords: keywords.trim() || null, defaultView: view },
          },
        ],
      });
      ui.setFolderEdit(null);
      return;
    }
    dispatch({
      type: "batch",
      ops: [
        {
          type: "updateFolder",
          id: folder.id,
          patch: {
            name: folder.system === "inbox" ? folder.name : trimmed,
            icon,
            color,
            keywords: keywords.trim() || null,
            defaultView: view,
          },
        },
        ...(folder.system === "inbox"
          ? []
          : [
              {
                type: "moveFolder" as const,
                id: folder.id,
                parentId,
                sortOrder: folder.sortOrder,
              },
            ]),
      ],
    });
    ui.setFolderEdit(null);
  };
  return (
    <Dialog
      title={folder ? folder.name : "Nová složka"}
      onClose={() => ui.setFolderEdit(null)}
      onConfirm={save}
      wide
    >
      <div className="grid gap-3">
        <Field label="Název">
          <input
            className={control}
            value={name}
            disabled={folder?.system === "inbox"}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {folder?.system !== "inbox" && (
          <Field label="Nadřazená složka">
            <FolderPicker
              value={parentId}
              allowRoot
              excludeIds={
                folder ? [folder.id, ...descendantFolderIds(db, folder.id)] : []
              }
              onPick={setParentId}
            />
          </Field>
        )}
        <div className="grid gap-1 text-sm">
          <span className="text-muted">Ikona</span>
          <div className="flex flex-wrap items-center gap-1">
            {ICONS.map((value) => (
              <button
                key={value}
                type="button"
                className={cx(
                  "size-9 rounded-md",
                  icon === value && "bg-accent-soft"
                )}
                onClick={() => setIcon(icon === value ? null : value)}
              >
                {value}
              </button>
            ))}
            <input
              aria-label="Vlastní emoji"
              placeholder="vložit"
              className="h-9 w-16 rounded-md border border-transparent bg-black/[0.04] text-center text-base outline-none placeholder:text-xs placeholder:text-muted focus:border-accent dark:bg-white/[0.06]"
              value={icon ?? ""}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                const raw = event.target.value;
                if (!raw.trim()) {
                  setIcon(null);
                  return;
                }
                const next = folderEmoji(raw);
                if (next) setIcon(next);
              }}
            />
          </div>
        </div>
        <div className="grid grid-cols-8 gap-2.5">
          {FOLDER_COLOR_ORDER.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={FOLDER_COLOR_LABELS[value]}
              title={FOLDER_COLOR_LABELS[value]}
              className={cx(
                "size-7 rounded-full",
                color === value &&
                  "outline outline-2 outline-offset-2 outline-ink"
              )}
              style={{ background: `var(--${value})` }}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
        <label className="flex items-center gap-3 text-sm">
          <input
            type="color"
            aria-label="Vlastní barva"
            className={cx(
              "h-8 w-14 cursor-pointer rounded-md border border-line bg-transparent p-0.5",
              "[&::-webkit-color-swatch]:rounded-sm [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0",
              !isPaletteColor(color) &&
                "outline outline-2 outline-offset-2 outline-ink"
            )}
            value={colorInputValue(color)}
            onChange={(event) => {
              const next = event.target.value;
              if (/^#[0-9a-fA-F]{6}$/.test(next))
                setColor(next.toLowerCase() as FolderPaint);
            }}
          />
          <span className="text-muted">Vlastní barva</span>
        </label>
        <Field label="Klíčová slova">
          <input
            className={control}
            value={keywords}
            placeholder="dveře, okna, míry"
            onChange={(event) => setKeywords(event.target.value)}
          />
          <span className="text-xs leading-4 text-muted">
            Když je některé z těchto slov v názvu úkolu, nabídne se tahle složka
            k zařazení. Stejně funguje i samotný název složky.
          </span>
        </Field>
        <Field label="Výchozí pohled">
          <select
            className={control}
            value={view}
            onChange={(event) => setView(event.target.value as ViewMode)}
          >
            {(["list", "board", "notes", "calendar", "gantt"] as const).map((value) => (
              <option key={value} value={value}>
                {viewLabel(value)}
              </option>
            ))}
          </select>
        </Field>
        {folder && (
          <div className="grid gap-2">
            <Disclosure
              open={statusesOpen}
              label="Otevřený a hotový stav"
              onClick={() => setStatusesOpen((open) => !open)}
            />
            {statusesOpen && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Otevřený stav">
                  <select
                    className={control}
                    value={folder.openStatusId ?? ""}
                    onChange={(event) =>
                      dispatch({
                        type: "updateFolder",
                        id: folder.id,
                        patch: { openStatusId: event.target.value || null },
                      })
                    }
                  >
                    <option value="">Podle významu</option>
                    {statuses.map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Hotový stav">
                  <select
                    className={control}
                    value={folder.closedStatusId ?? ""}
                    onChange={(event) =>
                      dispatch({
                        type: "updateFolder",
                        id: folder.id,
                        patch: { closedStatusId: event.target.value || null },
                      })
                    }
                  >
                    <option value="">Podle významu</option>
                    {statuses.map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <Disclosure
              open={columnsOpen}
              label="Stavy"
              onClick={() => setColumnsOpen((open) => !open)}
            />
            {columnsOpen &&
              statuses.map((status, index) => (
                <div
                  key={status.id}
                  className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2"
                >
                  <input
                    className={control}
                    value={status.name}
                    onChange={(event) =>
                      dispatch({
                        type: "updateStatus",
                        id: status.id,
                        name: event.target.value,
                      })
                    }
                  />
                  <select
                    className={control}
                    value={status.meaning}
                    onChange={(event) =>
                      dispatch({
                        type: "updateStatus",
                        id: status.id,
                        meaning: event.target.value as StatusMeaning,
                      })
                    }
                  >
                    <option value="todo">K udělání</option>
                    <option value="doing">Dělám</option>
                    <option value="done">Hotovo</option>
                    <option value="cancelled">Zrušeno</option>
                    <option value="none">Nezařazeno</option>
                  </select>
                  <Button
                    onClick={() => {
                      if (index === 0) return;
                      const ids = statuses.map((entry) => entry.id);
                      const next = [...ids];
                      const previous = next[index - 1];
                      const current = next[index];
                      if (!previous || !current) return;
                      next[index - 1] = current;
                      next[index] = previous;
                      dispatch({
                        type: "reorderStatuses",
                        folderId: folder.id,
                        orderedIds: next,
                      });
                    }}
                  >
                    Výš
                  </Button>
                  <Button
                    tone="danger"
                    onClick={() =>
                      dispatch({ type: "deleteStatus", id: status.id })
                    }
                    disabled={statuses.length < 2}
                  >
                    Smazat
                  </Button>
                </div>
              ))}
            {columnsOpen && (
              <Button
                onClick={() =>
                  dispatch({
                    type: "createStatus",
                    id: nanoid(10),
                    folderId: folder.id,
                    name: "Nový stav",
                    meaning: "none",
                  })
                }
              >
                Přidat stav
              </Button>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button tone="solid" data-primary onClick={save}>
            {folder ? "Uložit" : "Vytvořit"}
          </Button>
          {folder && folder.system !== "inbox" && (
            <Button
              onClick={() =>
                dispatch({
                  type: "updateFolder",
                  id: folder.id,
                  patch: { hidden: !folder.hidden },
                })
              }
            >
              {folder.hidden ? "Zrušit skrytí" : "Skrýt"}
            </Button>
          )}
          {folder && folder.system !== "inbox" && (
            <Button
              onClick={() =>
                dispatch({
                  type: "updateFolder",
                  id: folder.id,
                  patch: { isArchived: !folder.isArchived },
                })
              }
            >
              {folder.isArchived ? "Obnovit z archivu" : "Archivovat"}
            </Button>
          )}
          {folder && folder.system !== "inbox" && (
            <Button
              tone="danger"
              onClick={() =>
                deleteFolderToTrash(folder, ui.pushToast, () =>
                  ui.setFolderEdit(null)
                )
              }
            >
              Smazat
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
