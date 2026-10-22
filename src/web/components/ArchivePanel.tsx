// Floating progress for async archive jobs (SPEC §7.2 "Progres job terlihat di panel unduhan").
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive, Download, X } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../shared/strings.id';
import { clickLink, listArchives, type ArchiveJob } from '../lib/files';

const RECENT_MS = 60 * 60_000;

export function ArchivePanel() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [openedAt] = useState(() => Date.now());
  const q = useQuery({
    queryKey: ['archives'],
    queryFn: listArchives,
    refetchInterval: (query) =>
      query.state.data?.jobs.some((j) => j.status === 'queued' || j.status === 'running')
        ? 3000
        : false,
  });
  const jobs = (q.data?.jobs ?? []).filter(
    (j: ArchiveJob) =>
      !dismissed.includes(j.id) &&
      (j.status === 'queued' || j.status === 'running' || j.createdAt > openedAt - RECENT_MS) &&
      j.status !== 'expired',
  );
  if (!jobs.length) return null;
  return (
    <section
      aria-label={t.archive.pageTitle}
      className="fixed bottom-4 left-4 z-30 w-72 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3 text-sm shadow-lg"
    >
      <header className="mb-2 flex items-center justify-between">
        <Link to="/unduhan" className="flex items-center gap-2 font-medium hover:underline">
          <Archive className="h-4 w-4 text-brand-600" />
          {t.archive.pageTitle}
        </Link>
        <button
          type="button"
          aria-label={t.common.close}
          onClick={() => setDismissed(jobs.map((j) => j.id))}
          className="rounded p-1 hover:bg-[var(--bg-subtle)]"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <ul className="space-y-2">
        {jobs.slice(0, 4).map((j) => (
          <li key={j.id}>
            <p className="truncate">{j.name ?? j.id}</p>
            {j.status === 'done' && j.url ? (
              <button
                type="button"
                onClick={() => clickLink(j.url!)}
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                <Download className="h-3.5 w-3.5" />
                {t.archive.download}
              </button>
            ) : j.status === 'failed' ? (
              <p className="text-xs text-red-700">{t.archive.failed}</p>
            ) : (
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--bg-subtle)]"
                role="progressbar"
                aria-valuenow={j.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t.archive.running(j.progress)}
              >
                <div
                  className="h-full bg-brand-500 transition-all"
                  style={{ width: `${Math.max(4, j.progress)}%` }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
