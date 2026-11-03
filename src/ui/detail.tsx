import {
  Calendar,
  Check,
  Clock,
  Flag,
  FolderInput,
  Link2,
  ListChecks,
  Palette,
  Plus,
  Repeat,
  Tag,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { dispatch, useSnap } from "../data/store.tsx";
import {
  combineDue,
  dueChoices,
  dueDateKey,
  isoWeekday,
  todayKey,
} from "../domain/dates.ts";
import { daysBetween } from "../domain/gantt.ts";
import { alive, byId, resolvedOpen, statusesOf } from "../domain/db.ts";
import { newItem } from "../domain/factory.ts";
import { pullHashtags, removeToken } from "../domain/hashtags.ts";
import { horizonPresets, planLabel, whenLabel } from "../domain/horizon.ts";
import { priorityLabel } from "../domain/labels.ts";
import { emailsIn, phonesIn, smsHref, whatsAppHref } from "../domain/links.ts";
import { mapHref, routeHref } from "../domain/place.ts";
import { parseQuickAdd } from "../domain/quickAdd.ts";
import {
  recurrenceLabel,
  recurrenceOf,
  recurrencePreset,
  weekdaysTo,
  type Recurrence,
} from "../domain/recurrence.ts";
import {
  blockedItems,
  blockingItems,
  linksOf,
  mapStatus,
  otherId,
  searchItems,
  subtasksOf,
  tagsOf,
} from "../domain/select.ts";
import { fold } from "../domain/text.ts";
import type { Item, RecurrenceFreq } from "../domain/types.ts";
import { downloadIcs, googleCalendarUrl } from "../lib/ics.ts";
import { paintCss } from "../domain/color.ts";
import { FolderPicker } from "./folderPick.tsx";
import { FolderCrumbs } from "./folders.tsx";
import { useTasksInGoogle } from "./gcal.tsx";
import { MarkdownField } from "./markdownField.tsx";
import { PaintPicker } from "./paint.tsx";
import { placeOp } from "./move.ts";
import { useUi } from "./state.tsx";
import { dispatchTaskText, TagMenu, useTagHint } from "./tagHint.tsx";
import { deleteItems } from "./tasks.tsx";
import {
  Button,
  control,
  cx,
  hoverRow,
  IconButton,
  OpenMark,
  priorityChip,
  PriorityMark,
  TagMark,
  trapTab,
  useLayer,
} from "./ui.tsx";

const WEEK = [
  [1, "Po"],
  [2, "Út"],
  [3, "St"],
  [4, "Čt"],
  [5, "Pá"],
  [6, "So"],
  [7, "Ne"],
] as const;

function Removable({
  children,
  title,
  onClear,
}: {
  children: ReactNode;
  title: string;
  onClear: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-2 rounded bg-ink/[0.06] px-2 py-0.5 text-sm">
      {children}
      <button
        type="button"
        title={title}
        className="text-muted! hover:text-ink!"
        onClick={onClear}
      >
        ×
      </button>
    </span>
  );
}

function clearField(
  id: string,
  patch: {
    origin?: null;
    place?: null;
    spot?: null;
    amount?: null;
    variableSymbol?: null;
  }
) {
  dispatch({ type: "updateItem", id, patch });
}

function uniqueContacts(title: string, body: string | null) {
  const text = `${title}\n${body ?? ""}`;
  const seen = new Set<string>();
  const take = <T extends { href: string }>(rows: T[]) =>
    rows.filter((row) => {
      if (seen.has(row.href)) return false;
      seen.add(row.href);
      return true;
    });
  return { phones: take(phonesIn(text)), emails: take(emailsIn(text)) };
}

function Fact({
  children,
  onClick,
  tone,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: "warn" | "danger";
}) {
  return (
    <button
      type="button"
      className="rounded bg-ink/[0.06] px-2 py-0.5 text-left text-sm hover:bg-ink/10"
      onClick={onClick}
    >
      <span
        className={
          tone === "warn"
            ? "text-warn"
            : tone === "danger"
            ? "text-danger"
            : undefined
        }
      >
        {children}
      </span>
    </button>
  );
}

function WhenFields({ item }: { item: Item }) {
  const [mode, setMode] = useState<"due" | "plan">(
    item.plannedFor && !item.dueAt ? "plan" : "due"
  );
  return (
    <div className="grid gap-2">
      <div
        className="flex rounded-md bg-black/5 p-0.5 dark:bg-white/10"
        role="group"
        aria-label="Kdy"
      >
        {(
          [
            ["due", "Přesný termín"],
            ["plan", "Od – do"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            className={cx(
              "flex-1 rounded-sm px-2 py-1 text-xs",
              mode === value
                ? "bg-accent text-accent-ink"
                : "text-muted hover:text-ink"
            )}
            onClick={() => setMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "due" ? <DueFields item={item} /> : <PlanEditor item={item} />}
    </div>
  );
}

function PlanEditor({ item }: { item: Item }) {
  const { db } = useSnap();
  const today = todayKey();
  const [phrase, setPhrase] = useState("");
  const ranged = Boolean(
    item.plannedFor && item.planUntil && item.planUntil > item.plannedFor
  );
  const apply = (from: string | null, until: string | null) => {
    dispatch({
      type: "updateItem",
      id: item.id,
      patch: {
        plannedFor: from,
        planUntil: from && until && until > from ? until : null,
        dueAt: null,
        dueHasTime: false,
      },
    });
  };
  const commitPhrase = () => {
    const text = phrase.trim();
    if (!text) return;
    const parsed = parseQuickAdd(text, db, today);
    if (parsed.planFrom) apply(parsed.planFrom, parsed.planUntil);
    else if (parsed.dueDay) apply(parsed.dueDay, null);
    else return;
    setPhrase("");
  };
  return (
    <div className="grid gap-2">
      {item.plannedFor && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm">
            {planLabel(item.plannedFor, item.planUntil, today)}
          </p>
          <button
            type="button"
            className="text-xs text-muted hover:text-ink"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply(null, null)}
          >
            Zrušit
          </button>
        </div>
      )}
      <input
        className={control}
        aria-label="Období"
        placeholder="třeba do 3 měsíců"
        value={phrase}
        onChange={(event) => setPhrase(event.target.value)}
        onBlur={commitPhrase}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commitPhrase();
        }}
      />
      <div className="flex flex-wrap gap-1">
        {horizonPresets(today).map((preset) => {
          const selected =
            item.plannedFor === preset.from && item.planUntil === preset.until;
          return (
            <button
              key={preset.id}
              type="button"
              className={cx(
                "rounded-sm px-2 py-1 text-xs",
                selected
                  ? "bg-accent-soft text-accent"
                  : "bg-black/[0.04] hover:bg-black/10 dark:bg-white/[0.06] dark:hover:bg-white/10"
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => apply(preset.from, preset.until)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs text-muted">
          Od
          <input
            className={control}
            type="date"
            value={item.plannedFor ?? ""}
            onChange={(event) => {
              const from = event.target.value || null;
              const until = ranged ? item.planUntil : null;
              apply(from, from && until && until > from ? until : null);
            }}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Do
          <input
            className={control}
            type="date"
            min={item.plannedFor ?? undefined}
            value={ranged ? item.planUntil ?? "" : ""}
            onChange={(event) => {
              const until = event.target.value || null;
              if (!until) {
                apply(item.plannedFor, null);
                return;
              }
              const from = item.plannedFor ?? until;
              if (until < from) apply(until, from);
              else apply(from, until);
            }}
          />
        </label>
      </div>
      {item.plannedFor && ranged && (
        <p className="text-xs text-muted">
          {planDays(item.plannedFor, item.planUntil)} v kuse
        </p>
      )}
    </div>
  );
}

function planDays(from: string, until: string | null): string {
  const count = daysBetween(from, until ?? from) + 1;
  if (count === 1) return "1 den";
  if (count >= 2 && count <= 4) return `${count} dny`;
  return `${count} dní`;
}

function DueFields({ item }: { item: Item }) {
  const today = todayKey();
  const choices = dueChoices(today);
  const day = item.dueAt?.slice(0, 10) ?? "";
  const time = item.dueHasTime ? item.dueAt?.slice(11, 16) ?? "" : "";
  const apply = (nextDay: string | null, nextTime: string | null) =>
    dispatch({
      type: "updateItem",
      id: item.id,
      patch: {
        ...combineDue(nextDay, nextTime),
        plannedFor: null,
        planUntil: null,
      },
    });
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1">
        {choices.map((choice) => {
          const selected = choice.day === day && (choice.time ?? "") === time;
          return (
            <button
              key={choice.id}
              type="button"
              aria-pressed={selected}
              className={cx(
                "rounded-sm px-2 py-1 text-xs",
                selected
                  ? "bg-accent-soft text-accent"
                  : "bg-black/[0.04] hover:bg-black/10 dark:bg-white/[0.06] dark:hover:bg-white/10"
              )}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                apply(
                  selected ? null : choice.day,
                  selected ? null : choice.time
                )
              }
            >
              {choice.label}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <input
          className={control}
          type="date"
          aria-label="Termín"
          value={day}
          onChange={(event) =>
            apply(
              event.target.value || null,
              event.target.value ? time || null : null
            )
          }
        />
        <input
          className={control}
          type="time"
          aria-label="Čas"
          value={time}
          onChange={(event) => {
            const next = event.target.value;
            apply(next ? day || today : day || null, next || null);
          }}
        />
      </div>
    </div>
  );
}

function PriorityFields({ item }: { item: Item }) {
  return (
    <div className="flex flex-wrap gap-1">
      {([null, "low", "high", "urgent"] as const).map((priority) => {
        const selected = item.priority === priority;
        const tone = priorityChip(priority, selected);
        return (
          <button
            key={priority ?? "normal"}
            type="button"
            aria-pressed={selected}
            className={cx("rounded-sm px-2 py-1 text-xs font-medium", tone.box)}
            onClick={() =>
              dispatch({
                type: "updateItem",
                id: item.id,
                patch: { priority },
              })
            }
          >
            <span className={tone.ink}>{priorityLabel(priority)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Detail({ item }: { item: Item }) {
  const { db } = useSnap();
  const ui = useUi();
  const inGoogle = useTasksInGoogle();
  const folder = byId(db.folders, item.folderId);
  const tags = tagsOf(db, item.id);
  const [extra, setExtra] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setExtra(null);
  }, [item.id]);
  useLayer((event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = Boolean(
      target?.closest("input, textarea, select, [contenteditable='true']")
    );
    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      !event.repeat &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !typing
    ) {
      event.preventDefault();
      deleteItems([item], ui.pushToast, () => ui.setSelected(null));
      return;
    }
    if (event.key !== "Escape") {
      trapTab(event, card.current);
      return;
    }
    event.preventDefault();
    if (typing) {
      target?.blur();
      return;
    }
    if (extra) {
      setExtra(null);
      return;
    }
    ui.setSelected(null);
  });
  const allTags = alive(db.tags);
  const today = todayKey();
  const when = whenLabel(item, today);
  const late = Boolean(item.dueAt && item.dueAt.slice(0, 10) < today);
  const repeat = recurrenceLabel(item);
  const person = byId(db.people, item.assigneeId);
  const toggle = (key: string) =>
    setExtra((current) => (current === key ? null : key));

  const setFolder = (folderId: string) => {
    const mapped = mapStatus(db, item.statusId, folderId);
    const go = (statusId: string) =>
      dispatch(placeOp(db, item.id, folderId, statusId));
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

  const task = item.type === "task";

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-ink/15">
      <div
        className="flex min-h-full items-start justify-center px-3 py-6 sm:px-8 sm:py-12"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) ui.setSelected(null);
        }}
      >
        <div
          ref={card}
          data-detail
          role="dialog"
          aria-modal="true"
          aria-label={item.title}
          className="relative w-full max-w-3xl rounded-xl bg-raised p-4 shadow-[var(--shadow)] sm:p-6"
        >
          <div className="mb-4 flex items-start gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <DetailTitle item={item} />
              <FolderCrumbs folderId={item.folderId} scope="detail" />
            </div>
            <IconButton label="Zavřít" onClick={() => ui.setSelected(null)}>
              <X size={18} />
            </IconButton>
          </div>
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_12.5rem]">
            <div className="grid min-w-0 content-start gap-4">
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      title="Odebrat štítek"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-ink/5"
                      onClick={() =>
                        dispatch({
                          type: "setItemTags",
                          itemId: item.id,
                          tagIds: tags
                            .filter((entry) => entry.id !== tag.id)
                            .map((entry) => entry.id),
                        })
                      }
                    >
                      <TagMark name={tag.name} color={tag.color} />
                      <span className="text-muted">×</span>
                      <span className="sr-only"> odebrat</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {folder && task && (
                  <select
                    className="rounded bg-ink/[0.06] px-2 py-0.5 text-sm font-medium outline-none hover:bg-ink/10"
                    data-meaning={byId(db.statuses, item.statusId)?.meaning}
                    aria-label="Stav"
                    value={item.statusId ?? ""}
                    onChange={(event) =>
                      dispatch(
                        placeOp(db, item.id, folder.id, event.target.value)
                      )
                    }
                  >
                    {statusesOf(db, folder.id).map((status) => (
                      <option key={status.id} value={status.id}>
                        {status.name}
                      </option>
                    ))}
                  </select>
                )}
                {when && (
                  <Fact
                    onClick={() => toggle("when")}
                    {...(late ? { tone: "danger" as const } : {})}
                  >
                    {when}
                  </Fact>
                )}
                {repeat && (
                  <Fact onClick={() => toggle("repeat")}>{repeat}</Fact>
                )}
                {item.priority && (
                  <button
                    type="button"
                    className="rounded"
                    onClick={() => toggle("priority")}
                  >
                    <PriorityMark priority={item.priority} />
                  </button>
                )}
                {person && (
                  <Fact onClick={() => toggle("person")}>{person.name}</Fact>
                )}
                {item.origin && (
                  <Removable
                    title="Odebrat start"
                    onClear={() => clearField(item.id, { origin: null })}
                  >
                    {item.origin}
                  </Removable>
                )}
                {item.place && (
                  <Removable
                    title="Odebrat destinaci"
                    onClear={() => clearField(item.id, { place: null })}
                  >
                    <a
                      href={mapHref(item.place)}
                      target="_blank"
                      rel="noreferrer"
                      title="Otevřít na mapě"
                      className="hover:underline"
                    >
                      {item.place}
                    </a>
                    <a
                      href={routeHref(item.place, item.origin)}
                      target="_blank"
                      rel="noreferrer"
                      title="Navigovat"
                      className="hover:underline"
                    >
                      Trasa
                    </a>
                  </Removable>
                )}
                {item.spot && (
                  <Removable
                    title="Odebrat místo v budově"
                    onClear={() => clearField(item.id, { spot: null })}
                  >
                    {item.spot}
                  </Removable>
                )}
                {item.amount && (
                  <Removable
                    title="Odebrat částku"
                    onClear={() => clearField(item.id, { amount: null })}
                  >
                    {item.amount}
                  </Removable>
                )}
                {item.variableSymbol && (
                  <Removable
                    title="Odebrat variabilní symbol"
                    onClear={() =>
                      clearField(item.id, { variableSymbol: null })
                    }
                  >
                    VS {item.variableSymbol}
                  </Removable>
                )}
                {uniqueContacts(item.title, item.body).phones.map((phone) => {
                  const sms = smsHref(phone.value);
                  const whatsApp = whatsAppHref(phone.value);
                  return (
                    <span
                      key={phone.href}
                      className="inline-flex items-center gap-2 rounded bg-ink/[0.06] px-2 py-0.5 text-sm"
                    >
                      <a href={phone.href} className="hover:underline">
                        {phone.value}
                      </a>
                      {sms && (
                        <a href={sms} className="hover:underline">
                          SMS
                        </a>
                      )}
                      {whatsApp && (
                        <a
                          href={whatsApp}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline"
                        >
                          WhatsApp
                        </a>
                      )}
                    </span>
                  );
                })}
                {uniqueContacts(item.title, item.body).emails.map((email) => (
                  <a
                    key={email.href}
                    href={email.href}
                    className="rounded bg-ink/[0.06] px-2 py-0.5 text-sm hover:bg-ink/10"
                  >
                    {email.value}
                  </a>
                ))}
              </div>
              {extra && (
                <div className="grid gap-2">
                  {extra === "when" && <WhenFields item={item} />}
                  {extra === "repeat" && (
                    <RecurrenceEditor
                      item={item}
                      onDone={() => setExtra(null)}
                    />
                  )}
                  {extra === "priority" && <PriorityFields item={item} />}
                  {extra === "color" && (
                    <PaintPicker
                      value={item.color ?? null}
                      inheritLabel="Podle složky"
                      inheritPaint={(() => {
                        const folder = byId(db.folders, item.folderId);
                        return folder?.color
                          ? paintCss(folder.color)
                          : "var(--muted)";
                      })()}
                      onChange={(color) =>
                        dispatch({
                          type: "updateItem",
                          id: item.id,
                          patch: { color },
                        })
                      }
                    />
                  )}
                  {extra === "person" && <PersonAssign item={item} />}
                  {extra === "tag" && (
                    <TagAdder
                      item={item}
                      names={allTags.map((tag) => tag.name)}
                    />
                  )}
                  {extra === "wait" && (
                    <RelationComposer
                      item={item}
                      mode="wait"
                      onDone={() => setExtra(null)}
                    />
                  )}
                  {extra === "link" && (
                    <RelationComposer
                      item={item}
                      mode="link"
                      onDone={() => setExtra(null)}
                    />
                  )}
                  {extra === "sub" && (
                    <SubtaskComposer
                      item={item}
                      onDone={() => setExtra(null)}
                    />
                  )}
                  {extra === "move" && (
                    <FolderPicker
                      value={item.folderId}
                      onPick={(folderId) => {
                        if (folderId) setFolder(folderId);
                      }}
                    />
                  )}
                </div>
              )}
              <section className="grid gap-2">
                <h3 className="text-sm font-semibold">Popis</h3>
                {item.body || extra === "body" ? (
                  <div className="rounded-md bg-ink/[0.04] px-3 py-2">
                    <BodyEditor item={item} onCollapse={() => setExtra(null)} />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="w-full rounded-md bg-ink/[0.04] px-3 py-2 text-left text-sm text-muted hover:bg-ink/[0.08]"
                    onClick={() => setExtra("body")}
                  >
                    Přidat podrobnější popis…
                  </button>
                )}
              </section>
              <Relations item={item} />
              <Subtasks item={item} />
            </div>
            <div className="grid content-start gap-4 lg:sticky lg:top-0">
              <ActionGroup title="Přidat">
                <ActionButton
                  pressed={extra === "tag"}
                  onClick={() => toggle("tag")}
                >
                  <Tag size={15} /> Štítek
                </ActionButton>
                {task && (
                  <>
                    <ActionButton
                      pressed={extra === "when"}
                      onClick={() => toggle("when")}
                    >
                      <Calendar size={15} /> Kdy
                    </ActionButton>
                    <ActionButton
                      pressed={extra === "repeat"}
                      onClick={() => toggle("repeat")}
                    >
                      <Repeat size={15} /> Opakování
                    </ActionButton>
                    <ActionButton
                      pressed={extra === "priority"}
                      onClick={() => toggle("priority")}
                    >
                      <Flag size={15} /> Priorita
                    </ActionButton>
                    <ActionButton
                      pressed={extra === "color"}
                      onClick={() => toggle("color")}
                    >
                      <Palette size={15} /> Barva
                    </ActionButton>
                    <ActionButton
                      pressed={extra === "person"}
                      onClick={() => toggle("person")}
                    >
                      <UserRound size={15} /> Člověk
                    </ActionButton>
                    <ActionButton
                      pressed={extra === "wait"}
                      onClick={() => toggle("wait")}
                    >
                      <Clock size={15} /> Čeká na
                    </ActionButton>
                    <ActionButton
                      pressed={extra === "sub"}
                      onClick={() => toggle("sub")}
                    >
                      <ListChecks size={15} /> Podúkol
                    </ActionButton>
                  </>
                )}
                <ActionButton
                  pressed={extra === "link"}
                  onClick={() => toggle("link")}
                >
                  <Link2 size={15} /> Odkaz
                </ActionButton>
              </ActionGroup>
              <ActionGroup title="Akce">
                <ActionButton
                  pressed={extra === "move"}
                  onClick={() => toggle("move")}
                >
                  <FolderInput size={15} /> Složka
                </ActionButton>
                {(item.dueAt || item.plannedFor) && (
                  <>
                    <ActionButton onClick={() => downloadIcs(item)}>
                      <Calendar size={15} /> .ics
                    </ActionButton>
                    {!inGoogle && (
                      <ActionButton
                        onClick={() => {
                          const url = googleCalendarUrl(item);
                          if (url) window.open(url, "_blank", "noopener");
                        }}
                      >
                        <Calendar size={15} /> Google
                      </ActionButton>
                    )}
                  </>
                )}
                <ActionButton
                  tone="danger"
                  onClick={() =>
                    deleteItems([item], ui.pushToast, () =>
                      ui.setSelected(null)
                    )
                  }
                >
                  <Trash2 size={15} /> Smazat
                </ActionButton>
              </ActionGroup>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-semibold text-muted">{title}</p>
      {children}
    </div>
  );
}

function ActionButton({
  pressed,
  onClick,
  tone,
  children,
}: {
  pressed?: boolean;
  onClick: () => void;
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cx(
        "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm",
        pressed
          ? "bg-accent-soft text-accent"
          : tone === "danger"
          ? "bg-ink/[0.06] text-danger hover:bg-danger/10"
          : "bg-ink/[0.06] hover:bg-ink/10"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function DetailTitle({ item }: { item: Item }) {
  const { db } = useSnap();
  const field = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const started = useRef(item.title);
  const seen = useRef(item.id);
  if (seen.current !== item.id) {
    seen.current = item.id;
    started.current = item.title;
  }
  const [caret, setCaret] = useState(0);
  const hint = useTagHint(item.type === "task" ? item.title : "", caret);
  useLayoutEffect(() => {
    const node = field.current;
    const next = pendingCaret.current;
    if (!node || next === null) return;
    pendingCaret.current = null;
    node.setSelectionRange(next, next);
  }, [item.title]);
  const pickTag = (name: string) => {
    if (!hint.token) return;
    const cleaned = removeToken(item.title, hint.token.start, hint.token.end);
    const title = cleaned.trim();
    const shown = title || item.title;
    pendingCaret.current = Math.min(hint.token.start, shown.length);
    setCaret(pendingCaret.current);
    dispatchTaskText(db, item, title && title !== item.title ? { title } : {}, [
      name,
    ]);
    field.current?.focus();
  };
  return (
    <div className="min-w-0 text-xl font-semibold leading-snug">
      <input
        ref={field}
        data-detail-title
        className="w-full min-w-0 bg-transparent outline-none"
        value={item.title}
        onChange={(event) => {
          setCaret(event.target.selectionStart ?? event.target.value.length);
          dispatch({
            type: "updateItem",
            id: item.id,
            patch: { title: event.target.value },
          });
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onFocus={(event) => {
          started.current = event.currentTarget.value;
        }}
        onKeyDown={(event) => {
          const key = hint.onKey(event);
          if (key.handled) {
            if (key.name) pickTag(key.name);
            return;
          }
          if (
            event.key !== "ArrowDown" ||
            event.shiftKey ||
            event.altKey ||
            event.metaKey ||
            event.ctrlKey
          )
            return;
          const line = event.currentTarget
            .closest("[data-detail]")
            ?.querySelector<HTMLElement>('[aria-label="Popis"]');
          if (!line) return;
          event.preventDefault();
          line.focus();
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Element && next.closest("[role=listbox]")) return;
          if (item.type === "task") {
            const pulled = pullHashtags(event.currentTarget.value);
            const title = pulled.text.trim() || started.current.trim();
            dispatchTaskText(
              db,
              item,
              title && title !== item.title ? { title } : {},
              pulled.names
            );
          }
          dispatch({
            type: "updateItem",
            id: item.id,
            patch: {},
            fileInbox: true,
          });
        }}
      />
      {hint.open && (
        <TagMenu
          anchor={field.current}
          tags={hint.tags}
          picked={hint.picked}
          onHover={hint.setHighlight}
          onPick={pickTag}
        />
      )}
    </div>
  );
}

function BodyEditor({
  item,
  onCollapse,
}: {
  item: Item;
  onCollapse: () => void;
}) {
  const { db } = useSnap();
  const anchor = useRef<HTMLElement | null>(null);
  const [fresh] = useState(() => !item.body);
  const [selection, setSelection] = useState("");
  const [caret, setCaret] = useState((item.body ?? "").length);
  const hint = useTagHint(item.type === "task" ? item.body ?? "" : "", caret);
  const createTask = () => {
    const title = selection.trim();
    if (!title) return;
    const id = nanoid(10);
    const folder = byId(db.folders, item.folderId);
    const statusId = folder ? resolvedOpen(db, folder)?.id ?? null : null;
    dispatch({
      type: "batch",
      ops: [
        {
          type: "createItem",
          item: newItem({ id, folderId: item.folderId, title, statusId }),
        },
        {
          type: "addLink",
          id: nanoid(10),
          fromId: item.id,
          toId: id,
          kind: "taskFromNote",
        },
        {
          type: "updateItem",
          id: item.id,
          patch: { body: `${item.body ?? ""}\n{{task:${id}}}` },
        },
      ],
    });
    setSelection("");
  };
  const pickTag = (name: string) => {
    if (!hint.token) return;
    const cleaned = removeToken(
      item.body ?? "",
      hint.token.start,
      hint.token.end
    );
    const body = cleaned.trim() ? cleaned.replace(/\s+$/, "") : null;
    setCaret(Math.min(hint.token.start, cleaned.length));
    dispatchTaskText(db, item, (item.body ?? null) === body ? {} : { body }, [
      name,
    ]);
  };
  return (
    <div
      className="grid gap-2"
      onKeyDownCapture={(event) => {
        const key = hint.onKey(event);
        if (key.handled && key.name) pickTag(key.name);
      }}
    >
      {selection && (
        <Button
          tone="soft"
          onMouseDown={(event) => event.preventDefault()}
          onClick={createTask}
        >
          Úkol z výběru
        </Button>
      )}
      <MarkdownField
        value={item.body ?? ""}
        label="Popis"
        placeholder="Přidat podrobnější popis…"
        autoFocus={fresh}
        caret={caret}
        className="min-h-16 text-sm leading-5"
        embed={(id) => <TaskEmbed id={id} />}
        onSelection={setSelection}
        onCaret={(at, node) => {
          anchor.current = node;
          setCaret(at);
        }}
        onChange={(next, at) => {
          setCaret(at);
          const body = next.trim() ? next : null;
          if ((item.body ?? null) === body) return;
          dispatch({ type: "updateItem", id: item.id, patch: { body } });
        }}
        onExit={(dir, column) => {
          if (dir > 0) return;
          const input = document.activeElement
            ?.closest("[data-detail]")
            ?.querySelector<HTMLInputElement>("[data-detail-title]");
          if (!input) return;
          const at = Math.min(column, input.value.length);
          input.focus();
          input.setSelectionRange(at, at);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (
            next instanceof Element &&
            (next.closest("[role=listbox]") ||
              next.closest("[data-detail-title]"))
          )
            return;
          const raw = item.body ?? "";
          const pulled =
            item.type === "task" ? pullHashtags(raw) : { text: raw, names: [] };
          if (pulled.names.length > 0) {
            const body = pulled.text || null;
            dispatchTaskText(
              db,
              item,
              (item.body ?? null) === body ? {} : { body },
              pulled.names
            );
          }
          dispatch({
            type: "updateItem",
            id: item.id,
            patch: {},
            fileInbox: true,
          });
          if (!pulled.text.trim()) onCollapse();
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

function TaskEmbed({ id }: { id: string }) {
  const { db } = useSnap();
  const ui = useUi();
  const item = byId(db.items, id);
  if (!item || item.isDeleted)
    return <p className="text-muted">Úkol už tu není.</p>;
  const folder = byId(db.folders, item.folderId);
  const done = folder
    ? item.statusId ===
      (folder
        ? statusesOf(db, folder.id).find((status) => status.meaning === "done")
            ?.id
        : null)
    : false;
  return (
    <button
      type="button"
      className={cx(
        "flex items-center gap-2 border border-line px-2 py-1.5 text-left",
        hoverRow
      )}
      onClick={() => ui.select(item.id)}
    >
      <span
        className={cx(
          "min-w-0 flex-1 truncate",
          done && "text-muted line-through"
        )}
      >
        {item.title}
      </span>
      <OpenMark />
    </button>
  );
}

function PersonAssign({ item }: { item: Item }) {
  const { db } = useSnap();
  const [name, setName] = useState("");
  const people = alive(db.people);
  const assign = (assigneeId: string | null) =>
    dispatch({
      type: "updateItem",
      id: item.id,
      patch: { assigneeId },
    });
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = people.find(
      (person) => fold(person.name) === fold(trimmed)
    );
    if (existing) {
      assign(existing.id);
      setName("");
      return;
    }
    const id = nanoid(10);
    dispatch({
      type: "batch",
      ops: [
        {
          type: "createPerson",
          id,
          name: trimmed,
          color: null,
          emoji: null,
        },
        {
          type: "updateItem",
          id: item.id,
          patch: { assigneeId: id },
        },
      ],
    });
    setName("");
  };
  return (
    <div className="grid gap-2">
      <select
        className={control}
        aria-label="Člověk"
        value={item.assigneeId ?? ""}
        onChange={(event) => assign(event.target.value || null)}
      >
        <option value="">Nikdo</option>
        {people.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className={control}
          aria-label="Nový člověk"
          placeholder="Nový člověk"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button tone="soft" type="submit">
          Přidat
        </Button>
      </form>
    </div>
  );
}

function TagAdder({ item, names }: { item: Item; names: string[] }) {
  const { db } = useSnap();
  const [value, setValue] = useState("");
  const add = () => {
    const name = value.trim();
    if (!name) return;
    const existing = alive(db.tags).find(
      (tag) => tag.name.toLowerCase() === name.toLowerCase()
    );
    const id = existing?.id ?? nanoid(10);
    const current = tagsOf(db, item.id).map((tag) => tag.id);
    dispatch({
      type: "batch",
      ops: [
        ...(existing
          ? []
          : [{ type: "ensureTag" as const, id, name, color: null }]),
        {
          type: "setItemTags" as const,
          itemId: item.id,
          tagIds: [...current, id],
        },
      ],
    });
    setValue("");
  };
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <input
        className={control}
        list="tags"
        placeholder="Štítek"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <datalist id="tags">
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Button tone="soft" type="submit">
        Přidat
      </Button>
    </form>
  );
}

const REPEAT_PRESETS = [
  ["never", "Nikdy"],
  ["daily", "Každý den"],
  ["weekly", "Každý týden"],
  ["monthly", "Každý měsíc"],
  ["yearly", "Každý rok"],
] as const;

type CustomFreq = "daily" | "weekly" | "monthly" | "yearly";

function anchorDay(item: Item): string {
  return dueDateKey(item.dueAt) ?? item.plannedFor ?? todayKey();
}

function everyPhrase(
  freq: CustomFreq,
  count: number
): { lead: string; unit: string } {
  const few = count >= 2 && count <= 4;
  if (freq === "daily")
    return {
      lead: count === 1 ? "Každý" : "Každých",
      unit: count === 1 ? "den" : few ? "dny" : "dní",
    };
  if (freq === "weekly")
    return {
      lead: count === 1 ? "Každý" : few ? "Každé" : "Každých",
      unit: count === 1 ? "týden" : few ? "týdny" : "týdnů",
    };
  if (freq === "monthly")
    return {
      lead: count === 1 ? "Každý" : few ? "Každé" : "Každých",
      unit: count === 1 ? "měsíc" : few ? "měsíce" : "měsíců",
    };
  return {
    lead: count === 1 ? "Každý" : few ? "Každé" : "Každých",
    unit: count === 1 ? "rok" : few ? "roky" : "let",
  };
}

function customDraft(rule: Recurrence | null, anchor: string) {
  const weekday = isoWeekday(anchor);
  if (!rule || rule.freq === "interval") {
    return {
      freq: (rule?.freq === "interval" ? "daily" : "weekly") as CustomFreq,
      interval: rule?.interval ?? 1,
      weekdays: rule?.weekdays.length ? rule.weekdays : [weekday],
      until: rule?.until ?? null,
    };
  }
  const freq: CustomFreq =
    rule.freq === "daily" || rule.freq === "monthly" || rule.freq === "yearly"
      ? rule.freq
      : "weekly";
  return {
    freq,
    interval: rule.interval,
    weekdays: rule.weekdays.length > 0 ? rule.weekdays : [weekday],
    until: rule.until,
  };
}

function RecurrenceEditor({
  item,
  onDone,
}: {
  item: Item;
  onDone: () => void;
}) {
  const anchor = anchorDay(item);
  const rule = recurrenceOf(item);
  const preset = recurrencePreset(rule, anchor);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(() => customDraft(rule, anchor));
  const save = (
    freq: RecurrenceFreq | null,
    interval = 1,
    weekdays: number[] | null = null,
    until: string | null = null
  ) => {
    dispatch({
      type: "setRecurrence",
      itemId: item.id,
      freq,
      interval,
      weekdays: weekdaysTo(weekdays ?? []),
      until,
    });
    onDone();
  };
  const choose = (next: (typeof REPEAT_PRESETS)[number][0]) => {
    if (next === "never") {
      save(null);
      return;
    }
    if (next === "weekly") {
      save("weekly", 1, [isoWeekday(anchor)]);
      return;
    }
    save(next, 1);
  };
  if (custom) {
    const count = Math.max(1, draft.interval || 1);
    const phrase = everyPhrase(draft.freq, count);
    return (
      <div className="grid gap-3 rounded-lg border border-line p-3">
        <label className="flex items-center justify-between gap-3 text-sm">
          Frekvence
          <select
            className={`${control} w-36`}
            aria-label="Frekvence"
            value={draft.freq}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                freq: event.target.value as CustomFreq,
              }))
            }
          >
            <option value="daily">Denně</option>
            <option value="weekly">Týdně</option>
            <option value="monthly">Měsíčně</option>
            <option value="yearly">Ročně</option>
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{phrase.lead}</span>
          <input
            className={`${control} w-16 text-center`}
            aria-label="Interval"
            type="number"
            min={1}
            value={draft.interval}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                interval: Math.max(1, Number(event.target.value) || 1),
              }))
            }
          />
          <span>
            {phrase.unit}
            {draft.freq === "weekly" ? " ve dnech" : ""}
          </span>
        </div>
        {draft.freq === "weekly" && (
          <div className="grid grid-cols-7 gap-1">
            {WEEK.map(([day, label]) => {
              const on = draft.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  className={cx(
                    "rounded-md py-1.5 text-xs font-medium",
                    on
                      ? "bg-accent text-accent-ink"
                      : "bg-black/[0.04] text-muted hover:text-ink dark:bg-white/[0.06]"
                  )}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      weekdays: on
                        ? current.weekdays.filter((value) => value !== day)
                        : [...current.weekdays, day],
                    }))
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <label className="flex items-center justify-between gap-3 text-sm">
          Konec
          <input
            className={`${control} w-40`}
            type="date"
            aria-label="Konec opakování"
            value={draft.until ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                until: event.target.value || null,
              }))
            }
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setCustom(false)}>Zrušit</Button>
          <Button
            tone="solid"
            onClick={() =>
              save(
                draft.freq,
                count,
                draft.freq === "weekly"
                  ? draft.weekdays.length > 0
                    ? draft.weekdays
                    : [isoWeekday(anchor)]
                  : null,
                draft.until
              )
            }
          >
            Hotovo
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="Opakování"
      className="overflow-hidden rounded-lg border border-line"
    >
      {REPEAT_PRESETS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={preset === id}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
          onClick={() => choose(id)}
        >
          <Check
            size={15}
            className={cx(
              "shrink-0",
              preset === id ? "opacity-100" : "opacity-0"
            )}
          />
          {label}
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={preset === "custom"}
        className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10"
        onClick={() => {
          setDraft(customDraft(rule, anchor));
          setCustom(true);
        }}
      >
        <Check
          size={15}
          className={cx(
            "shrink-0",
            preset === "custom" ? "opacity-100" : "opacity-0"
          )}
        />
        Vlastní…
      </button>
    </div>
  );
}

function Subtasks({ item }: { item: Item }) {
  const { db } = useSnap();
  const ui = useUi();
  const children = subtasksOf(db, item.id);
  if (children.length === 0) return null;
  return (
    <section className="grid gap-1">
      <h3 className="text-sm font-semibold">Podúkoly</h3>
      {children.map((child) => (
        <button
          key={child.id}
          type="button"
          className={cx(
            "flex w-full items-center gap-2 px-1 py-1 text-left text-sm",
            hoverRow
          )}
          onClick={() => ui.select(child.id)}
        >
          <span className="min-w-0 flex-1 truncate">{child.title}</span>
          <OpenMark />
        </button>
      ))}
    </section>
  );
}

function SubtaskComposer({ item, onDone }: { item: Item; onDone: () => void }) {
  const { db } = useSnap();
  const [title, setTitle] = useState("");
  const add = () => {
    const text = title.trim();
    if (!text) return;
    const folder = byId(db.folders, item.folderId);
    dispatch({
      type: "createItem",
      item: newItem({
        id: nanoid(10),
        folderId: item.folderId,
        title: text,
        parentItemId: item.id,
        statusId: folder ? resolvedOpen(db, folder)?.id ?? null : null,
      }),
    });
    setTitle("");
    onDone();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <input
        className={control}
        autoFocus
        placeholder="Nový podúkol"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
    </form>
  );
}

function Relations({ item }: { item: Item }) {
  const { db } = useSnap();
  const ui = useUi();
  const waiting = blockingItems(db, item.id);
  const blocking = blockedItems(db, item.id);
  const links = linksOf(db, item.id);
  if (waiting.length + blocking.length + links.length === 0) return null;
  return (
    <section className="grid gap-1">
      <h3 className="text-sm font-semibold">Vazby</h3>
      {waiting.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={cx(
            "flex w-full items-center gap-2 px-1 py-1 text-left text-sm",
            hoverRow
          )}
          onClick={() => ui.select(entry.id)}
        >
          <span className="min-w-0 flex-1 truncate">Čeká na {entry.title}</span>
          <OpenMark />
        </button>
      ))}
      {blocking.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={cx(
            "flex w-full items-center gap-2 px-1 py-1 text-left text-sm",
            hoverRow
          )}
          onClick={() => ui.select(entry.id)}
        >
          <span className="min-w-0 flex-1 truncate">Blokuje {entry.title}</span>
          <OpenMark />
        </button>
      ))}
      {links.map((link) => {
        const other = byId(db.items, otherId(link, item.id));
        if (!other) return null;
        return (
          <button
            key={link.id}
            type="button"
            className={cx(
              "flex w-full items-center gap-2 px-1 py-1 text-left text-sm text-accent",
              hoverRow
            )}
            onClick={() => ui.select(other.id)}
          >
            <span className="min-w-0 flex-1 truncate">{other.title}</span>
            <OpenMark />
          </button>
        );
      })}
    </section>
  );
}

function RelationComposer({
  item,
  mode,
  onDone,
}: {
  item: Item;
  mode: "wait" | "link";
  onDone: () => void;
}) {
  const { db } = useSnap();
  const [query, setQuery] = useState("");
  const results = query.trim()
    ? searchItems(db, query)
        .filter((entry) => entry.id !== item.id)
        .slice(0, 6)
    : [];
  const pick = (id: string) => {
    if (mode === "wait")
      dispatch({
        type: "addDependency",
        id: nanoid(10),
        itemId: item.id,
        dependsOnId: id,
      });
    else
      dispatch({
        type: "addLink",
        id: nanoid(10),
        fromId: item.id,
        toId: id,
        kind: "related",
      });
    onDone();
  };
  const createWaiting = () => {
    const text = query.trim();
    if (!text || mode !== "wait") return;
    const folder = byId(db.folders, item.folderId);
    if (!folder) return;
    const id = nanoid(10);
    dispatch({
      type: "batch",
      ops: [
        {
          type: "createItem",
          item: newItem({
            id,
            folderId: folder.id,
            title: text,
            statusId: resolvedOpen(db, folder)?.id ?? null,
          }),
        },
        {
          type: "addDependency",
          id: nanoid(10),
          itemId: item.id,
          dependsOnId: id,
        },
      ],
    });
    onDone();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        createWaiting();
      }}
    >
      <input
        className={control}
        autoFocus
        placeholder={
          mode === "wait" ? "Hledat, nebo nový úkol" : "Hledat položku"
        }
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {results.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={cx(
            "flex w-full items-center gap-2 px-1 py-1 text-left text-sm",
            hoverRow
          )}
          onClick={() => pick(entry.id)}
        >
          <span className="min-w-0 flex-1 truncate">{entry.title}</span>
          <OpenMark />
        </button>
      ))}
      {mode === "wait" && query.trim() && (
        <button
          type="submit"
          className={cx(
            "flex w-full items-center gap-2 px-1 py-1 text-left text-sm text-accent",
            hoverRow
          )}
        >
          <Plus size={14} />
          <span className="min-w-0 flex-1 truncate">
            Vytvořit „{query.trim()}“
          </span>
        </button>
      )}
    </form>
  );
}
