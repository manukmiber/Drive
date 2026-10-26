// "Upload & unduhan" (ADR-053): how many files move at once on this device, at most 20 each way.
import { Gauge } from 'lucide-react';
import { useId } from 'react';
import { t } from '../lib/i18n';
import {
  connectionHint,
  presetOf,
  presetValues,
  suggestPreset,
  transfer,
  useTransferSettings,
  type PresetId,
} from '../lib/transfer';
import { cn } from '../lib/cn';

const PRESETS: PresetId[] = ['saver', 'normal', 'fast', 'max'];

function Stepper({
  label,
  hint,
  value,
  max,
  unit,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  max: number;
  unit: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className="text-sm tabular-nums">
          {unit(value)}{' '}
          <span className="text-xs text-[var(--fg-muted)]">· {t.transfer.max(max)}</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={1}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-brand-600"
      />
      {hint && <p className="mt-1 text-xs text-[var(--fg-muted)]">{hint}</p>}
    </div>
  );
}

export function TransferSettingsForm() {
  const s = useTransferSettings();
  const limits = transfer.limits();
  const current = presetOf(s, limits);
  const suggested = suggestPreset(connectionHint());
  return (
    <div className="space-y-5">
      <div
        role="radiogroup"
        aria-label={t.transfer.settingsTitle}
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {PRESETS.map((id) => {
          const v = presetValues(id, limits);
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={current === id}
              onClick={() => transfer.set(v)}
              className={cn(
                'rounded-xl border p-3 text-left',
                current === id
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-800/40'
                  : 'border-[var(--border)] hover:bg-[var(--bg-subtle)]',
              )}
            >
              <span className="block text-sm font-medium">{t.transfer.presets[id]}</span>
              <span className="mt-0.5 block text-xs text-[var(--fg-muted)]">
                {t.transfer.presetHints[id]}
              </span>
              <span className="mt-1 block text-xs tabular-nums text-[var(--fg-muted)]">
                ↑{v.uploadFiles} · ↓{v.downloadFiles}
              </span>
            </button>
          );
        })}
      </div>
      {current === null && <p className="text-xs text-[var(--fg-muted)]">{t.transfer.custom}</p>}
      {suggested && suggested !== current && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--fg-muted)]">
          <Gauge className="h-4 w-4" aria-hidden="true" />
          {t.transfer.suggestion(t.transfer.presets[suggested]!)}
          <button
            type="button"
            className="font-medium text-brand-700"
            onClick={() => transfer.set(presetValues(suggested, limits))}
          >
            {t.transfer.usePreset}
          </button>
        </p>
      )}
      <Stepper
        label={t.transfer.uploadFiles}
        value={s.uploadFiles}
        max={limits.uploadFilesMax}
        unit={t.transfer.files}
        onChange={(n) => transfer.set({ uploadFiles: n })}
      />
      <Stepper
        label={t.transfer.uploadParts}
        hint={t.transfer.uploadPartsHint}
        value={s.uploadParts}
        max={limits.uploadPartsMax}
        unit={t.transfer.parts}
        onChange={(n) => transfer.set({ uploadParts: n })}
      />
      <Stepper
        label={t.transfer.downloadFiles}
        hint={t.transfer.downloadFilesHint}
        value={s.downloadFiles}
        max={limits.downloadFilesMax}
        unit={t.transfer.files}
        onChange={(n) => transfer.set({ downloadFiles: n })}
      />
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={s.keepAwake}
          onChange={(e) => transfer.set({ keepAwake: e.target.checked })}
        />
        <span>
          {t.transfer.keepAwake}
          <span className="block text-xs text-[var(--fg-muted)]">{t.transfer.keepAwakeHint}</span>
        </span>
      </label>
      <button
        type="button"
        className="text-xs font-medium text-brand-700"
        onClick={() => transfer.reset()}
      >
        {t.transfer.reset}
      </button>
    </div>
  );
}
