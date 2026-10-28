// Adding and changing text, stickers and shapes (ADR-067), the same panel in the photo editor, the
// collage and the video editor. The host places new items and keeps the list.
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Shapes,
  Smile,
  Trash2,
  Type,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { Chips, Slider, Swatches, Toggle } from '../controls';
import {
  FONTS,
  FONT_STACK,
  SHAPES,
  SHAPE_ASPECT,
  STICKERS,
  TEXT_STYLES,
  bringForward,
  type DecorItem,
  type ShapeId,
  type TextAlign,
} from './items';

export type NewItem =
  | { kind: 'text' }
  | { kind: 'sticker'; emoji: string }
  | { kind: 'shape'; shape: ShapeId; aspect: number };

function ShapeIcon({ shape }: { shape: ShapeId }) {
  const aspect = SHAPE_ASPECT[shape] ?? 1;
  const w = Math.min(26, 18 * aspect);
  const h = w / aspect;
  return (
    <svg width={30} height={22} viewBox="-15 -11 30 22" aria-hidden className="text-[var(--fg)]">
      <path
        d={pathData(shape, w, h)}
        fill={shape === 'line' ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={shape === 'line' ? 3 : 0}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** SVG path data for the little shape buttons: the same outlines as `shapePath` in draw.ts. */
function pathData(shape: ShapeId, w: number, h: number): string {
  const hw = w / 2;
  const hh = h / 2;
  const star = (n: number, inner: number) =>
    Array.from({ length: n * 2 }, (_, i) => {
      const a = (i * Math.PI) / n - Math.PI / 2;
      const k = i % 2 ? inner : 1;
      return `${i ? 'L' : 'M'}${(Math.cos(a) * hw * k).toFixed(2)},${(Math.sin(a) * hh * k).toFixed(2)}`;
    }).join('') + 'Z';
  switch (shape) {
    case 'rect':
      return `M${-hw},${-hh}h${w}v${h}h${-w}Z`;
    case 'round': {
      const r = Math.min(w, h) * 0.2;
      return `M${-hw + r},${-hh}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - 2 * r)}a${r},${r} 0 0 1 ${-r},${-r}v${-(h - 2 * r)}a${r},${r} 0 0 1 ${r},${-r}Z`;
    }
    case 'circle':
      return `M${-hw},0a${hw},${hh} 0 1 0 ${w},0a${hw},${hh} 0 1 0 ${-w},0Z`;
    case 'triangle':
      return `M0,${-hh}L${hw},${hh}L${-hw},${hh}Z`;
    case 'star':
      return star(5, 0.45);
    case 'burst':
      return star(12, 0.72);
    case 'heart':
      return `M0,${h * 0.45}C${w * -0.6},${h * 0.05} ${w * -0.52},${h * -0.45} ${w * -0.25},${h * -0.47}C${w * -0.1},${h * -0.48} 0,${h * -0.37} 0,${h * -0.26}C0,${h * -0.37} ${w * 0.1},${h * -0.48} ${w * 0.25},${h * -0.47}C${w * 0.52},${h * -0.45} ${w * 0.6},${h * 0.05} 0,${h * 0.45}Z`;
    case 'arrow': {
      const t0 = h * 0.18;
      const head = Math.min(w * 0.45, h * 0.9);
      return `M${-hw},${-t0}L${hw - head},${-t0}L${hw - head},${-hh}L${hw},0L${hw - head},${hh}L${hw - head},${t0}L${-hw},${t0}Z`;
    }
    case 'line':
      return `M${-hw},0L${hw},0`;
    case 'bubble': {
      const body = h * 0.8;
      return `M${-hw},${-hh}h${w}v${body}h${-w * 0.45}L${-w * 0.3},${hh}L${-w * 0.22},${-hh + body}H${-hw}Z`;
    }
  }
}

export function DecorPanel({
  items,
  chosen,
  onChange,
  onChoose,
  onAdd,
  only,
}: {
  items: DecorItem[];
  chosen: string | null;
  onChange: (items: DecorItem[]) => void;
  onChoose: (id: string | null) => void;
  onAdd: (n: NewItem) => void;
  /** Show only these add buttons (the video's text and sticker tools). */
  only?: Array<'text' | 'sticker' | 'shape'>;
}) {
  const [adding, setAdding] = useState<'sticker' | 'shape' | null>(null);
  const [group, setGroup] = useState('smile');
  const item = items.find((i) => i.id === chosen) ?? null;
  const change = (p: Partial<DecorItem>) =>
    item && onChange(items.map((i) => (i.id === item.id ? ({ ...i, ...p } as DecorItem) : i)));
  const can = (k: 'text' | 'sticker' | 'shape') => !only || only.includes(k);

  const addRow = (
    <div className="flex gap-2">
      {can('text') && (
        <AddButton icon={Type} label={t.overlay.addText} onClick={() => onAdd({ kind: 'text' })} />
      )}
      {can('sticker') && (
        <AddButton
          icon={Smile}
          label={t.overlay.addSticker}
          active={adding === 'sticker'}
          onClick={() => setAdding(adding === 'sticker' ? null : 'sticker')}
        />
      )}
      {can('shape') && (
        <AddButton
          icon={Shapes}
          label={t.overlay.addShape}
          active={adding === 'shape'}
          onClick={() => setAdding(adding === 'shape' ? null : 'shape')}
        />
      )}
    </div>
  );

  if (adding === 'sticker')
    return (
      <div className="space-y-2">
        {addRow}
        <Chips
          items={Object.keys(STICKERS).map((g) => [g, t.overlay.stickerGroups[g] ?? g] as const)}
          value={group}
          onChange={setGroup}
        />
        <div className="grid grid-cols-8 gap-1 sm:grid-cols-12">
          {STICKERS[group]!.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                onAdd({ kind: 'sticker', emoji: e });
                setAdding(null);
              }}
              className="rounded-lg py-1 text-2xl hover:bg-[var(--bg-subtle)]"
              aria-label={e}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    );
  if (adding === 'shape')
    return (
      <div className="space-y-2">
        {addRow}
        <div className="grid grid-cols-5 gap-1">
          {SHAPES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onAdd({ kind: 'shape', shape: s, aspect: SHAPE_ASPECT[s] ?? 1 });
                setAdding(null);
              }}
              className="flex flex-col items-center gap-1 rounded-lg py-1.5 text-[11px] text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
            >
              <ShapeIcon shape={s} />
              {t.overlay.shapes[s]}
            </button>
          ))}
        </div>
      </div>
    );

  if (!item)
    return (
      <div className="space-y-2">
        {addRow}
        <p className="text-xs text-[var(--fg-muted)]">
          {items.length ? t.overlay.hint : t.overlay.empty}
        </p>
      </div>
    );

  const actions = (
    <div className="flex items-center gap-1">
      <IconAction
        icon={Copy}
        label={t.overlay.duplicate}
        onClick={() => {
          const id = `${item.id}c${Date.now() % 100000}`;
          onChange([
            ...items,
            { ...item, id, x: Math.min(0.95, item.x + 0.04), y: Math.min(0.95, item.y + 0.04) },
          ]);
          onChoose(id);
        }}
      />
      <IconAction
        icon={ArrowUpToLine}
        label={t.overlay.front}
        onClick={() => onChange(bringForward(items, item.id, 1))}
      />
      <IconAction
        icon={ArrowDownToLine}
        label={t.overlay.back}
        onClick={() => onChange(bringForward(items, item.id, -1))}
      />
      <IconAction
        icon={Trash2}
        label={t.overlay.remove}
        danger
        onClick={() => {
          onChange(items.filter((i) => i.id !== item.id));
          onChoose(null);
        }}
      />
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        {addRow}
        {actions}
      </div>
      {item.kind === 'text' && (
        <>
          <textarea
            value={item.text}
            rows={2}
            onChange={(e) => change({ text: e.target.value })}
            placeholder={t.overlay.placeholder}
            aria-label={t.overlay.placeholder}
            className="w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm"
          />
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
            {FONTS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => change({ font: f })}
                aria-pressed={item.font === f}
                style={{ fontFamily: FONT_STACK[f] }}
                className={cn(
                  'shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 text-sm',
                  item.font === f &&
                    'border-brand-500 bg-[var(--accent-soft)] text-[var(--accent)]',
                )}
              >
                {t.overlay.fonts[f]}
              </button>
            ))}
          </div>
          <Chips
            items={TEXT_STYLES.map((s) => [s, t.overlay.styles[s]!] as const)}
            value={item.style}
            onChange={(style) => change({ style })}
          />
          <div className="flex items-center gap-2">
            <div
              className="flex rounded-full border border-[var(--border)]"
              role="group"
              aria-label={t.overlay.align}
            >
              {(
                [
                  ['left', AlignLeft],
                  ['center', AlignCenter],
                  ['right', AlignRight],
                ] as const
              ).map(([a, Icon]) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => change({ align: a as TextAlign })}
                  aria-pressed={item.align === a}
                  aria-label={t.overlay.aligns[a]}
                  className={cn(
                    'rounded-full p-1.5',
                    item.align === a && 'bg-[var(--accent-soft)] text-[var(--accent)]',
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <Swatches value={item.color} onChange={(color) => change({ color })} />
            </div>
          </div>
        </>
      )}
      {item.kind === 'shape' && (
        <>
          <Swatches value={item.color} onChange={(color) => change({ color })} />
          {item.shape !== 'line' && (
            <Toggle
              checked={!item.fill}
              onChange={(v) => change({ fill: !v })}
              label={t.overlay.outlineOnly}
            />
          )}
          {(!item.fill || item.shape === 'line') && (
            <Slider
              label={t.overlay.lineWidth}
              min={1}
              max={30}
              zero={8}
              value={Math.round(item.line * 100)}
              onChange={(v) => change({ line: v / 100 })}
            />
          )}
          <Slider
            label={t.overlay.width}
            min={20}
            max={500}
            zero={100}
            unit="%"
            value={Math.round(item.aspect * 100)}
            onChange={(v) => change({ aspect: v / 100 })}
          />
        </>
      )}
      <Slider
        label={t.overlay.size}
        min={1}
        max={item.kind === 'text' ? 40 : 100}
        zero={item.kind === 'text' ? 8 : 20}
        value={Math.round(item.size * 100)}
        onChange={(v) => change({ size: v / 100 })}
      />
      <Slider
        label={t.overlay.rotation}
        min={-180}
        max={180}
        unit="°"
        value={Math.round(item.rotation)}
        onChange={(rotation) => change({ rotation })}
      />
      <Slider
        label={t.overlay.opacity}
        min={5}
        max={100}
        zero={100}
        unit="%"
        value={Math.round(item.opacity * 100)}
        onChange={(v) => change({ opacity: v / 100 })}
      />
    </div>
  );
}

function AddButton({
  icon: Icon,
  label,
  onClick,
  active = false,
}: {
  icon: typeof Type;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--bg-subtle)]',
        active && 'border-brand-500 bg-[var(--accent-soft)] text-[var(--accent)]',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  danger = false,
}: {
  icon: typeof Type;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn('rounded-full p-2 hover:bg-[var(--bg-subtle)]', danger && 'text-red-600')}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
