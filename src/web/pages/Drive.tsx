// Drive Saya (SPEC §8): breadcrumb, sort, list/grid, infinite scroll, drag-drop upload, paste.
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, LayoutGrid, List, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { t } from '../lib/i18n';
import { AdCard } from '../components/AdCard';
import { FileView, type View } from '../components/explorer/FileView';
import { decorVars, FolderGlyph } from '../components/FolderGlyph';
import { errorText } from '../components/explorer/useNodeActions';
import { toast } from '../components/ui/Toast';
import { cn } from '../lib/cn';
import { setCurrentFolder } from '../lib/explorer-store';
import {
  copyNode,
  filesKeys,
  listChildren,
  moveNodes,
  type NodeDto,
  type SortKey,
} from '../lib/files';
import { useMe } from '../lib/session';
import { fromDrop, resolveTargets } from '../upload/folders';
import { takeSharedFiles, toTargets } from '../upload/share-target';
import { uploads } from '../upload/useUploads';

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The open folder's decoration as a thin band under the toolbar (ADR-058): its cover when this
 * viewer may see it, else its colour and icon. A cover that will not load falls back the same way.
 */
function FolderBanner({ decor, name }: { decor: NonNullable<NodeDto['decor']>; name: string }) {
  const [broken, setBroken] = useState(false);
  if (decor.coverId && !broken)
    return (
      <div className="mx-4 mt-3 h-20 overflow-hidden rounded-2xl bg-[var(--bg-subtle)] md:mx-6 md:h-28">
        <img
          src={`/api/files/${decor.coverId}/thumbnail`}
          alt=""
          onError={() => setBroken(true)}
          className="h-full w-full object-cover"
        />
      </div>
    );
  return (
    <div
      className={cn(
        'mx-4 mt-3 flex h-10 items-center gap-2 rounded-2xl px-4 text-sm font-medium md:mx-6',
        decor.color ? 'decor-band' : 'bg-[var(--bg-subtle)]',
      )}
      style={decorVars(decor.color)}
    >
      <FolderGlyph color={decor.color} icon={decor.icon} className="h-5 w-5" />
      <span className="truncate">{name}</span>
    </div>
  );
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked — preference just isn't remembered
  }
}

export function Drive({ folderId }: { folderId?: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const rootId = me.data?.space.personalRootId ?? '';
  const id = folderId ?? rootId;
  const [view, setView] = useState<View>(() => readPref<View>('zk.view', 'list'));
  const [sort, setSort] = useState<SortKey>(() => readPref<SortKey>('zk.sort', 'name'));
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const q = useInfiniteQuery({
    queryKey: filesKeys.children(id, sort, dir),
    queryFn: ({ pageParam }) => listChildren(id, sort, dir, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) => p.items.some((i) => i.status === 'scanning'))
        ? 4000
        : 60_000,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const path = q.data?.pages[0]?.path ?? [];
  const folder = q.data?.pages[0]?.folder;
  // The two roots are named when the space is made, in the language of that moment; show them
  // in the language the app is in now.
  const space = me.data?.space;
  const nameOf = (f: { id: string; name: string }) =>
    f.id === space?.personalRootId
      ? t.nav.myDrive
      : f.id === space?.familyRootId
        ? t.nav.familyDrive
        : f.name;
  const folderName = folder ? nameOf(folder) : '';

  useEffect(() => {
    if (folder) setCurrentFolder({ id: folder.id, name: folderName });
    return () => setCurrentFolder(null);
  }, [folder, folderName]);

  useEffect(() => {
    if (folder) document.title = `${folderName} · Zeiko`;
  }, [folder, folderName]);

  // Files shared into the installed PWA from other apps (Web Share Target) → Drive Saya.
  useEffect(() => {
    if (!rootId || !new URLSearchParams(location.search).has('shared')) return;
    history.replaceState(null, '', location.pathname);
    void takeSharedFiles()
      .then((files) => (files.length ? uploads().add(toTargets(files, rootId)) : undefined))
      .catch(() => undefined);
  }, [rootId]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['children'] });

  async function onDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!e.dataTransfer.types.includes('Files') || !folder) return;
    try {
      const picked = await fromDrop(e.dataTransfer);
      await uploads().add(await resolveTargets(folder.id, picked));
      void refresh();
    } catch (err) {
      toast(errorText(err), { tone: 'error' });
    }
  }

  async function paste(clip: { ids: string[]; cut: boolean }) {
    if (!folder) return;
    try {
      if (clip.cut) await moveNodes(clip.ids, folder.id);
      else for (const nodeId of clip.ids) await copyNode(nodeId, folder.id);
      toast(t.files.pasted(clip.ids.length));
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
    void refresh();
  }

  const sortButton = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => {
        if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        else {
          setSort(key);
          setDir(key === 'name' ? 'asc' : 'desc');
          writePref('zk.sort', key);
        }
      }}
      className={cn(
        'rounded-lg px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-colors sm:px-3',
        sort === key
          ? 'bg-[var(--card)] text-[var(--fg)] shadow-sm ring-1 ring-[var(--border)]'
          : 'text-[var(--fg-muted)] hover:text-[var(--fg)]',
      )}
      aria-pressed={sort === key}
    >
      {label}
      {sort === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );

  return (
    <div
      className="relative flex min-h-full flex-col"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="z-glass sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2 md:px-6">
        <nav
          aria-label={t.a11y.location}
          className="flex min-w-0 flex-1 items-center gap-1 text-lg"
        >
          {path.map((c, i) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-[var(--fg-muted)]"
                  aria-hidden="true"
                />
              )}
              {i === path.length - 1 ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && (c.color || c.icon) && (
                    <FolderGlyph
                      color={c.color}
                      icon={c.icon}
                      className="hidden h-5 w-5 md:block"
                    />
                  )}
                  <span className="truncate font-semibold tracking-tight">{nameOf(c)}</span>
                </span>
              ) : i === 0 ? (
                <Link
                  to={c.id === me.data?.space.familyRootId ? '/keluarga' : '/drive'}
                  className="truncate rounded-md px-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
                >
                  {nameOf(c)}
                </Link>
              ) : (
                <Link
                  to="/drive/$folderId"
                  params={{ folderId: c.id }}
                  className="flex min-w-0 items-center gap-1 rounded px-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                >
                  {(c.color || c.icon) && (
                    <FolderGlyph
                      color={c.color}
                      icon={c.icon}
                      className="hidden h-4 w-4 md:block"
                    />
                  )}
                  <span className="truncate">{c.name}</span>
                </Link>
              )}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] p-0.5">
            {sortButton('name', t.files.sortName)}
            {sortButton('updated', t.files.sortDate)}
            {sortButton('size', t.files.sortSize)}
          </div>
          <button
            type="button"
            onClick={() => {
              const v = view === 'list' ? 'grid' : 'list';
              setView(v);
              writePref('zk.view', v);
            }}
            className="rounded-xl border border-[var(--border)] p-2 text-[var(--fg-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
            aria-label={view === 'list' ? t.files.gridView : t.files.listView}
            title={view === 'list' ? t.files.gridView : t.files.listView}
          >
            {view === 'list' ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {folder?.decor && folder.parentId && (
        <FolderBanner key={folder.id} decor={folder.decor} name={folderName} />
      )}

      {q.isPending && <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
      {q.isError && <p className="p-6 text-sm text-red-600">{errorText(q.error)}</p>}
      {q.isSuccess && (
        <FileView
          key={id}
          items={items}
          view={view}
          label={folderName}
          onPaste={(clip) => void paste(clip)}
          empty={
            <div className="m-4 flex flex-col items-center gap-4 rounded-3xl border border-dashed border-[var(--border-strong)] px-6 py-14 text-center text-sm text-[var(--fg-muted)] [background:radial-gradient(60%_80%_at_50%_0%,var(--glow),transparent_70%)] md:m-6">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-teal-500 text-white shadow-[0_14px_30px_-12px_rgba(79,70,229,0.6)]">
                <UploadCloud className="h-8 w-8" aria-hidden="true" />
              </span>
              <span className="max-w-sm">{t.files.emptyFolder}</span>
            </div>
          }
        />
      )}

      <div ref={sentinel} className="h-8" />
      {isFetchingNextPage && (
        <p className="pb-4 text-center text-xs text-[var(--fg-muted)]">{t.common.loading}</p>
      )}
      {/* Phones: the one ad sits after the last file (desktop shows it in the sidebar). */}
      {q.isSuccess && !hasNextPage && (
        <AdCard placement="explorer_sidebar" className="mx-4 mb-4 md:hidden" />
      )}

      {dragging && folder && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50/80 text-brand-800 dark:bg-brand-800/40 dark:text-brand-100">
          {t.upload.dropHere(folderName)}
        </div>
      )}
    </div>
  );
}
