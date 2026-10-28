// Small controls the editors share (ADR-052, ADR-067): a labelled slider, a row of chips, colour
// swatches, a select and a labelled field.
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';

export const signed = (v: number) => (v > 0 ? `+${v}` : String(v));

export function Slider({
  label,
  value,
  onChange,
  min = -100,
  max = 100,
  step = 1,
  zero = 0,
  unit = '',
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** What a double-tap goes back to. */
  zero?: number;
  unit?: string;
}) {
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="w-24 shrink-0 text-[var(--fg-muted)]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(zero)}
        className="h-6 min-w-0 flex-1 accent-brand-600"
      />
      <span className="w-11 shrink-0 text-right tabular-nums">
        {min < 0 ? signed(value) : value}
        {unit}
      </span>
    </label>
  );
}

export function Chips<T extends string>({
  items,
  value,
  onChange,
  badge,
}: {
  items: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (v: T) => void;
  badge?: (v: T) => string | null;
}) {
  return (
    <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {items.map(([id, label]) => {
        const b = badge?.(id);
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={value === id}
            className={cn(
              'shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs',
              value === id && 'border-brand-500 bg-[var(--accent-soft)] text-[var(--accent)]',
            )}
          >
            {label}
            {b && <span className="ml-1 tabular-nums opacity-70">{b}</span>}
          </button>
        );
      })}
    </div>
  );
}

export const COLOURS = [
  '#ffffff',
  '#111111',
  '#ef4444',
  '#f97316',
  '#facc15',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
];

export function Swatches({
  value,
  colours = COLOURS,
  onChange,
}: {
  value: string;
  colours?: string[];
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {colours.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-pressed={value === c}
          aria-label={`${t.editor.colour} ${c}`}
          className={cn(
            'h-7 w-7 shrink-0 rounded-full border border-black/15',
            value === c && 'ring-2 ring-brand-500 ring-offset-2 ring-offset-[var(--card)]',
          )}
          style={{ background: c }}
        />
      ))}
      <label className="relative h-7 w-7 shrink-0 overflow-hidden rounded-full border border-[var(--border)] bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]">
        <span className="sr-only">{t.editor.customColour}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

/** A label over (or beside, on wide screens) its control. */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <div className="text-xs font-medium text-[var(--fg-muted)]">{label}</div>
      {children}
      {hint && <p className="text-[11px] text-[var(--fg-muted)]">{hint}</p>}
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, string, boolean?]>;
  onChange: (v: T) => void;
  /** For screen readers when there is no visible label next to it. */
  label?: string;
  className?: string;
}) {
  return (
    <select
      value={String(value)}
      aria-label={label}
      onChange={(e) => {
        const hit = options.find(([v]) => String(v) === e.target.value);
        if (hit) onChange(hit[0]);
      }}
      className={cn(
        'h-9 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 text-sm',
        className,
      )}
    >
      {options.map(([v, text, disabled]) => (
        <option key={String(v)} value={String(v)} disabled={disabled}>
          {text}
        </option>
      ))}
    </select>
  );
}

/** A number box with a unit after it. */
export function NumberBox({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
        className="h-9 w-24 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 tabular-nums"
      />
      {unit && <span className="text-xs text-[var(--fg-muted)]">{unit}</span>}
    </label>
  );
}

/** A switch with words beside it. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-brand-600"
      />
      {label}
    </label>
  );
}
