import { formatBytes, formatPercent, usageRatios } from '../../shared/format';
import { t } from '../../shared/strings.id';
import type { Me } from '../lib/types';

export function StorageMeter({ storage }: { storage: Me['storage'] }) {
  const used = storage.usedBytes + storage.reservedBytes;
  const r = usageRatios(used, storage.limitBytes);
  const tone = r.used >= 0.95 ? 'bg-red-500' : r.used >= 0.8 ? 'bg-amber-500' : 'bg-brand-600';
  return (
    <div className="space-y-2">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(r.used * 100)}
        aria-label="Penyimpanan terpakai"
      >
        <div
          className={`h-full ${tone}`}
          style={{ width: `${Math.max(r.used * 100, used > 0 ? 2 : 0)}%` }}
        />
      </div>
      {storage.limitBytes > 0 ? (
        <>
          <p className="text-xs text-[var(--fg-muted)]">
            {t.storage.meter(formatPercent(r.used), formatPercent(r.free))}
          </p>
          <p className="text-xs text-[var(--fg-muted)]">
            {t.storage.of(formatBytes(used), formatBytes(storage.limitBytes))}
          </p>
        </>
      ) : (
        <p className="text-xs text-[var(--fg-muted)]">{t.storage.noPlan}</p>
      )}
    </div>
  );
}
