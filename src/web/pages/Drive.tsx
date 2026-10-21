// Explorer (SPEC §8): breadcrumb, grid/list, sort, selection, context menu, drag-drop upload,
// rename/copy/trash with undo, infinite scroll.
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  Copy,
  Download,
  FolderOpen,
  LayoutGrid,
  List,
  MoreVertical,
  Pencil,
  ShieldAlert,
  ShieldQuestion,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { formatBytes, formatDate } from '../../shared/format';
import { t } from '../../shared/strings.id';
import { FileIcon } from '../components/FileIcon';
import { PromptDialog } from '../components/ui/Dialog';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { toast } from '../components/ui/Toast';
import { ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { setCurrentFolder } from '../lib/explorer-store';
import {
  copyNode,
  downloadFile,
  filesKeys,
  listChildren,
  renameNode,
  restoreNodes,
  trashNodes,
  type NodeDto,
  type SortKey,
} from '../lib/files';
import { useMe } from '../lib/session';
import { fromDrop, resolveTargets } from '../upload/folders';
import { uploads } from '../upload/useUploads';

type View = 'list' | 'grid';

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

function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return t.errors.generic;
  if (e.code === 'NAME_CONFLICT') return t.errors.nameConflict;
  if (e.code === 'INVALID_NAME') return t.errors.invalidName;
  if (e.code === 'QUOTA_FULL') return t.errors.quotaFull;
  if (e.code === 'FORBIDDEN') return t.errors.forbidden;
  return t.errors.generic;
}

function StatusBadge({ node }: { node: NodeDto }) {
  if (node.status === 'scanning')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
        <ShieldQuestion className="h-3 w-3" aria-hidden="true" /> {t.files.scanning}
      </span>
    );
  if (node.status === 'rejected')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] text-red-700">
        <ShieldAlert className="h-3 w-3" aria-hidden="true" /> {t.files.rejected}
      </span>
    );
  if (node.scanStatus === 'skipped')
    return (
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700">
        {t.files.notFullyScanned}
      </span>
    );
  return null;
}

function Thumb({ node, big }: { node: NodeDto; big?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (node.hasThumb && !failed && node.status !== 'rejected') {
    return (
      <img
        src={`/api/files/${node.id}/thumbnail`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={big ? 'h-full w-full object-cover' : 'h-8 w-8 shrink-0 rounded object-cover'}
      />
    );
  }
  return <FileIcon node={node} className={big ? 'h-12 w-12' : 'h-5 w-5'} />;
}

export function Drive({ folderId }: { folderId?: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const id = folderId ?? me.data?.space.personalRootId ?? '';
  const [view, setView] = useState<View>(() => readPref<View>('zk.view', 'list'));
  const [sort, setSort] = useState<SortKey>(() => readPref<SortKey>('zk.sort', 'name'));
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [renaming, setRenaming] = useState<NodeDto | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointerType = useRef<string>('mouse');
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        : 30_000,
  });

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const path = q.data?.pages[0]?.path ?? [];
  const folder = q.data?.pages[0]?.folder;

  useEffect(() => {
    if (folder) setCurrentFolder({ id: folder.id, name: folder.name });
    return () => setCurrentFolder(null);
  }, [folder]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage)
        void q.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [q]);

  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: filesKeys.allChildren(id) }),
    [qc, id],
  );

  const open = useCallback(
    (node: NodeDto) => {
      if (node.kind === 'folder')
        void navigate({ to: '/drive/$folderId', params: { folderId: node.id } });
      else void downloadFile(node.id).catch((e) => toast(errorText(e), { tone: 'error' }));
    },
    [navigate],
  );

  const trash = useCallback(
    async (ids: string[]) => {
      // Optimistic removal + snackbar undo (SPEC §8.2).
      qc.setQueriesData<typeof q.data>({ queryKey: filesKeys.allChildren(id) }, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                items: p.items.filter((i) => !ids.includes(i.id)),
              })),
            }
          : old,
      );
      setSelected(new Set());
      try {
        await trashNodes(ids);
        toast(t.files.movedToTrash, {
          action: {
            label: t.common.undo,
            run: () => void restoreNodes(ids).then(refresh),
          },
        });
      } catch (e) {
        toast(errorText(e), { tone: 'error' });
      }
      void refresh();
    },
    [qc, id, refresh],
  );

  const menuItems = (ids: string[]): MenuItem[] => {
    const nodes = items.filter((i) => ids.includes(i.id));
    const single = nodes.length === 1 ? nodes[0]! : null;
    const list: MenuItem[] = [];
    if (single?.kind === 'folder')
      list.push({ label: t.files.open, icon: FolderOpen, onSelect: () => open(single) });
    if (single?.kind === 'file')
      list.push({
        label: t.common.download,
        icon: Download,
        disabled: single.status === 'rejected',
        onSelect: () => open(single),
      });
    if (single)
      list.push({ label: t.common.rename, icon: Pencil, onSelect: () => setRenaming(single) });
    if (single?.kind === 'file' && single.status === 'ready')
      list.push({
        label: t.files.makeCopy,
        icon: Copy,
        onSelect: () =>
          void copyNode(single.id)
            .then(() => {
              toast(t.files.copied);
              return refresh();
            })
            .catch((e) => toast(errorText(e), { tone: 'error' })),
      });
    list.push({
      label: t.files.moveToTrash,
      icon: Trash2,
      danger: true,
      onSelect: () => void trash(ids),
    });
    return list;
  };

  function select(e: MouseEvent, index: number, node: NodeDto) {
    if (pointerType.current === 'touch' && !selected.size) return open(node);
    if (e.ctrlKey || e.metaKey || (pointerType.current === 'touch' && selected.size)) {
      const next = new Set(selected);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      setSelected(next);
      setAnchor(index);
    } else if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(new Set(items.slice(a, b + 1).map((i) => i.id)));
    } else {
      setSelected(new Set([node.id]));
      setAnchor(index);
    }
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || renaming) return;
    const ids = [...selected];
    if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSelected(new Set(items.map((i) => i.id)));
    } else if (e.key === 'Escape') setSelected(new Set());
    else if (e.key === 'Delete' && ids.length) void trash(ids);
    else if (e.key === 'F2' && ids.length === 1) {
      e.preventDefault();
      const n = items.find((i) => i.id === ids[0]);
      if (n) setRenaming(n);
    } else if (e.key === 'Enter' && ids.length === 1) {
      const n = items.find((i) => i.id === ids[0]);
      if (n) open(n);
    } else if (e.key === 'ArrowUp' && e.altKey && path.length > 1) {
      const parent = path[path.length - 2]!;
      void navigate(
        parent.id === me.data?.space.personalRootId
          ? { to: '/drive' }
          : { to: '/drive/$folderId', params: { folderId: parent.id } },
      );
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
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

  const sortButton = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => {
        if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        else {
          setSort(key);
          setDir('asc');
          writePref('zk.sort', key);
        }
      }}
      className={cn(
        'rounded-full px-3 py-1 text-xs',
        sort === key ? 'bg-brand-100 text-brand-800' : 'hover:bg-[var(--bg-subtle)]',
      )}
      aria-pressed={sort === key}
    >
      {label}
      {sort === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );

  const itemProps = (node: NodeDto, index: number) => ({
    role: 'option' as const,
    'aria-selected': selected.has(node.id),
    tabIndex: 0,
    onPointerDown: (e: React.PointerEvent) => {
      pointerType.current = e.pointerType;
      if (e.pointerType === 'touch') {
        longPress.current = setTimeout(() => {
          setSelected((s) => new Set(s).add(node.id));
          longPress.current = null;
        }, 500);
      }
    },
    onPointerUp: () => longPress.current && clearTimeout(longPress.current),
    onClick: (e: MouseEvent) => select(e, index, node),
    onDoubleClick: () => open(node),
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      const ids = selected.has(node.id) ? [...selected] : [node.id];
      if (!selected.has(node.id)) setSelected(new Set([node.id]));
      setMenu({ x: e.clientX, y: e.clientY, ids });
    },
  });

  const kebab = (node: NodeDto) => (
    <button
      type="button"
      aria-label={`Aksi untuk ${node.name}`}
      className="rounded-full p-1.5 hover:bg-[var(--border)]"
      onClick={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setMenu({ x: r.left, y: r.bottom, ids: [node.id] });
      }}
    >
      <MoreVertical className="h-4 w-4" />
    </button>
  );

  return (
    <div
      className="relative flex min-h-full flex-col outline-none"
      tabIndex={-1}
      onKeyDown={onKey}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
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
              ) : (
                <Link
                  to={i === 0 ? '/drive' : '/drive/$folderId'}
                  params={i === 0 ? {} : { folderId: c.id }}
                  className="truncate rounded px-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
                >
                  {c.name}
                </Link>
              )}
            </span>
          ))}
        </nav>
        {selected.size > 0 ? (
          <div className="flex items-center gap-1 rounded-full bg-brand-50 px-2 py-1 text-sm text-brand-800">
            <button
              type="button"
              className="rounded-full p-1"
              onClick={() => setSelected(new Set())}
              aria-label={t.files.clearSelection}
            >
              <X className="h-4 w-4" />
            </button>
            <span className="px-1">{t.files.selected(selected.size)}</span>
            <button
              type="button"
              className="rounded-full p-1.5 hover:bg-brand-100"
              onClick={() => void trash([...selected])}
              aria-label={t.files.moveToTrash}
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded-full p-1.5 hover:bg-brand-100"
              aria-label="Aksi lain"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom, ids: [...selected] });
              }}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          </div>
        ) : (
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
            >
              {view === 'list' ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
            </button>
          </div>
        )}
      </div>

      {q.isPending && <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
      {q.isError && <p className="p-6 text-sm text-red-600">{errorText(q.error)}</p>}
      {q.isSuccess && items.length === 0 && (
        <p className="m-6 rounded-2xl border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--fg-muted)]">
          {t.files.emptyFolder}
        </p>
      )}

      {items.length > 0 && view === 'list' && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={folder?.name}
          className="px-2 py-1 md:px-4"
        >
          <div className="hidden grid-cols-[1fr_9rem_7rem_2.5rem] px-3 py-2 text-xs text-[var(--fg-muted)] md:grid">
            <span>{t.files.colName}</span>
            <span>{t.files.colModified}</span>
            <span>{t.files.colSize}</span>
            <span />
          </div>
          {items.map((node, i) => (
            <div
              key={node.id}
              {...itemProps(node, i)}
              className={cn(
                'grid cursor-default grid-cols-[1fr_2.5rem] items-center gap-2 rounded-xl px-3 py-2 select-none md:grid-cols-[1fr_9rem_7rem_2.5rem]',
                selected.has(node.id)
                  ? 'bg-brand-100 dark:bg-brand-800/40'
                  : 'hover:bg-[var(--bg-subtle)]',
              )}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Thumb node={node} />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{node.name}</span>
                  <span className="flex gap-2 text-xs text-[var(--fg-muted)] md:hidden">
                    {formatDate(node.updatedAt)}
                    {node.kind === 'file' && ` · ${formatBytes(node.size)}`}
                  </span>
                </span>
                <StatusBadge node={node} />
              </span>
              <span className="hidden text-xs text-[var(--fg-muted)] md:block">
                {formatDate(node.updatedAt)}
              </span>
              <span className="hidden text-xs text-[var(--fg-muted)] md:block">
                {node.kind === 'file' ? formatBytes(node.size) : '—'}
              </span>
              {kebab(node)}
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && view === 'grid' && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={folder?.name}
          className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
        >
          {items.map((node, i) => (
            <div
              key={node.id}
              {...itemProps(node, i)}
              className={cn(
                'flex cursor-default flex-col overflow-hidden rounded-2xl border select-none',
                selected.has(node.id)
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-800/30'
                  : 'border-[var(--border)] bg-[var(--card)] hover:bg-[var(--bg-subtle)]',
              )}
            >
              <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--bg-subtle)]">
                <Thumb node={node} big />
              </div>
              <div className="flex items-center gap-2 px-3 py-2">
                <FileIcon node={node} className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
                {kebab(node)}
              </div>
              <div className="px-3 pb-2">
                <StatusBadge node={node} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div ref={sentinel} className="h-8" />
      {q.isFetchingNextPage && (
        <p className="pb-4 text-center text-xs text-[var(--fg-muted)]">{t.common.loading}</p>
      )}

      {dragging && folder && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50/80 text-brand-800 dark:bg-brand-800/40 dark:text-brand-100">
          {t.upload.dropHere(folder.name)}
        </div>
      )}

      {menu && (
        <Menu x={menu.x} y={menu.y} items={menuItems(menu.ids)} onClose={() => setMenu(null)} />
      )}
      <PromptDialog
        open={Boolean(renaming)}
        title={t.files.renameTitle}
        initial={renaming?.name ?? ''}
        selectBase={renaming?.kind === 'file'}
        confirmLabel={t.common.save}
        onCancel={() => setRenaming(null)}
        onSubmit={async (name) => {
          const node = renaming!;
          setRenaming(null);
          if (name === node.name) return;
          try {
            await renameNode(node.id, name);
            toast(t.files.renamed);
            await refresh();
          } catch (e) {
            toast(errorText(e), { tone: 'error' });
          }
        }}
      />
    </div>
  );
}
