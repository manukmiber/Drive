import { formatBytes, formatPercent, usageRatios } from '../../shared/format';
import { t } from '../lib/i18n';
import type { Me } from '../lib/types';

// How full the person's storage is: the figure first, a bar in the ink fill, and the bar turns to
// the warning and error colours at 80% and 95% (the only time it is not ink).
export function StorageMeter({ storage }: { storage: Me['storage'] }) {
  const used = storage.usedBytes + storage.reservedBytes;
  const r = usageRatios(used, storage.limitBytes);
  const tone =
    r.used >= 0.95 ? 'bg-[var(--err)]' : r.used >= 0.8 ? 'bg-[var(--warn)]' : 'bg-[var(--fill)]';
  return (
    <div className="space-y-2">
      {storage.limitBytes > 0 && (
        <p className="text-sm font-bold text-[var(--ink)] tabular-nums">
          {t.storage.of(formatBytes(used), formatBytes(storage.limitBytes))}
        </p>
      )}
      <div
        className="h-1.5 overflow-hidden rounded-full bg-[var(--line)]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(r.used * 100)}
        aria-label={t.a11y.storageUsed}
      >
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${Math.max(r.used * 100, used > 0 ? 2 : 0)}%` }}
        />
      </div>
      {storage.limitBytes > 0 ? (
        <p className="text-xs text-[var(--muted)] tabular-nums">
          {t.storage.meter(formatPercent(r.used), formatPercent(r.free))}
        </p>
      ) : (
        <p className="text-xs text-[var(--muted)]">{t.storage.noPlan}</p>
      )}
    </div>
  );
}
