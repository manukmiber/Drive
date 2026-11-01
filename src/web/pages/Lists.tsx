// Cross-folder views: Cari, Terbaru, Berbintang, Dibagikan (SPEC §8.1, §6).
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Copy,
  FolderOpen,
  Link2Off,
  ListTree,
  Lock,
  QrCode,
  Search as SearchIcon,
  Settings2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { parseSearch } from '../../shared/search-query';
import { ContentSearchIntro } from '../components/ContentSearch';
import { Highlighted, highlightName, SearchFilters } from '../components/SearchFilters';
import { formatDateTime } from '../../shared/format';
import { t } from '../lib/i18n';
import { ActivityList } from '../components/ActivityList';
import { FileView } from '../components/explorer/FileView';
import { ShareQr } from '../components/explorer/ShareQr';
import { ShareSettings } from '../components/explorer/ShareSettings';
import { Dialog } from '../components/ui/Dialog';
import { errorText } from '../components/explorer/useNodeActions';
import { toast } from '../components/ui/Toast';
import { cn } from '../lib/cn';
import { Button } from '../components/Button';
import {
  listRecent,
  recentActivity,
  listShares,
  listStarred,
  revokeShare,
  searchPage,
  listFileRequests,
  sharedWithMe,
  type ShareDto,
} from '../lib/files';
import { FileRequestList } from '../components/explorer/FileRequestDialog';
import { useCatalog } from '../lib/catalog';

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
  const [tab, setTab] = useState<'files' | 'activity'>('files');
  const q = useQuery({ queryKey: ['recent'], queryFn: listRecent });
  const activity = useQuery({
    queryKey: ['activity'],
    queryFn: recentActivity,
    enabled: tab === 'activity',
  });
  useEffect(() => void (document.title = `${t.nav.recent} · Zeiko`), []);
  return (
    <div>
      <Header title={t.nav.recent}>
        <div role="tablist" className="flex gap-1 rounded-xl bg-[var(--bg-subtle)] p-1 text-sm">
          {(['files', 'activity'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                'rounded-lg px-3 py-1',
                tab === k ? 'bg-[var(--card)] font-medium shadow-sm' : 'text-[var(--fg-muted)]',
              )}
            >
              {k === 'files' ? t.activity.filesTab : t.activity.tab}
            </button>
          ))}
        </div>
      </Header>
      {tab === 'activity' ? (
        activity.isPending ? (
          <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
        ) : (
          <div className="mx-auto max-w-3xl px-4">
            <ActivityList items={activity.data?.items ?? []} />
          </div>
        )
      ) : q.isPending ? (
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
  const parsed = useMemo(() => parseSearch(query), [query]);
  const pages = useInfiniteQuery({
    queryKey: ['search', query, type],
    queryFn: ({ pageParam }) => searchPage(query, type, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: query.trim().length > 0,
  });
  useEffect(() => void (document.title = `${query} · Zeiko`), [query]);
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const snippets = Object.assign({}, ...(pages.data?.pages.map((p) => p.snippets) ?? [])) as Record<
    string,
    { text: string; ranges: Array<[number, number]> }
  >;
  const first = pages.data?.pages[0];
  const go = (q: string, ty: string | undefined) =>
    void navigate({ to: '/cari', search: { q, ...(ty ? { type: ty } : {}) } });
  return (
    <div>
      <Header title={t.files.searchResults(query)} />
      <div className="flex items-center gap-2 overflow-x-auto px-4 py-2">
        <SearchFilters q={query} onChange={(q) => go(q, type)} />
        {[undefined, ...TYPES].map((ty) => (
          <button
            key={ty ?? 'all'}
            type="button"
            onClick={() => go(query, ty)}
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
      {first && first.warnings.length > 0 && (
        <p className="px-4 pb-1 text-xs text-amber-700">
          {t.searchFilters.warnings(first.warnings.join(', '))}
        </p>
      )}
      {pages.isFetching && !pages.data ? (
        <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
      ) : (
        <FileView
          items={items}
          view="list"
          label={t.files.searchResults(query)}
          empty={emptyBox(t.files.noResults)}
          nameOf={(n) => highlightName(n.name, parsed)}
          extra={(n) =>
            snippets[n.id] ? (
              <span
                className="block truncate text-xs text-[var(--fg-muted)]"
                title={t.searchFilters.inContent}
              >
                <Highlighted text={snippets[n.id]!.text} ranges={snippets[n.id]!.ranges} />
              </span>
            ) : null
          }
        />
      )}
      {pages.hasNextPage && (
        <div className="flex justify-center p-4">
          <Button
            variant="ghost"
            disabled={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            {t.searchFilters.more}
          </Button>
        </div>
      )}
      <ContentSearchIntro off={first ? !first.contentSearch : false} />
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

/** D2 (ADR-085): what others shared straight to the person's account. */
export function SharedWithMe() {
  const q = useQuery({ queryKey: ['shared-with-me'], queryFn: sharedWithMe });
  useEffect(() => void (document.title = `${t.nav.sharedWithMe} · Zeiko`), []);
  return (
    <div>
      <Header title={t.nav.sharedWithMe} />
      <p className="px-4 pt-3 text-sm text-[var(--fg-muted)]">{t.people.pageHint}</p>
      {q.isPending ? (
        <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
      ) : (
        <FileView
          items={(q.data?.items ?? []).map((i) => i.node)}
          view="list"
          label={t.nav.sharedWithMe}
          empty={emptyBox(t.people.empty)}
        />
      )}
    </div>
  );
}

/** D3 (ADR-086): the person's file request links, on the Shared page. */
function RequestLinks() {
  const q = useQuery({ queryKey: ['file-requests', 'mine'], queryFn: () => listFileRequests() });
  if (!q.data?.items.length) return null;
  return (
    <section className="mx-auto max-w-3xl px-4 py-4" aria-labelledby="minta-semua">
      <h2 id="minta-semua" className="mb-1 text-sm font-medium">
        {t.requests.existing}
      </h2>
      <FileRequestList items={q.data.items} />
    </section>
  );
}

export function Shared() {
  const caps = useCatalog().data?.capabilities;
  const people = caps?.peopleShares === true;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['shares', 'mine'], queryFn: () => listShares() });
  const [showOld, setShowOld] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<ShareDto | null>(null);
  const [qrFor, setQrFor] = useState<ShareDto | null>(null);
  useEffect(() => void (document.title = `${t.nav.shared} · Zeiko`), []);
  const needle = query.trim().toLowerCase();
  const items = (q.data?.items ?? []).filter(
    (s) =>
      (showOld || shareStatus(s).label === t.share.statusActive) &&
      (!needle || s.title.toLowerCase().includes(needle)),
  );
  const refresh = () => qc.invalidateQueries({ queryKey: ['shares'] });
  const iconButton = 'rounded-full p-2 hover:bg-[var(--bg-subtle)]';
  return (
    <div>
      <Header title={t.nav.shared}>
        {people && (
          <Link
            to="/untuk-saya"
            className="inline-flex h-9 items-center rounded-full border border-[var(--border)] px-3 text-sm"
          >
            {t.nav.sharedWithMe}
          </Link>
        )}
        <label className="relative">
          <SearchIcon
            className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-[var(--fg-muted)]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.share.search}
            aria-label={t.share.search}
            className="h-9 w-44 rounded-full border border-[var(--border)] bg-transparent pr-3 pl-8 text-sm sm:w-56"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
          <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />{' '}
          {t.share.showOld}
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
                      aria-label={t.share.passwordProtected}
                    />
                  )}
                  {s.showListing && (
                    <ListTree
                      className="h-3 w-3 shrink-0 text-[var(--fg-muted)]"
                      aria-label={t.share.listingBadge}
                    />
                  )}
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${st.tone}`}>
                    {st.label}
                  </span>
                </p>
                <p className="text-xs text-[var(--fg-muted)]">
                  {t.share.downloads(s.downloadCount)}
                  {s.maxDownloads ? ` / ${s.maxDownloads}` : ''}
                  {s.lastDownloadAt
                    ? ` (${t.share.lastDownload(formatDateTime(s.lastDownloadAt))})`
                    : ''}{' '}
                  ·{' '}
                  {s.expiresAt ? t.share.expiresOn(formatDateTime(s.expiresAt)) : t.share.noExpiry}
                </p>
              </div>
              {s.nodeIds.length === 1 && (
                <Link
                  to="/drive/$folderId"
                  params={{ folderId: s.nodeIds[0]! }}
                  className={cn(iconButton, 'hidden sm:block')}
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
                    className={iconButton}
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
                    className={cn(iconButton, 'hidden sm:block')}
                    aria-label={t.share.qr}
                    title={t.share.qr}
                    onClick={() => setQrFor(s)}
                  >
                    <QrCode className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={t.share.manage}
                    title={t.share.manage}
                    onClick={() => setEditing(s)}
                  >
                    <Settings2 className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={cn(iconButton, 'text-red-600')}
                    aria-label={t.share.revoke}
                    title={t.share.revoke}
                    onClick={() =>
                      void revokeShare(s.id)
                        .then(() => {
                          toast(t.share.revoked);
                          return refresh();
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
      {editing && (
        <Dialog open title={t.share.manage} onClose={() => setEditing(null)}>
          <p className="mb-3 truncate text-[var(--fg-muted)]">{editing.title}</p>
          <ShareSettings
            key={editing.id}
            share={editing}
            onChange={(s) => {
              setEditing(s);
              void refresh();
            }}
            onRevoked={() => {
              setEditing(null);
              void refresh();
            }}
          />
        </Dialog>
      )}
      {qrFor && (
        <Dialog open title={t.share.qr} onClose={() => setQrFor(null)}>
          <ShareQr url={qrFor.url} title={qrFor.title} />
        </Dialog>
      )}
      {caps?.fileRequests && <RequestLinks />}
    </div>
  );
}
