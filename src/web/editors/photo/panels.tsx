// The photo editor's tool panels (ADR-052): what shows under the photo while a tool is open. Each
// changes a draft of the photo; the editor keeps it (✓) or drops it (✕).
import { FlipHorizontal2, FlipVertical2, Plus, RotateCcw, RotateCw, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { IMAGE_LABEL, IMAGE_TYPES } from '../codecs/image';
import { Chips, Slider, Swatches, signed } from '../controls';
import { ToolButton } from '../ui';
import {
  CURVE_PRESETS,
  NO_CURVES,
  NO_DETAIL,
  NO_EFFECTS,
  NO_TUNE,
  NO_WB,
  type Channel,
  type CurvePreset,
  type Tune,
} from './adjust';
import { CurveEditor } from './CurveEditor';
import { outputSize } from './geometry';
import type { OutType } from './render';
import type { FrameStyle, PhotoState, TextStyle } from './state';

export { Chips, COLOURS, Slider, Swatches } from '../controls';

export interface PanelProps {
  st: PhotoState;
  edit: (p: Partial<PhotoState>) => void;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-2 pt-1">{children}</div>;
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-subtle)]"
    >
      {children}
    </button>
  );
}

const TUNE_KEYS: Array<keyof Tune> = [
  'brightness',
  'contrast',
  'saturation',
  'ambiance',
  'highlights',
  'shadows',
  'warmth',
];

export function TunePanel({ st, edit, onAuto }: PanelProps & { onAuto: () => void }) {
  const [key, setKey] = useState<keyof Tune>('brightness');
  return (
    <div className="space-y-2">
      <Chips
        items={TUNE_KEYS.map((k) => [k, t.editor.adjustments[k]!] as const)}
        value={key}
        onChange={setKey}
        badge={(k) => (st.tune[k] ? signed(st.tune[k]) : null)}
      />
      <Slider
        label={t.editor.adjustments[key]!}
        value={st.tune[key]}
        onChange={(v) => edit({ tune: { ...st.tune, [key]: v } })}
      />
      <Row>
        <LinkButton onClick={onAuto}>{t.editor.auto}</LinkButton>
        <LinkButton onClick={() => edit({ tune: NO_TUNE })}>{t.editor.reset}</LinkButton>
      </Row>
    </div>
  );
}

export function DetailPanel({ st, edit }: PanelProps) {
  return (
    <div className="space-y-2">
      <Slider
        label={t.editor.adjustments.structure!}
        value={st.detail.structure}
        onChange={(v) => edit({ detail: { ...st.detail, structure: v } })}
      />
      <Slider
        label={t.editor.adjustments.sharpen!}
        min={0}
        value={st.detail.sharpen}
        onChange={(v) => edit({ detail: { ...st.detail, sharpen: v } })}
      />
      <Row>
        <span />
        <LinkButton onClick={() => edit({ detail: NO_DETAIL })}>{t.editor.reset}</LinkButton>
      </Row>
    </div>
  );
}

export function WbPanel({ st, edit, onAuto }: PanelProps & { onAuto: () => void }) {
  return (
    <div className="space-y-2">
      <Slider
        label={t.editor.adjustments.temperature!}
        value={st.wb.temperature}
        onChange={(v) => edit({ wb: { ...st.wb, temperature: v } })}
      />
      <Slider
        label={t.editor.adjustments.tint!}
        value={st.wb.tint}
        onChange={(v) => edit({ wb: { ...st.wb, tint: v } })}
      />
      <Row>
        <LinkButton onClick={onAuto}>{t.editor.auto}</LinkButton>
        <LinkButton onClick={() => edit({ wb: NO_WB })}>{t.editor.reset}</LinkButton>
      </Row>
    </div>
  );
}

export function CurvesPanel({
  st,
  edit,
  histogram,
}: PanelProps & { histogram: Uint32Array | null }) {
  const [channel, setChannel] = useState<Channel>('rgb');
  const set = (p: ReadonlyArray<readonly [number, number]>) =>
    edit({ curves: { ...st.curves, [channel]: p } });
  return (
    <div className="space-y-2">
      <Chips
        items={(['rgb', 'r', 'g', 'b'] as const).map(
          (c) => [c, t.editor.curveChannels[c]!] as const,
        )}
        value={channel}
        onChange={setChannel}
      />
      <div className="flex items-start gap-3">
        <CurveEditor
          points={st.curves[channel]}
          channel={channel}
          histogram={histogram}
          onChange={set}
          onCommit={set}
        />
        <div className="w-full min-w-0 space-y-2">
          <div className="flex flex-wrap gap-1">
            {(Object.keys(CURVE_PRESETS) as CurvePreset[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => set(CURVE_PRESETS[p])}
                className="rounded-full border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--bg-subtle)]"
              >
                {t.editor.curvePresets[p]}
              </button>
            ))}
          </div>
          <p className="text-xs text-[var(--fg-muted)]">{t.editor.curveHint}</p>
          <div className="text-right">
            <LinkButton onClick={() => edit({ curves: NO_CURVES })}>{t.editor.reset}</LinkButton>
          </div>
        </div>
      </div>
    </div>
  );
}

export const RATIOS: Array<{ id: string; value: number | 'original' | null }> = [
  { id: 'free', value: null },
  { id: 'original', value: 'original' },
  { id: '1:1', value: 1 },
  { id: '4:3', value: 4 / 3 },
  { id: '3:4', value: 3 / 4 },
  { id: '16:9', value: 16 / 9 },
  { id: '9:16', value: 9 / 16 },
  { id: '4:5', value: 4 / 5 },
];

export function CropPanel({ ratio, onRatio }: { ratio: string; onRatio: (id: string) => void }) {
  return (
    <Chips
      items={RATIOS.map(
        (r) =>
          [
            r.id,
            r.id === 'free'
              ? t.editor.ratioFree
              : r.id === 'original'
                ? t.editor.ratioOriginal
                : r.id,
          ] as const,
      )}
      value={ratio}
      onChange={onRatio}
    />
  );
}

export function RotatePanel({
  st,
  edit,
  turn,
  flip,
}: PanelProps & { turn: (dir: 1 | -1) => void; flip: (axis: 'h' | 'v') => void }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-center gap-1">
        <ToolButton icon={RotateCcw} label={t.editor.rotateLeft} onClick={() => turn(-1)} />
        <ToolButton icon={RotateCw} label={t.editor.rotateRight} onClick={() => turn(1)} />
        <ToolButton
          // Lucide draws the mirror line: a vertical line flips left-right.
          icon={FlipVertical2}
          label={t.editor.flipH}
          onClick={() => flip('h')}
        />
        <ToolButton icon={FlipHorizontal2} label={t.editor.flipV} onClick={() => flip('v')} />
      </div>
      <Slider
        label={t.editor.adjustments.straighten!}
        min={-45}
        max={45}
        step={0.5}
        unit="°"
        value={st.angle}
        onChange={(angle) => edit({ angle })}
      />
    </div>
  );
}

export function VignettePanel({ st, edit }: PanelProps) {
  return (
    <div className="space-y-2">
      <Slider
        label={t.editor.adjustments.amount!}
        value={st.vignette.amount}
        onChange={(amount) => edit({ vignette: { ...st.vignette, amount } })}
      />
      <Slider
        label={t.editor.adjustments.size!}
        min={0}
        zero={50}
        value={st.vignette.size}
        onChange={(size) => edit({ vignette: { ...st.vignette, size } })}
      />
      <p className="text-xs text-[var(--fg-muted)]">{t.editor.centerHint}</p>
    </div>
  );
}

export function LensPanel({ st, edit }: PanelProps) {
  const lens = st.lens;
  const set = (p: Partial<typeof lens>) => edit({ lens: { ...lens, ...p } });
  return (
    <div className="space-y-2">
      <Chips
        items={(['off', 'radial', 'linear'] as const).map(
          (s) => [s, t.editor.lensShapes[s]!] as const,
        )}
        value={lens.shape}
        onChange={(shape) => set({ shape })}
      />
      {lens.shape !== 'off' && (
        <>
          <Slider
            label={t.editor.adjustments.blur!}
            min={0}
            zero={60}
            value={lens.strength}
            onChange={(strength) => set({ strength })}
          />
          <Slider
            label={t.editor.adjustments.size!}
            min={0}
            zero={35}
            value={lens.size}
            onChange={(size) => set({ size })}
          />
          <Slider
            label={t.editor.adjustments.transition!}
            min={0}
            zero={50}
            value={lens.fade}
            onChange={(fade) => set({ fade })}
          />
          {lens.shape === 'linear' && (
            <Slider
              label={t.editor.adjustments.angle!}
              min={-90}
              max={90}
              unit="°"
              value={lens.angle}
              onChange={(angle) => set({ angle })}
            />
          )}
          <p className="text-xs text-[var(--fg-muted)]">{t.editor.centerHint}</p>
        </>
      )}
    </div>
  );
}

export function EffectsPanel({ st, edit }: PanelProps) {
  const fx = st.effects;
  return (
    <div className="space-y-2">
      {(['glow', 'grain', 'fade'] as const).map((k) => (
        <Slider
          key={k}
          label={t.editor.adjustments[k]!}
          min={0}
          value={fx[k]}
          onChange={(v) => edit({ effects: { ...fx, [k]: v } })}
        />
      ))}
      <Row>
        <span />
        <LinkButton onClick={() => edit({ effects: NO_EFFECTS })}>{t.editor.reset}</LinkButton>
      </Row>
    </div>
  );
}

export function HealPanel({
  brush,
  onBrush,
  count,
  onClear,
}: {
  brush: number;
  onBrush: (v: number) => void;
  count: number;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--fg-muted)]">{t.editor.healHint}</p>
      <Slider
        label={t.editor.adjustments.brush!}
        min={2}
        max={20}
        zero={6}
        value={brush}
        onChange={onBrush}
      />
      {count > 0 && (
        <div className="text-right">
          <LinkButton onClick={onClear}>{t.editor.healClear}</LinkButton>
        </div>
      )}
    </div>
  );
}

const TEXT_STYLES: TextStyle[] = ['plain', 'bold', 'box', 'outline'];

export function TextPanel({
  st,
  edit,
  chosen,
  onAdd,
  onChoose,
}: PanelProps & {
  chosen: string | null;
  onAdd: () => void;
  onChoose: (id: string | null) => void;
}) {
  const mark = st.texts.find((m) => m.id === chosen) ?? null;
  const change = (p: Partial<NonNullable<typeof mark>>) =>
    mark && edit({ texts: st.texts.map((m) => (m.id === mark.id ? { ...m, ...p } : m)) });
  if (!mark)
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={onAdd}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border)] py-3 text-sm hover:bg-[var(--bg-subtle)]"
        >
          <Plus className="h-4 w-4" />
          {t.editor.textAdd}
        </button>
        {st.texts.length > 0 && (
          <p className="text-center text-xs text-[var(--fg-muted)]">{t.editor.textHint}</p>
        )}
      </div>
    );
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={mark.text}
          onChange={(e) => change({ text: e.target.value })}
          placeholder={t.editor.textPlaceholder}
          aria-label={t.editor.textPlaceholder}
          className="h-9 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm"
        />
        <button
          type="button"
          onClick={() => {
            edit({ texts: st.texts.filter((m) => m.id !== mark.id) });
            onChoose(null);
          }}
          className="rounded-full p-2 text-red-600 hover:bg-[var(--bg-subtle)]"
          aria-label={t.editor.textDelete}
          title={t.editor.textDelete}
        >
          <X className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onAdd}
          className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
          aria-label={t.editor.textAdd}
          title={t.editor.textAdd}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <Chips
        items={TEXT_STYLES.map((s) => [s, t.editor.textStyles[s]!] as const)}
        value={mark.style}
        onChange={(style) => change({ style })}
      />
      <Swatches value={mark.color} onChange={(color) => change({ color })} />
      <Slider
        label={t.editor.adjustments.textSize!}
        min={2}
        max={30}
        zero={8}
        value={Math.round(mark.size * 100)}
        onChange={(v) => change({ size: v / 100 })}
      />
    </div>
  );
}

const FRAME_STYLES: FrameStyle[] = ['none', 'thin', 'thick', 'polaroid', 'round'];
const FRAME_COLOURS = ['#ffffff', '#111111', '#f5efe0', '#9ca3af', '#1e3a8a', '#7f1d1d', '#facc15'];

export function FramePanel({ st, edit }: PanelProps) {
  const f = st.frame;
  return (
    <div className="space-y-2">
      <Chips
        items={FRAME_STYLES.map((s) => [s, t.editor.frameStyles[s]!] as const)}
        value={f.style}
        onChange={(style) => edit({ frame: { ...f, style } })}
      />
      {f.style !== 'none' && (
        <>
          <Swatches
            value={f.color}
            colours={FRAME_COLOURS}
            onChange={(color) => edit({ frame: { ...f, color } })}
          />
          <Slider
            label={t.editor.adjustments.width!}
            min={0}
            zero={40}
            value={f.width}
            onChange={(width) => edit({ frame: { ...f, width } })}
          />
        </>
      )}
    </div>
  );
}

const SCALES = [1, 0.75, 0.5, 0.25];

export function SizePanel({
  st,
  edit,
  full,
  type,
  onType,
  quality,
  onQuality,
}: PanelProps & {
  full: { width: number; height: number };
  type: OutType;
  onType: (t: OutType) => void;
  quality: number;
  onQuality: (q: number) => void;
}) {
  const base = outputSize(full.width, full.height, st.o.turn, st.crop, 1);
  const out = outputSize(full.width, full.height, st.o.turn, st.crop, st.scale);
  const toScale = (px: number, side: number) =>
    edit({ scale: Math.max(16 / side, Math.min(1, px / side)) });
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-xs text-[var(--fg-muted)]">{t.editor.scale}</span>
        {SCALES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => edit({ scale: s })}
            aria-pressed={st.scale === s}
            className={cn(
              'rounded-full border border-[var(--border)] px-3 py-1 text-xs',
              st.scale === s && 'border-brand-500 bg-[var(--accent-soft)] text-[var(--accent)]',
            )}
          >
            {Math.round(s * 100)}%
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-[var(--fg-muted)]">{t.editor.widthPx}</span>
          <input
            type="number"
            min={16}
            max={base.w}
            value={out.w}
            onChange={(e) => toScale(Number(e.target.value) || 0, base.w)}
            className="h-9 w-24 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 tabular-nums"
          />
        </label>
        <span className="text-[var(--fg-muted)]">×</span>
        <label className="flex items-center gap-2">
          <span className="text-[var(--fg-muted)]">{t.editor.heightPx}</span>
          <input
            type="number"
            min={16}
            max={base.h}
            value={out.h}
            onChange={(e) => toScale(Number(e.target.value) || 0, base.h)}
            className="h-9 w-24 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 tabular-nums"
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="photo-format" className="w-20 text-xs text-[var(--fg-muted)]">
          {t.editor.format}
        </label>
        <select
          id="photo-format"
          value={type}
          onChange={(e) => onType(e.target.value as OutType)}
          className="h-9 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2"
        >
          {IMAGE_TYPES.map((x) => (
            <option key={x} value={x}>
              {IMAGE_LABEL[x]}
            </option>
          ))}
        </select>
        {type !== 'image/png' && (
          <label className="flex min-w-40 flex-1 items-center gap-2 text-xs text-[var(--fg-muted)]">
            {t.editor.quality}
            <input
              type="range"
              min={0.4}
              max={1}
              step={0.05}
              value={quality}
              onChange={(e) => onQuality(Number(e.target.value))}
              className="flex-1 accent-brand-600"
            />
            <span className="w-9 text-right tabular-nums">{Math.round(quality * 100)}</span>
          </label>
        )}
      </div>
      <p className="text-xs text-[var(--fg-muted)]">{t.editor.exifNote}</p>
    </div>
  );
}
