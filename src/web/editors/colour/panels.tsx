// Colour grading and selective colour panels (ADR-067), shared by the photo and video editors.
import { useState } from 'react';
import { t } from '../../lib/i18n';
import { Slider } from '../controls';
import {
  HSL_BANDS,
  NO_GRADE,
  NO_HSL,
  isNoHsl,
  type Grade,
  type Hsl,
  type HslBand,
} from '../photo/adjust';
import { ColourWheel } from './ColourWheel';

function Reset({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-subtle)]"
    >
      {t.editor.reset}
    </button>
  );
}

export function GradePanel({ grade, onChange }: { grade: Grade; onChange: (g: Grade) => void }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-around gap-2">
        {(['shadows', 'midtones', 'highlights'] as const).map((z) => (
          <ColourWheel
            key={z}
            label={t.editor.gradeZones[z]!}
            value={grade[z]}
            onChange={(w) => onChange({ ...grade, [z]: w })}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--fg-muted)]">{t.editor.gradeHint}</p>
        <Reset onClick={() => onChange(NO_GRADE)} />
      </div>
    </div>
  );
}

const SWATCH: Record<HslBand, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  aqua: '#06b6d4',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  magenta: '#d946ef',
};

export function HslPanel({ hsl, onChange }: { hsl: Hsl; onChange: (h: Hsl) => void }) {
  const [band, setBand] = useState<HslBand>('red');
  const v = hsl[band];
  const set = (p: Partial<typeof v>) => onChange({ ...hsl, [band]: { ...v, ...p } });
  return (
    <div className="space-y-2">
      <div className="flex justify-between gap-1">
        {HSL_BANDS.map((b) => {
          const changed = hsl[b].h || hsl[b].s || hsl[b].l;
          return (
            <button
              key={b}
              type="button"
              onClick={() => setBand(b)}
              aria-pressed={band === b}
              aria-label={t.editor.hslBands[b]}
              title={t.editor.hslBands[b]}
              className="relative h-8 w-8 shrink-0 rounded-full border border-black/15 aria-pressed:ring-2 aria-pressed:ring-brand-500 aria-pressed:ring-offset-2 aria-pressed:ring-offset-[var(--card)]"
              style={{ background: SWATCH[b] }}
            >
              {changed ? (
                <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-white bg-[var(--fg)]" />
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="text-sm font-medium">{t.editor.hslBands[band]}</p>
      <Slider label={t.editor.adjustments.hue!} value={v.h} onChange={(h) => set({ h })} />
      <Slider label={t.editor.adjustments.saturation!} value={v.s} onChange={(s) => set({ s })} />
      <Slider label={t.editor.adjustments.lightness!} value={v.l} onChange={(l) => set({ l })} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--fg-muted)]">{t.editor.hslHint}</p>
        {!isNoHsl(hsl) && <Reset onClick={() => onChange(NO_HSL)} />}
      </div>
    </div>
  );
}
