// List/grid of nodes with Drive-like selection (click, Ctrl/⌘, Shift, long-press), context menu,
// kebab menu and keyboard shortcuts. Used by Drive, Cari, Terbaru, Berbintang.
import {
  Clock,
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
import { FileIcon, TypeTile } from '../FileIcon';
import { Menu } from '../ui/Menu';
import { toast } from '../ui/Toast';
import { useNodeActions } from './useNodeActions';

export type View = 'list' | 'grid';

/** An icon button on the selection bar: a 44px square, the bar's ink. */
const selBtn =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--hover)] active:bg-[var(--surface)]';

export function StatusBadge({ node }: { node: NodeDto }) {
  if (node.status === 'scanning')
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--warn-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--warn)]">
        <ShieldQuestion className="h-3 w-3" aria-hidden="true" /> {t.files.scanning}
      </span>
    );
  if (node.status === 'rejected')
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--err-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--err)]">
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
        width={big ? 320 : 40}
        height={big ? 240 : 40}
        className={
          big
            ? 'h-full w-full object-cover'
            : 'h-10 w-10 shrink-0 rounded-lg border border-[var(--line)] object-cover'
        }
      />
    );
  }
  return <TypeTile node={node} size={big ? 'lg' : 'md'} />;
}

export interface FileViewProps {
  items: NodeDto[];
  view: View;
  label: string;
  /** Extra column text under the name (e.g. folder path in search results). */
  subtitle?: (n: NodeDto) => string | null;
  /** D6: how a name is drawn (search marks the words it matched). */
  nameOf?: (n: NodeDto) => ReactNode;
  /** D6: a line under the name in the list (where the words are inside the file). */
  extra?: (n: NodeDto) => ReactNode;
  empty?: ReactNode;
  /** Ctrl+V target (Drive only). */
  onPaste?: (clip: { ids: string[]; cut: boolean }) => void;
}

// App-wide "clipboard" for Ctrl+C / Ctrl+X → Ctrl+V between folders.
let clipboard: { ids: string[]; cut: boolean } | null = null;
const setClipboard = (v: typeof clipboard) => {
  clipboard = v;
};

export function FileView({
  items,
  view,
  label,
  subtitle,
  nameOf,
  extra,
  empty,
  onPaste,
}: FileViewProps) {
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
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu({ x: r.left, y: r.bottom, ids: [node.id] });
      }}
    >
      <MoreVertical className="h-4 w-4" aria-hidden="true" />
    </button>
  );

  return (
    <div onKeyDown={onKey} className="outline-none">
      {sel.length > 0 && (
        // Over the app's header, not in the list: a bar that pushed the rows down after the first
        // click made a double-click open the row above.
        <div
          role="toolbar"
          aria-label={t.files.selected(sel.length)}
          className="fixed inset-x-0 top-0 z-30 flex h-16 items-center gap-0.5 border-b border-[var(--line-strong)] bg-[var(--select)] px-2 text-sm font-semibold text-[var(--ink)] md:left-64 md:px-4"
        >
          <button
            type="button"
            className={selBtn}
            onClick={() => setSelected(new Set())}
            aria-label={t.files.clearSelection}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="flex-1 px-1">{t.files.selected(sel.length)}</span>
          <button
            type="button"
            className={selBtn}
            onClick={() =>
              sel.length === 1 && items.find((i) => i.id === sel[0])?.kind === 'file'
                ? actions.open(items.find((i) => i.id === sel[0])!)
                : zip(sel)
            }
            aria-label={t.common.download}
            title={t.common.download}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={selBtn}
            onClick={() => setMenu({ x: window.innerWidth / 2, y: 120, ids: sel })}
            aria-label={t.common.share}
            title={t.common.share}
          >
            <Share2 className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={selBtn}
            onClick={() => void actions.trash(sel)}
            aria-label={t.files.moveToTrash}
            title={t.files.moveToTrash}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={selBtn}
            aria-label={t.a11y.moreActions}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom, ids: sel });
            }}
          >
            <MoreVertical className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {items.length === 0 && empty}

      {items.length > 0 && view === 'list' && (
        // Plain rows divided by rules, like Zeiko's price lists: a tile, the name, then when and
        // how big on wide screens (under the name on phones).
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="px-2 pb-2 md:px-4"
        >
          <div className="hidden grid-cols-[1fr_10rem_6.5rem_2.5rem] gap-3 border-b border-[var(--line)] px-3 pt-3 pb-2 text-xs font-semibold text-[var(--muted)] md:grid">
            <span>{t.files.colName}</span>
            <span>{t.files.colModified}</span>
            <span className="text-right">{t.files.colSize}</span>
            <span />
          </div>
          {items.map((node, i) => (
            <div
              key={node.id}
              {...itemProps(node, i)}
              className={cn(
                'grid min-h-14 cursor-default grid-cols-[1fr_2.5rem] items-center gap-3 border-b border-[var(--line)] px-3 py-2 outline-none select-none last:border-b-0 z-focus-inset md:grid-cols-[1fr_10rem_6.5rem_2.5rem]',
                sel.includes(node.id) ? 'bg-[var(--select)]' : 'hover:bg-[var(--hover)]',
              )}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Thumb node={node} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'truncate text-sm text-[var(--text)]',
                        node.kind === 'folder' ? 'font-semibold' : 'font-medium',
                      )}
                    >
                      {nameOf ? nameOf(node) : node.name}
                    </span>
                    {node.starred && (
                      <Star
                        className="h-3.5 w-3.5 shrink-0 fill-current text-[var(--ink)]"
                        aria-label={t.files.star}
                      />
                    )}
                    <ExpiryMark node={node} />
                  </span>
                  <span className="block truncate text-xs text-[var(--muted)] tabular-nums md:hidden">
                    {formatDate(node.updatedAt)}
                    {node.kind === 'file' && ` · ${formatBytes(node.size)}`}
                  </span>
                  {extra?.(node)}
                  {subtitle?.(node) && (
                    <span className="hidden truncate text-xs text-[var(--muted)] md:block">
                      {subtitle(node)}
                    </span>
                  )}
                </span>
                <StatusBadge node={node} />
              </span>
              <span className="hidden text-xs text-[var(--muted)] tabular-nums md:block">
                {formatDate(node.updatedAt)}
              </span>
              <span className="hidden text-right text-xs text-[var(--muted)] tabular-nums md:block">
                {node.kind === 'file' ? formatBytes(node.size) : ''}
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
          className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 md:p-4 lg:grid-cols-5 xl:grid-cols-6"
        >
          {items.map((node, i) => (
            <div
              key={node.id}
              {...itemProps(node, i)}
              className={cn(
                'flex min-w-0 cursor-default flex-col overflow-hidden rounded-2xl border bg-[var(--surface)] outline-none select-none z-focus-inset',
                sel.includes(node.id)
                  ? 'border-[var(--ink)] bg-[var(--select)] ring-1 ring-[var(--ink)]'
                  : 'border-[var(--line)] transition-colors hover:border-[var(--line-strong)]',
              )}
            >
              <div className="flex min-h-12 items-center gap-2 py-1 pr-1 pl-3">
                <FileIcon node={node} className="h-4 w-4 shrink-0" />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm text-[var(--text)]',
                    node.kind === 'folder' ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {nameOf ? nameOf(node) : node.name}
                </span>
                <ExpiryMark node={node} />
                {kebab(node)}
              </div>
              {node.kind === 'file' && (
                <div className="mx-2 mb-2 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg bg-[var(--ground)]">
                  <Thumb node={node} big />
                </div>
              )}
              {node.kind === 'folder' && node.decor?.coverId && (
                <div className="mx-2 mb-2 flex aspect-[3/1] items-center justify-center overflow-hidden rounded-lg bg-[var(--ground)]">
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

/** D12: a clock on items that go to the Trash by themselves. */
function ExpiryMark({ node }: { node: NodeDto }) {
  if (node.expiresAt === null || node.trashedAt !== null) return null;
  const label = t.expiry.on(formatDate(node.expiresAt));
  return (
    <span title={label} className="shrink-0">
      <Clock className="h-3.5 w-3.5 text-[var(--muted)]" aria-label={label} />
    </span>
  );
}

function gridColumns(): number {
  const grid = document.querySelector('[data-grid]');
  if (!grid) return 1;
  return getComputedStyle(grid).gridTemplateColumns.split(' ').length;
}
