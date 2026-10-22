// Drive Saya (SPEC §8): breadcrumb, sort, list/grid, infinite scroll, drag-drop upload, paste.
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, LayoutGrid, List, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { t } from '../../shared/strings.id';
import { AdCard } from '../components/AdCard';
import { FileView, type View } from '../components/explorer/FileView';
import { errorText } from '../components/explorer/useNodeActions';
import { toast } from '../components/ui/Toast';
import { cn } from '../lib/cn';
import { setCurrentFolder } from '../lib/explorer-store';
import { copyNode, filesKeys, listChildren, moveNodes, type SortKey } from '../lib/files';
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

  useEffect(() => {
    if (folder) setCurrentFolder({ id: folder.id, name: folder.name });
    return () => setCurrentFolder(null);
  }, [folder]);

  useEffect(() => {
    if (folder) document.title = `${folder.name} · Zeiko`;
  }, [folder]);

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
        'rounded-full px-3 py-1 text-xs',
        sort === key
          ? 'bg-brand-100 text-brand-800 dark:bg-brand-800/50 dark:text-brand-100'
          : 'hover:bg-[var(--bg-subtle)]',
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
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-4 py-2">
        <nav aria-label="Lokasi" className="flex min-w-0 flex-1 items-center gap-1 text-lg">
          {path.map((c, i) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-[var(--fg-muted)]"
                  aria-hidden="true"
                />
              )}
              {i === path.length - 1 ? (
                <span className="truncate font-medium">{c.name}</span>
              ) : i === 0 ? (
                <Link
                  to={c.id === me.data?.space.familyRootId ? '/keluarga' : '/drive'}
                  className="truncate rounded px-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                >
                  {c.name}
                </Link>
              ) : (
                <Link
                  to="/drive/$folderId"
                  params={{ folderId: c.id }}
                  className="truncate rounded px-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                >
                  {c.name}
                </Link>
              )}
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          {sortButton('name', t.files.sortName)}
          {sortButton('updated', t.files.sortDate)}
          {sortButton('size', t.files.sortSize)}
          <button
            type="button"
            onClick={() => {
              const v = view === 'list' ? 'grid' : 'list';
              setView(v);
              writePref('zk.view', v);
            }}
            className="ml-1 rounded-full p-2 hover:bg-[var(--bg-subtle)]"
            aria-label={view === 'list' ? t.files.gridView : t.files.listView}
            title={view === 'list' ? t.files.gridView : t.files.listView}
          >
            {view === 'list' ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {q.isPending && <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
      {q.isError && <p className="p-6 text-sm text-red-600">{errorText(q.error)}</p>}
      {q.isSuccess && (
        <FileView
          key={id}
          items={items}
          view={view}
          label={folder?.name ?? ''}
          onPaste={(clip) => void paste(clip)}
          empty={
            <div className="m-6 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--fg-muted)]">
              <UploadCloud className="h-10 w-10 text-brand-500" aria-hidden="true" />
              {t.files.emptyFolder}
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
          {t.upload.dropHere(folder.name)}
        </div>
      )}
    </div>
  );
}
