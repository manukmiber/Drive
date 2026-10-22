// Notification bell in the header (SPEC §13.2).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell as BellIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime } from '../../shared/format';
import { t } from '../lib/i18n';
import { api, postJson } from '../lib/api';
import { cn } from '../lib/cn';

interface Item {
  id: string;
  type: string;
  title: string;
  body: string;
  url: string | null;
  readAt: number | null;
  createdAt: number;
}

export function Bell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ unread: number; items: Item[] }>('/api/notifications'),
    refetchInterval: 60_000,
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const unread = q.data?.unread ?? 0;
  const readAll = () =>
    void postJson('/api/notifications/read', { ids: 'all' }).then(() =>
      qc.invalidateQueries({ queryKey: ['notifications'] }),
    );
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="relative flex h-9 w-9 items-center justify-center rounded-full hover:bg-[var(--bg-subtle)]"
        aria-label={unread ? `${t.nav.notifications} (${unread} baru)` : t.nav.notifications}
        aria-expanded={open}
      >
        <BellIcon className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(92vw,22rem)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
            <p className="text-sm font-medium">{t.nav.notifications}</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={readAll}
                className="text-xs text-brand-700 hover:underline dark:text-brand-100"
              >
                {t.notifications.readAll}
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-auto">
            {(q.data?.items ?? []).map((n) => (
              <li
                key={n.id}
                className={cn(
                  'border-b border-[var(--border)] px-4 py-3 last:border-0',
                  !n.readAt && 'bg-brand-50/60 dark:bg-brand-800/20',
                )}
              >
                <a
                  href={n.url ?? '#'}
                  onClick={() =>
                    void postJson('/api/notifications/read', { ids: [n.id] }).then(() =>
                      qc.invalidateQueries({ queryKey: ['notifications'] }),
                    )
                  }
                  className="block"
                >
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.body && (
                    <p className="line-clamp-2 text-xs text-[var(--fg-muted)]">{n.body}</p>
                  )}
                  <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
                    {formatDateTime(n.createdAt)}
                  </p>
                </a>
              </li>
            ))}
            {q.isSuccess && !q.data.items.length && (
              <li className="px-4 py-6 text-center text-sm text-[var(--fg-muted)]">
                {t.notifications.empty}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
