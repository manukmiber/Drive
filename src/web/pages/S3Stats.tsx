// A bucket's statistics and access logging on the /s3 page (ADR-060): objects and bytes from the
// index, requests and downloads per WIB day for 30 days, and where its access logs go.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatBytes, formatCount, formatDate } from '../../shared/format';
import { Button } from '../components/Button';
import { Dialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { api, sendJson } from '../lib/api';
import { t } from '../lib/i18n';

export interface LoggingConfig {
  target: string;
  prefix: string;
}

interface Day {
  day: number;
  requests: number;
  errors: number;
  ingressBytes: number;
  egressBytes: number;
}

interface Stats {
  objects: number;
  bytes: number;
  days: Day[];
  logging: LoggingConfig | null;
}

/** One measure per day as thin bars on one axis; the hovered/focused day is read out above. */
function DayBars({
  label,
  days,
  value,
  describe,
}: {
  label: string;
  days: Day[];
  value: (d: Day) => number;
  describe: (d: Day) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...days.map(value));
  const shown = days[active ?? days.length - 1];
  return (
    <figure className="mt-4">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-[var(--fg)]">{label}</span>
        <span className="truncate text-[var(--fg-muted)]" aria-live="polite">
          {shown ? describe(shown) : ''}
        </span>
      </figcaption>
      <div
        role="img"
        aria-label={label}
        className="mt-2 flex h-24 items-end gap-[2px] border-b border-[var(--border)]"
        onMouseLeave={() => setActive(null)}
      >
        {days.map((d, i) => {
          const v = value(d);
          return (
            <div
              key={d.day}
              className="flex h-full min-w-0 flex-1 cursor-default items-end"
              onMouseEnter={() => setActive(i)}
              onTouchStart={() => setActive(i)}
            >
              <div
                className={`w-full rounded-t-[3px] ${
                  active === i ? 'bg-brand-700 dark:bg-brand-400' : 'bg-brand-600 dark:bg-brand-500'
                }`}
                style={{ height: v ? `max(2px, ${(v / max) * 100}%)` : 0 }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-[var(--fg-muted)]">
        <span>{days[0] ? formatDate(days[0].day) : ''}</span>
        <span>{days.at(-1) ? formatDate(days.at(-1)!.day) : ''}</span>
      </div>
    </figure>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl bg-[var(--bg-subtle)] px-3 py-2">
      <p className="text-[11px] text-[var(--fg-muted)]">{label}</p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
      {note && <p className="text-[11px] text-[var(--fg-muted)]">{note}</p>}
    </div>
  );
}

function LoggingForm({
  bucket,
  current,
  buckets,
  onSaved,
}: {
  bucket: string;
  current: LoggingConfig | null;
  buckets: string[];
  onSaved: () => void;
}) {
  const [on, setOn] = useState(Boolean(current));
  const [target, setTarget] = useState(
    current?.target ?? buckets.find((b) => b !== bucket) ?? bucket,
  );
  const [prefix, setPrefix] = useState(current?.prefix ?? `logs/${bucket}/`);
  const [busy, setBusy] = useState(false);
  const path = `/api/s3/buckets/${encodeURIComponent(bucket)}/logging`;
  async function save(enable: boolean) {
    setBusy(true);
    try {
      if (enable) await sendJson('PUT', path, { target, prefix });
      else await sendJson('DELETE', path);
      toast(enable ? t.s3.loggingSaved : t.s3.loggingOff);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : t.errors.generic, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  const field =
    'mt-1 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--fg)]';
  return (
    <section className="mt-5 border-t border-[var(--border)] pt-4" aria-labelledby="s3-logging">
      <h3 id="s3-logging" className="text-sm font-semibold">
        {t.s3.logging}
      </h3>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.s3.loggingBody}</p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => {
            setOn(e.target.checked);
            if (!e.target.checked && current) void save(false);
          }}
        />
        {t.s3.loggingEnable}
      </label>
      {on && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-[var(--fg-muted)]">
            {t.s3.loggingTarget}
            <select className={field} value={target} onChange={(e) => setTarget(e.target.value)}>
              {buckets.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--fg-muted)]">
            {t.s3.loggingPrefix}
            <input
              className={field}
              value={prefix}
              maxLength={512}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </label>
          <div className="sm:col-span-2">
            <Button disabled={busy || !target} onClick={() => void save(true)} className="h-9 px-3">
              {t.s3.loggingSave}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function S3StatsDialog({
  bucket,
  buckets,
  onClose,
  onSaved,
}: {
  bucket: string;
  buckets: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const q = useQuery({
    queryKey: ['s3-stats', bucket],
    queryFn: () => api<Stats>(`/api/s3/buckets/${encodeURIComponent(bucket)}/stats`),
  });
  const s = q.data;
  const sum = (f: (d: Day) => number) => (s ? s.days.reduce((n, d) => n + f(d), 0) : 0);
  return (
    <Dialog open title={t.s3.statsTitle(bucket)} onClose={onClose}>
      {!s ? (
        <p className="py-6 text-center text-sm text-[var(--fg-muted)]">
          {q.isError ? t.errors.generic : t.common.loading}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Tile label={t.s3.statsObjects} value={formatCount(s.objects)} />
            <Tile label={t.s3.statsSize} value={formatBytes(s.bytes)} />
            <Tile
              label={t.s3.statsRequests}
              value={formatCount(sum((d) => d.requests))}
              note={t.s3.statsErrors(formatCount(sum((d) => d.errors)))}
            />
            <Tile label={t.s3.statsEgress} value={formatBytes(sum((d) => d.egressBytes))} />
          </div>
          <DayBars
            label={t.s3.statsRequestsPerDay}
            days={s.days}
            value={(d) => d.requests}
            describe={(d) => t.s3.statsDayRequests(formatDate(d.day), formatCount(d.requests))}
          />
          <DayBars
            label={t.s3.statsEgressPerDay}
            days={s.days}
            value={(d) => d.egressBytes}
            describe={(d) => t.s3.statsDayEgress(formatDate(d.day), formatBytes(d.egressBytes))}
          />
          <p className="mt-2 text-[11px] text-[var(--fg-muted)]">{t.s3.statsHint}</p>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-[var(--fg-muted)]">{t.s3.statsTable}</summary>
            <div className="mt-2 max-h-48 overflow-auto">
              <table className="w-full text-left tabular-nums">
                <thead className="text-[var(--fg-muted)]">
                  <tr>
                    <th className="py-1 font-normal">{t.s3.statsDay}</th>
                    <th className="py-1 text-right font-normal">{t.s3.statsRequestsPerDay}</th>
                    <th className="py-1 text-right font-normal">{t.s3.statsEgressPerDay}</th>
                    <th className="py-1 text-right font-normal">{t.s3.statsUploaded}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...s.days].reverse().map((d) => (
                    <tr key={d.day} className="border-t border-[var(--border)]">
                      <td className="py-1">{formatDate(d.day)}</td>
                      <td className="py-1 text-right">{formatCount(d.requests)}</td>
                      <td className="py-1 text-right">{formatBytes(d.egressBytes)}</td>
                      <td className="py-1 text-right">{formatBytes(d.ingressBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <LoggingForm
            bucket={bucket}
            current={s.logging}
            buckets={buckets}
            onSaved={() => {
              void q.refetch();
              onSaved();
            }}
          />
        </>
      )}
    </Dialog>
  );
}
