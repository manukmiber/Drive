// D8 (ADR-091): every photo and video the person may see, newest taken first, grouped by month and
// day. A virtual grid (only the rows on screen exist), more pages as it scrolls, many selected at
// once with the explorer's own actions, and the preview swiping through in gallery order.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useVirtualizer, useWindowVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import {
  Check,
  Film,
  Image as ImageIcon,
  Images,
  Play,
  Search as SearchIcon,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNodeActions } from '../components/explorer/useNodeActions';
import { cn } from '../lib/cn';
import { galleryPage, previewInfo, type NodeDto } from '../lib/files';
import { lang, t } from '../lib/i18n';
import { useMe } from '../lib/session';
import { makeAndUploadThumb } from '../upload/thumbs';

const WIB = 'Asia/Jakarta';
const GAP = 4;
const PAD = 8;

export function galleryDate(n: NodeDto): number {
  return n.takenAt ?? n.clientModifiedAt ?? n.createdAt;
}

type Row =
  | { kind: 'month'; key: string; label: string }
  | { kind: 'day'; key: string; label: string }
  | { kind: 'tiles'; key: string; items: NodeDto[] };

const monthFmt = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'id-ID', {
  month: 'long',
  year: 'numeric',
  timeZone: WIB,
});
const dayFmt = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'id-ID', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: WIB,
});
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: WIB });

/** Month headers, day headers, and the photos of each day cut into rows of `cols`. */
export function galleryRows(items: NodeDto[], cols: number): Row[] {
  const rows: Row[] = [];
  let month = '';
  let day = '';
  let run: NodeDto[] = [];
  const flush = () => {
    for (let i = 0; i < run.length; i += cols)
      rows.push({ kind: 'tiles', key: `t${run[i]!.id}`, items: run.slice(i, i + cols) });
    run = [];
  };
  for (const n of items) {
    const at = galleryDate(n);
    const d = keyFmt.format(at);
    if (d.slice(0, 7) !== month) {
      flush();
      month = d.slice(0, 7);
      rows.push({ kind: 'month', key: `m${month}`, label: monthFmt.format(at) });
    }
    if (d !== day) {
      flush();
      day = d;
      rows.push({ kind: 'day', key: `d${d}`, label: dayFmt.format(at) });
    }
    run.push(n);
  }
  flush();
  return rows;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Thumbnails that were never made (old uploads, WebDAV): made here, two at a time, for files the
// viewer may edit (the thumbnail route needs that); others keep an icon. The newest request goes
// first, and tiles that scrolled away before their turn are skipped (asked again when they return).
const started = new Map<string, Promise<boolean>>();
const queue: Array<{ node: NodeDto; wanted: () => boolean; done: (ok: boolean) => void }> = [];
let running = 0;

async function makeOne(n: NodeDto): Promise<boolean> {
  const { url } = await previewInfo(n.id);
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return false;
  const blob = await res.blob();
  return makeAndUploadThumb(n.id, new File([blob], n.name, { type: n.mime ?? blob.type }));
}

function pump(): void {
  while (running < 2 && queue.length) {
    const job = queue.pop()!;
    if (!job.wanted()) {
      job.done(false);
      continue;
    }
    let p = started.get(job.node.id);
    if (!p) {
      running++;
      p = makeOne(job.node)
        .catch(() => false)
        .finally(() => {
          running--;
          pump();
        });
      started.set(job.node.id, p);
    }
    void p.then(job.done);
  }
}

function requestThumb(node: NodeDto, wanted: () => boolean): Promise<boolean> {
  const had = started.get(node.id);
  if (had) return had;
  return new Promise((done) => {
    queue.push({ node, wanted, done });
    pump();
  });
}

function Tile({
  node,
  size,
  selected,
  selecting,
  mine,
  onOpen,
  onToggle,
}: {
  node: NodeDto;
  size: number;
  selected: boolean;
  selecting: boolean;
  mine: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const [made, setMade] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = (node.mime ?? '').startsWith('video/');
  const canMake = !node.hasThumb && !video && mine && node.status === 'ready';
  useEffect(() => {
    if (!canMake) return;
    let live = true;
    void requestThumb(node, () => live).then((ok) => live && ok && setMade(true));
    return () => {
      live = false;
    };
  }, [canMake, node]);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const showImg = (node.hasThumb || made) && !failed;
  return (
    <button
      type="button"
      aria-pressed={selecting ? selected : undefined}
      aria-label={node.name}
      style={{ width: size, height: size }}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-lg bg-[var(--bg-subtle)] outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        selected && 'ring-2 ring-brand-500',
      )}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        long.current = false;
        press.current = setTimeout(() => {
          long.current = true;
          onToggle();
        }, 450);
      }}
      onPointerUp={() => press.current && clearTimeout(press.current)}
      onPointerLeave={() => press.current && clearTimeout(press.current)}
      onPointerCancel={() => press.current && clearTimeout(press.current)}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (long.current) {
          long.current = false;
          return;
        }
        const onCheck = (e.target as HTMLElement).closest('[data-check]');
        if (selecting || onCheck || e.ctrlKey || e.metaKey || e.shiftKey) onToggle();
        else onOpen();
      }}
    >
      {showImg ? (
        <img
          src={`/api/files/${node.id}/thumbnail${made ? '?v=1' : ''}`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className={cn(
            'h-full w-full object-cover transition-transform',
            selected && 'scale-90 rounded-md',
          )}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[var(--fg-muted)]">
          {video ? (
            <Film className="h-7 w-7" aria-hidden="true" />
          ) : (
            <ImageIcon className="h-7 w-7" aria-hidden="true" />
          )}
        </span>
      )}
      {video && (
        <span className="absolute bottom-1 right-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 text-[10px] font-medium text-white">
          <Play className="h-2.5 w-2.5 fill-white" aria-hidden="true" />
          {node.durationMs ? duration(node.durationMs) : ''}
        </span>
      )}
      {/* Always there for a mouse (shown on hover), so picking needs no Ctrl. */}
      <span
        data-check=""
        className={cn(
          'absolute left-0 top-0 flex h-8 w-8 items-start justify-start p-1',
          !(selecting || selected) && 'opacity-0 group-hover:opacity-100 max-md:hidden',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-full border-2',
            selected ? 'border-brand-500 bg-brand-500 text-white' : 'border-white/90 bg-black/20',
          )}
        >
          {selected && <Check className="h-3 w-3" />}
        </span>
      </span>
    </button>
  );
}

interface Virtual {
  getVirtualItems(): VirtualItem[];
  getTotalSize(): number;
}

interface GridProps {
  rows: Row[];
  tile: number;
  /** Where the list starts inside what scrolls it. */
  margin: number;
  /** The shell's <main>, which scrolls on wider screens. */
  main: HTMLElement | null;
  onNearEnd: () => void;
  renderRow: (row: Row) => ReactNode;
}

const estimate = (rows: Row[], tile: number) => (i: number) =>
  rows[i]!.kind === 'month' ? 48 : rows[i]!.kind === 'day' ? 30 : tile + GAP;

function Rows({
  v,
  margin,
  rows,
  onNearEnd,
  renderRow,
}: GridProps & { v: Virtual; margin: number }) {
  const virtual = v.getVirtualItems();
  const last = virtual[virtual.length - 1]?.index ?? 0;
  useEffect(() => {
    if (last >= rows.length - 6) onNearEnd();
  }, [last, rows.length, onNearEnd]);
  return (
    <div style={{ height: v.getTotalSize(), position: 'relative' }}>
      {virtual.map((vr) => {
        const row = rows[vr.index]!;
        return (
          <div
            key={row.key}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: vr.size,
              transform: `translateY(${vr.start - margin}px)`,
            }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}

// Phones scroll the page itself (the app header is sticky); wider screens scroll the shell's <main>.
// Either way only the rows on screen exist.
function WindowGrid(p: GridProps) {
  const v = useWindowVirtualizer({
    count: p.rows.length,
    estimateSize: estimate(p.rows, p.tile),
    overscan: 6,
    scrollMargin: p.margin,
  });
  return <Rows {...p} v={v} />;
}

function MainGrid(p: GridProps) {
  // The virtualizer re-renders on scroll by design; it is not one to memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: p.rows.length,
    getScrollElement: () => p.main,
    estimateSize: estimate(p.rows, p.tile),
    overscan: 6,
    scrollMargin: p.margin,
  });
  return <Rows {...p} v={v} />;
}

const WIDE = '(min-width: 768px)';
function subscribeWide(cb: () => void) {
  const m = window.matchMedia(WIDE);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
}
const useWide = () => useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches);

export function Gallery({ q, space }: { q: string; space?: 'personal' | 'family' | undefined }) {
  const navigate = useNavigate();
  const me = useMe();
  const [text, setText] = useState(q);
  // A new query from the address (a link, Back) replaces what is typed.
  const [shown, setShown] = useState(q);
  if (shown !== q) {
    setShown(q);
    setText(q);
  }
  useEffect(() => void (document.title = `${t.gallery.title} · Zeiko`), []);
  const pages = useInfiniteQuery({
    queryKey: ['gallery', q, space],
    queryFn: ({ pageParam }) => galleryPage(q, space, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const actions = useNodeActions(items);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const head = useRef<HTMLDivElement>(null);
  const wide = useWide();
  const [box, setBox] = useState({
    width: 360,
    page: 0,
    inMain: 0,
    main: null as HTMLElement | null,
  });
  useLayoutEffect(() => {
    const top = head.current;
    if (!list || !top) return;
    // Called once on observing, then whenever the list or the bar above it changes size.
    const ro = new ResizeObserver(() => {
      const main = list.closest('main');
      const r = list.getBoundingClientRect();
      setBox({
        width: list.clientWidth,
        page: r.top + window.scrollY,
        inMain: main ? r.top - main.getBoundingClientRect().top + main.scrollTop : 0,
        main,
      });
    });
    ro.observe(list);
    ro.observe(top);
    return () => ro.disconnect();
  }, [list]);
  const width = box.width;
  // Four across on a phone, bigger tiles where there is room.
  const minTile = width < 640 ? 76 : 128;
  const cols = Math.max(3, Math.min(12, Math.floor((width - PAD * 2 + GAP) / (minTile + GAP))));
  const tile = Math.floor((width - PAD * 2 - GAP * (cols - 1)) / cols);
  const rows = useMemo(() => galleryRows(items, cols), [items, cols]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const onNearEnd = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const sel = [...selected].filter((id) => items.some((i) => i.id === id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const search = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/galeri', search: { q: text.trim(), ...(space ? { space } : {}) } });
  };
  const family = Boolean(me.data?.space.familyId);
  const myId = me.data?.user.id;

  const selectionBar = (
    <div
      className={cn(
        'z-10 flex items-center gap-2 bg-[var(--bg)] px-4',
        // A portal on phones: the header's backdrop filter would hold a fixed bar inside it.
        wide
          ? 'absolute inset-0'
          : 'fixed inset-x-0 top-16 z-30 h-14 border-b border-[var(--border)] shadow-sm',
      )}
    >
      <button
        type="button"
        onClick={() => setSelected(new Set())}
        className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
        aria-label={t.common.cancel}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className="shrink-0 text-sm font-medium">{t.gallery.selected(sel.length)}</span>
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {actions.menuFor(sel).map((m) => (
          <button
            key={m.label}
            type="button"
            disabled={m.disabled}
            onClick={() => {
              m.onSelect();
            }}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--bg-subtle)]',
              m.danger && 'text-red-600',
            )}
          >
            {m.icon && <m.icon className="h-3.5 w-3.5" />}
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <div
        ref={head}
        className="z-glass relative border-b border-[var(--border)] px-4 py-3 md:sticky md:top-0 md:z-10"
      >
        <div className="flex items-center gap-2">
          <Images className="h-5 w-5 text-brand-600" aria-hidden="true" />
          <h1 className="text-lg font-semibold">{t.gallery.title}</h1>
        </div>
        <form onSubmit={search} className="mt-2 flex items-center gap-2" role="search">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">{t.gallery.search}</span>
            <SearchIcon
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fg-muted)]"
              aria-hidden="true"
            />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.gallery.searchHint}
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] pl-9 pr-3 text-sm outline-none focus:border-brand-500"
            />
          </label>
          {family && (
            <select
              value={space ?? ''}
              aria-label={t.searchFilters.space}
              onChange={(e) =>
                void navigate({
                  to: '/galeri',
                  search: {
                    q,
                    ...(e.target.value ? { space: e.target.value as 'personal' | 'family' } : {}),
                  },
                })
              }
              className="h-10 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
            >
              <option value="">{t.searchFilters.spaceAll}</option>
              <option value="personal">{t.searchFilters.spacePersonal}</option>
              <option value="family">{t.searchFilters.spaceFamily}</option>
            </select>
          )}
        </form>
        {sel.length > 0 && (wide ? selectionBar : createPortal(selectionBar, document.body))}
      </div>
      <div ref={setList} style={{ paddingInline: PAD }}>
        {pages.isPending ? (
          <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
        ) : !items.length ? (
          <p className="p-6 text-center text-sm text-[var(--fg-muted)]">
            {q ? t.files.noResults : t.gallery.empty}
          </p>
        ) : (
          (() => {
            const grid: GridProps = {
              rows,
              tile,
              margin: wide ? box.inMain : box.page,
              main: box.main,
              onNearEnd,
              renderRow: (row) =>
                row.kind === 'month' ? (
                  <h2 className="pt-4 pb-1 text-base font-semibold capitalize">{row.label}</h2>
                ) : row.kind === 'day' ? (
                  <h3 className="pt-1.5 text-xs text-[var(--fg-muted)]">{row.label}</h3>
                ) : (
                  <div className="flex" style={{ gap: GAP }}>
                    {row.items.map((n) => (
                      <Tile
                        key={n.id}
                        node={n}
                        size={tile}
                        selected={selected.has(n.id)}
                        selecting={sel.length > 0}
                        mine={n.ownerId === myId}
                        onOpen={() => actions.open(n)}
                        onToggle={() => toggle(n.id)}
                      />
                    ))}
                  </div>
                ),
            };
            return wide ? <MainGrid {...grid} /> : <WindowGrid {...grid} />;
          })()
        )}
      </div>
      {actions.ui}
    </div>
  );
}
