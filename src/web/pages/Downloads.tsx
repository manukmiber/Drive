// /unduhan — async archives built on the server (SPEC §7.2), links valid 24 h.
import { useQuery } from '@tanstack/react-query';
import { Archive, Download } from 'lucide-react';
import { formatBytes, formatDateTime } from '../../shared/format';
import { t } from '../../shared/strings.id';
import { clickLink, listArchives } from '../lib/files';

export function Downloads() {
  const q = useQuery({
    queryKey: ['archives'],
    queryFn: listArchives,
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running')
        ? 3000
        : false,
  });
  const jobs = q.data?.jobs ?? [];
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <header>
        <h1 className="text-xl font-semibold">{t.archive.pageTitle}</h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.archive.pageBody}</p>
      </header>
      {q.isSuccess && !jobs.length && (
        <p className="text-sm text-[var(--fg-muted)]">{t.archive.empty}</p>
      )}
      <ul className="divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--card)]">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center gap-3 p-4 text-sm">
            <Archive className="h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{j.name ?? j.id}</p>
              <p className="text-xs text-[var(--fg-muted)]">
                {j.status === 'done'
                  ? `${formatBytes(j.outBytes ?? 0)} · ${t.archive.ready}`
                  : j.status === 'failed'
                    ? t.archive.failed
                    : j.status === 'expired'
                      ? t.archive.expired
                      : t.archive.running(j.progress)}
                {' · '}
                {formatDateTime(j.createdAt)}
              </p>
            </div>
            {j.url && (
              <button
                type="button"
                onClick={() => clickLink(j.url!)}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-brand-700 hover:bg-[var(--bg-subtle)]"
              >
                <Download className="h-4 w-4" />
                {t.archive.download}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
