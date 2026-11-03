import { isPaletteColor, paintCss } from "../domain/color.ts";
import {
  FOLDER_COLOR_LABELS,
  FOLDER_COLOR_ORDER,
  type FolderPaint,
  type Person,
} from "../domain/types.ts";
import { cx } from "./ui.tsx";

// Palette plus a custom color. `null` means "inherit", whatever the caller
// inherits from (usually the folder).
export function PaintPicker({
  value,
  inheritLabel,
  inheritPaint,
  onChange,
}: {
  value: FolderPaint | null;
  inheritLabel: string;
  inheritPaint: string;
  onChange: (value: FolderPaint | null) => void;
}) {
  const custom = Boolean(value && !isPaletteColor(value));
  return (
    <div className="grid gap-2">
      <button
        type="button"
        aria-pressed={value === null}
        className={cx(
          "flex w-max items-center gap-2 rounded-md px-2 py-1 text-xs",
          value === null
            ? "bg-accent-soft text-accent"
            : "bg-black/[0.04] hover:bg-black/10 dark:bg-white/[0.06] dark:hover:bg-white/10"
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onChange(null)}
      >
        <span
          className="size-3.5 rounded-full border border-line"
          style={{ background: inheritPaint }}
        />
        {inheritLabel}
      </button>
      <div className="flex flex-wrap items-center gap-2">
        {FOLDER_COLOR_ORDER.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={FOLDER_COLOR_LABELS[color]}
            aria-pressed={value === color}
            title={FOLDER_COLOR_LABELS[color]}
            className={cx(
              "size-6 rounded-full",
              value === color && "outline outline-2 outline-offset-2 outline-ink"
            )}
            style={{ background: `var(--${color})` }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange(value === color ? null : color)}
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
          value={custom && value ? value : "#767676"}
          onChange={(event) => {
            const next = event.target.value;
            if (/^#[0-9a-fA-F]{6}$/.test(next))
              onChange(next.toLowerCase() as FolderPaint);
          }}
        />
      </div>
    </div>
  );
}

export function PersonBadge({
  person,
  large = false,
}: {
  person: Person;
  large?: boolean;
}) {
  const paint = person.color ? paintCss(person.color) : "var(--muted)";
  const initial =
    person.name.trim().charAt(0).toLocaleUpperCase("cs") || "?";
  return (
    <span
      title={person.name}
      aria-label={person.name}
      className={cx(
        large
          ? "grid size-9 shrink-0 place-items-center rounded-full text-base leading-none font-semibold"
          : "grid size-5 shrink-0 place-items-center rounded-full text-[10px] leading-none font-semibold",
        person.emoji ? "text-ink" : "text-white"
      )}
      style={{
        background: person.emoji
          ? `color-mix(in srgb, ${paint} 25%, var(--raised))`
          : paint,
      }}
    >
      {person.emoji ?? initial}
    </span>
  );
}
