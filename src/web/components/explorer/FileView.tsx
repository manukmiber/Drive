// List/grid of nodes with Drive-like selection (click, Ctrl/⌘, Shift, long-press), context menu,
// kebab menu and keyboard shortcuts. Used by Drive, Cari, Terbaru, Berbintang.
import {
  Download,
  MoreVertical,
  Share2,
  ShieldAlert,
  ShieldQuestion,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import {
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { formatBytes, formatDate } from '../../../shared/format';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { type NodeDto } from '../../lib/files';
import { ArchiveDialog } from './ArchiveDialog';
import { FileIcon } from '../FileIcon';
import { Menu } from '../ui/Menu';
import { toast } from '../ui/Toast';
import { useNodeActions } from './useNodeActions';

export type View = 'list' | 'grid';

export function StatusBadge({ node }: { node: NodeDto }) {
  if (node.status === 'scanning')
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800">
        <ShieldQuestion className="h-3 w-3" aria-hidden="true" /> {t.files.scanning}
      </span>
    );
  if (node.status === 'rejected')
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] text-red-700">
        <ShieldAlert className="h-3 w-3" aria-hidden="true" /> {t.files.rejected}
      </span>
    );
  return null;
}

function Thumb({ node, big }: { node: NodeDto; big?: boolean }) {
  const [failed, setFailed] = useState(false);
  // A folder's cover is another file's thumbnail (ADR-058).
  const src = node.kind === 'folder' ? node.decor?.coverId : node.hasThumb ? node.id : null;
  if (src && !failed && node.status !== 'rejected') {
    return (
      <img
        src={`/api/files/${src}/thumbnail`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={big ? 'h-full w-full object-cover' : 'h-8 w-8 shrink-0 rounded object-cover'}
      />
    );
  }
  return <FileIcon node={node} className={big ? 'h-12 w-12' : 'h-5 w-5'} />;
}

export interface FileViewProps {
  items: NodeDto[];
  view: View;
  label: string;
  /** Extra column text under the name (e.g. folder path in search results). */
  subtitle?: (n: NodeDto) => string | null;
  empty?: ReactNode;
  /** Ctrl+V target (Drive only). */
  onPaste?: (clip: { ids: string[]; cut: boolean }) => void;
}

// App-wide "clipboard" for Ctrl+C / Ctrl+X → Ctrl+V between folders.
let clipboard: { ids: string[]; cut: boolean } | null = null;
const setClipboard = (v: typeof clipboard) => {
  clipboard = v;
};

export function FileView({ items, view, label, subtitle, empty, onPaste }: FileViewProps) {
  const actions = useNodeActions(items);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const pointer = useRef('mouse');
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);

  // Drop selections that disappeared (trashed, moved, navigated away).
  const visible = new Set(items.map((i) => i.id));
  const sel = [...selected].filter((id) => visible.has(id));

  function select(e: MouseEvent, index: number, node: NodeDto) {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    const touch = pointer.current === 'touch';
    if (touch && !sel.length) return actions.open(node);
    if (e.ctrlKey || e.metaKey || (touch && sel.length)) {
      const next = new Set(sel);
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

  const [archiving, setArchiving] = useState<string[] | null>(null);
  const zip = (ids: string[]) => setArchiving(ids);

  const menuItems = (ids: string[]) => {
    const list = actions.menuFor(ids);
    const nodes = items.filter((i) => ids.includes(i.id));
    if (nodes.length > 1 || nodes.some((n) => n.kind === 'folder')) {
      list.splice(1, 0, { label: t.files.downloadZip, icon: Download, onSelect: () => zip(ids) });
    }
    return list;
  };

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, dialog')) return;
    const mod = e.ctrlKey || e.metaKey;
    const one = sel.length === 1 ? items.find((i) => i.id === sel[0]) : undefined;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setSelected(new Set(items.map((i) => i.id)));
    } else if (e.key === 'Escape') setSelected(new Set());
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
      e.preventDefault();
      void actions.trash(sel);
    } else if (e.key === 'F2' && one) {
      e.preventDefault();
      actions.setRenaming(one);
    } else if (e.key === 'Enter' && one) actions.open(one);
    else if (mod && (e.key === 'c' || e.key === 'x') && sel.length) {
      setClipboard({ ids: sel, cut: e.key === 'x' });
      toast(
        e.key === 'x' ? t.files.cutToClipboard(sel.length) : t.files.copiedToClipboard(sel.length),
      );
    } else if (mod && e.key === 'v' && clipboard && onPaste) {
      onPaste(clipboard);
      if (clipboard.cut) setClipboard(null);
    } else if (
      (e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowLeft') &&
      items.length
    ) {
      const step =
        view === 'grid' && (e.key === 'ArrowDown' || e.key === 'ArrowUp') ? gridColumns() : 1;
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      if (view === 'list' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      const cur = anchor ?? -1;
      const next = Math.max(0, Math.min(items.length - 1, cur + dir * step));
      setAnchor(next);
      setSelected(new Set([items[next]!.id]));
      document.getElementById(`node-${items[next]!.id}`)?.focus();
    }
  }

  const itemProps = (node: NodeDto, index: number) => ({
    id: `node-${node.id}`,
    role: 'option' as const,
    'aria-selected': sel.includes(node.id),
    tabIndex: 0,
    onPointerDown: (e: PointerEvent) => {
      pointer.current = e.pointerType;
      if (e.pointerType === 'touch') {
        longPress.current = setTimeout(() => {
          longPressed.current = true;
          setSelected((s) => new Set(s).add(node.id));
          navigator.vibrate?.(20);
        }, 450);
      }
    },
    onPointerUp: () => longPress.current && clearTimeout(longPress.current),
    onPointerMove: () => longPress.current && clearTimeout(longPress.current),
    onClick: (e: MouseEvent) => select(e, index, node),
    onDoubleClick: () => actions.open(node),
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      const ids = sel.includes(node.id) ? sel : [node.id];
      if (!sel.includes(node.id)) setSelected(new Set([node.id]));
      setMenu({ x: e.clientX, y: e.clientY, ids });
    },
  });

  const kebab = (node: NodeDto) => (
    <button
      type="button"
      aria-label={t.a11y.actionsFor(node.name)}
      className="shrink-0 rounded-full p-1.5 hover:bg-[var(--border)]"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu({ x: r.left, y: r.bottom, ids: [node.id] });
      }}
    >
      <MoreVertical className="h-4 w-4" />
    </button>
  );

  return (
    <div onKeyDown={onKey} className="outline-none">
      {sel.length > 0 && (
        <div className="sticky top-[57px] z-10 mx-2 mb-1 flex items-center gap-1 rounded-full bg-brand-50 px-2 py-1 text-sm text-brand-800 md:mx-4 dark:bg-brand-800/40 dark:text-brand-100">
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-brand-100 dark:hover:bg-brand-800"
            onClick={() => setSelected(new Set())}
            aria-label={t.files.clearSelection}
          >
            <X className="h-4 w-4" />
          </button>
          <span className="flex-1 px-1">{t.files.selected(sel.length)}</span>
          <button
            type="button"
            className="rounded-full p-2 hover:bg-brand-100 dark:hover:bg-brand-800"
            onClick={() =>
              sel.length === 1 && items.find((i) => i.id === sel[0])?.kind === 'file'
                ? actions.open(items.find((i) => i.id === sel[0])!)
                : zip(sel)
            }
            aria-label={t.common.download}
            title={t.common.download}
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-full p-2 hover:bg-brand-100 dark:hover:bg-brand-800"
            onClick={() => setMenu({ x: window.innerWidth / 2, y: 120, ids: sel })}
            aria-label={t.common.share}
            title={t.common.share}
          >
            <Share2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-full p-2 hover:bg-brand-100 dark:hover:bg-brand-800"
            onClick={() => void actions.trash(sel)}
            aria-label={t.files.moveToTrash}
            title={t.files.moveToTrash}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded-full p-2 hover:bg-brand-100 dark:hover:bg-brand-800"
            aria-label={t.a11y.moreActions}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom, ids: sel });
            }}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </div>
      )}

      {items.length === 0 && empty}

      {items.length > 0 && view === 'list' && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
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
                'grid cursor-default grid-cols-[1fr_2.5rem] items-center gap-2 rounded-xl px-3 py-2 outline-none select-none focus-visible:ring-2 focus-visible:ring-brand-500 md:grid-cols-[1fr_9rem_7rem_2.5rem]',
                sel.includes(node.id)
                  ? 'bg-brand-100 dark:bg-brand-800/40'
                  : 'hover:bg-[var(--bg-subtle)]',
              )}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Thumb node={node} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm">{node.name}</span>
                    {node.starred && (
                      <Star
                        className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400"
                        aria-label={t.files.star}
                      />
                    )}
                  </span>
                  <span className="block truncate text-xs text-[var(--fg-muted)] md:hidden">
                    {formatDate(node.updatedAt)}
                    {node.kind === 'file' && ` · ${formatBytes(node.size)}`}
                  </span>
                  {subtitle?.(node) && (
                    <span className="hidden truncate text-xs text-[var(--fg-muted)] md:block">
                      {subtitle(node)}
                    </span>
                  )}
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
          aria-label={label}
          data-grid
          className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
        >
          {items.map((node, i) => (
            <div
              key={node.id}
              {...itemProps(node, i)}
              className={cn(
                'flex cursor-default flex-col overflow-hidden rounded-2xl border outline-none select-none focus-visible:ring-2 focus-visible:ring-brand-500',
                sel.includes(node.id)
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-800/30'
                  : 'z-card transition-[transform,border-color] hover:-translate-y-0.5 hover:border-[var(--border-strong)]',
              )}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <FileIcon node={node} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
                {kebab(node)}
              </div>
              {node.kind === 'file' && (
                <div className="mx-2 mb-2 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-[var(--bg-subtle)]">
                  <Thumb node={node} big />
                </div>
              )}
              {node.kind === 'folder' && node.decor?.coverId && (
                <div className="mx-2 mb-2 flex aspect-[3/1] items-center justify-center overflow-hidden rounded-xl bg-[var(--bg-subtle)]">
                  <Thumb node={node} big />
                </div>
              )}
              {node.status !== 'ready' && (
                <div className="px-3 pb-2">
                  <StatusBadge node={node} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {menu && (
        <Menu x={menu.x} y={menu.y} items={menuItems(menu.ids)} onClose={() => setMenu(null)} />
      )}
      {actions.ui}
      {archiving && <ArchiveDialog ids={archiving} onClose={() => setArchiving(null)} />}
    </div>
  );
}

function gridColumns(): number {
  const grid = document.querySelector('[data-grid]');
  if (!grid) return 1;
  return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
}
