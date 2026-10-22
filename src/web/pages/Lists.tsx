// Cross-folder views: Cari, Terbaru, Berbintang, Dibagikan (SPEC §8.1, §6).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Copy, FolderOpen, Link2Off, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDateTime } from '../../shared/format';
import { t } from '../lib/i18n';
import { FileView } from '../components/explorer/FileView';
import { errorText } from '../components/explorer/useNodeActions';
import { toast } from '../components/ui/Toast';
import { cn } from '../lib/cn';
import {
  listRecent,
  listShares,
  listStarred,
  revokeShare,
  searchNodes,
  type ShareDto,
} from '../lib/files';

function Header({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-3">
      <h1 className="flex-1 text-lg font-medium">{title}</h1>
      {children}
    </div>
  );
}

const emptyBox = (text: string) => (
  <p className="m-6 rounded-2xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--fg-muted)]">
    {text}
  </p>
);

export function Recent() {
  const q = useQuery({ queryKey: ['recent'], queryFn: listRecent });
  useEffect(() => void (document.title = `${t.nav.recent} · Zeiko`), []);
  return (
    <div>
      <Header title={t.nav.recent} />
      {q.isPending ? (
        <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
      ) : (
        <FileView
          items={q.data?.items ?? []}
          view="list"
          label={t.nav.recent}
          empty={emptyBox(t.files.emptyRecent)}
        />
      )}
    </div>
  );
}

export function Starred() {
  const q = useQuery({ queryKey: ['starred'], queryFn: listStarred });
  useEffect(() => void (document.title = `${t.nav.starred} · Zeiko`), []);
  return (
    <div>
      <Header title={t.nav.starred} />
      {q.isPending ? (
        <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
      ) : (
        <FileView
          items={q.data?.items ?? []}
          view="list"
          label={t.nav.starred}
          empty={emptyBox(t.files.emptyStarred)}
        />
      )}
    </div>
  );
}

const TYPES = ['folder', 'image', 'video', 'audio', 'document', 'pdf', 'archive'];

export function Search({ q: query, type }: { q: string; type?: string | undefined }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['search', query, type],
    queryFn: () => searchNodes(query, type),
    enabled: query.trim().length > 0,
  });
  useEffect(() => void (document.title = `${query} · Zeiko`), [query]);
  return (
    <div>
      <Header title={t.files.searchResults(query)} />
      <div className="flex gap-2 overflow-x-auto px-4 py-2">
        {[undefined, ...TYPES].map((ty) => (
          <button
            key={ty ?? 'all'}
            type="button"
            onClick={() =>
              void navigate({ to: '/cari', search: { q: query, ...(ty ? { type: ty } : {}) } })
            }
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs',
              type === ty
                ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-800/40 dark:text-brand-100'
                : 'border-[var(--border)] hover:bg-[var(--bg-subtle)]',
            )}
          >
            {ty ? t.files.filterTypes[ty] : t.files.filterAll}
          </button>
        ))}
      </div>
      {q.isFetching && !q.data ? (
        <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
      ) : (
        <FileView
          items={q.data?.items ?? []}
          view="list"
          label={t.files.searchResults(query)}
          empty={emptyBox(t.files.noResults)}
        />
      )}
    </div>
  );
}

function shareStatus(s: ShareDto): { label: string; tone: string } {
  if (s.revokedAt) return { label: t.share.statusRevoked, tone: 'bg-gray-100 text-gray-700' };
  if (s.disabledReason) return { label: t.share.statusDisabled, tone: 'bg-red-100 text-red-700' };
  if (s.expiresAt && s.expiresAt < Date.now())
    return { label: t.share.statusExpired, tone: 'bg-gray-100 text-gray-700' };
  return { label: t.share.statusActive, tone: 'bg-green-100 text-green-800' };
}

export function Shared() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['shares', 'mine'], queryFn: () => listShares() });
  const [showOld, setShowOld] = useState(false);
  useEffect(() => void (document.title = `${t.nav.shared} · Zeiko`), []);
  const items = (q.data?.items ?? []).filter(
    (s) => showOld || shareStatus(s).label === t.share.statusActive,
  );
  return (
    <div>
      <Header title={t.nav.shared}>
        <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
          <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />{' '}
          Tampilkan link lama
        </label>
      </Header>
      {q.isPending && <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
      {q.isSuccess && !items.length && emptyBox(t.share.sharedEmpty)}
      <ul className="divide-y divide-[var(--border)] px-2 md:px-4">
        {items.map((s) => {
          const st = shareStatus(s);
          const active = st.label === t.share.statusActive;
          return (
            <li key={s.id} className="flex items-center gap-3 px-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate text-sm">
                  {s.title}
                  {s.hasPassword && (
                    <Lock
                      className="h-3 w-3 shrink-0 text-[var(--fg-muted)]"
                      aria-label={t.a11y.usePassword}
                    />
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${st.tone}`}>
                    {st.label}
                  </span>
                </p>
                <p className="text-xs text-[var(--fg-muted)]">
                  {t.share.downloads(s.downloadCount)}
                  {s.maxDownloads ? ` / ${s.maxDownloads}` : ''} ·{' '}
                  {s.expiresAt ? t.share.expiresOn(formatDateTime(s.expiresAt)) : t.share.noExpiry}
                </p>
              </div>
              {s.nodeIds.length === 1 && (
                <Link
                  to="/drive/$folderId"
                  params={{ folderId: s.nodeIds[0]! }}
                  className="hidden rounded-full p-2 hover:bg-[var(--bg-subtle)] sm:block"
                  aria-label={t.files.open}
                  title={t.files.open}
                  disabled={s.kind !== 'folder'}
                >
                  <FolderOpen className={cn('h-4 w-4', s.kind !== 'folder' && 'opacity-30')} />
                </Link>
              )}
              {active && (
                <>
                  <button
                    type="button"
                    className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
                    aria-label={t.share.copyLink}
                    title={t.share.copyLink}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(s.url)
                        .then(() => toast(t.share.linkCopied))
                    }
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className="rounded-full p-2 text-red-600 hover:bg-[var(--bg-subtle)]"
                    aria-label={t.share.revoke}
                    title={t.share.revoke}
                    onClick={() =>
                      void revokeShare(s.id)
                        .then(() => {
                          toast(t.share.revoked);
                          return qc.invalidateQueries({ queryKey: ['shares'] });
                        })
                        .catch((e) => toast(errorText(e), { tone: 'error' }))
                    }
                  >
                    <Link2Off className="h-4 w-4" />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
