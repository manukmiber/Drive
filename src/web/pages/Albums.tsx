// D10 (ADR-093): albums in the Gallery. A list of the person's albums (their own and their
// family's), and one album's photos in its own order: rename, sort, cover, take out, share, delete.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Images, MoreVertical, Plus, Share2, Star, Trash2, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  albumsKey,
  changeAlbum,
  Cover,
  errorText,
  fetchAlbums,
  NewAlbumDialog,
  type AlbumDto,
} from '../components/AlbumPicker';
import { Button } from '../components/Button';
import { useNodeActions } from '../components/explorer/useNodeActions';
import { Dialog, PromptDialog } from '../components/ui/Dialog';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { toast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import type { NodeDto } from '../lib/files';
import { t } from '../lib/i18n';
import { useMe } from '../lib/session';
import { flatRows, GalleryTabs, GAP, PAD, Tile, useGridLayout, VirtualGrid } from './Gallery';

/** /galeri/album: every album the person can open. */
export function AlbumList() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: albumsKey, queryFn: fetchAlbums });
  const [making, setMaking] = useState(false);
  useEffect(() => void (document.title = `${t.albums.title} · Zeiko`), []);
  return (
    <div>
      <div className="border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Images className="h-5 w-5 text-brand-600" aria-hidden="true" />
          <h1 className="text-lg font-semibold">{t.gallery.title}</h1>
          <GalleryTabs current="albums" />
        </div>
      </div>
      <div className="p-4">
        <Button className="h-9 px-3" onClick={() => setMaking(true)}>
          <Plus className="h-4 w-4" aria-hidden="true" /> {t.albums.newAlbum}
        </Button>
        {q.isPending ? (
          <p className="mt-4 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
        ) : !q.data?.items.length ? (
          <p className="mt-6 text-center text-sm text-[var(--fg-muted)]">{t.albums.empty}</p>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {q.data.items.map((a) => (
              <li key={a.id}>
                <Link
                  to="/galeri/album/$albumId"
                  params={{ albumId: a.id }}
                  className="group block rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <span className="block aspect-square overflow-hidden rounded-2xl bg-[var(--bg-subtle)]">
                    <Cover
                      id={a.coverId}
                      className="transition-transform duration-200 group-hover:scale-[1.03]"
                    />
                  </span>
                  <span className="mt-1.5 block truncate text-sm font-medium">{a.name}</span>
                  <span className="flex items-center gap-1 text-xs text-[var(--fg-muted)]">
                    {a.space === 'family' && <Users className="h-3 w-3" aria-hidden="true" />}
                    {t.albums.count(a.count)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <NewAlbumDialog
        open={making}
        onClose={() => setMaking(false)}
        onMade={(a) => {
          setMaking(false);
          void navigate({ to: '/galeri/album/$albumId', params: { albumId: a.id } });
        }}
      />
    </div>
  );
}

/** /galeri/album/:id: the album's photos in its order. */
export function AlbumView({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['album', id],
    queryFn: () =>
      api<{ album: AlbumDto; items: NodeDto[]; nextOffset: number | null }>(
        `/api/albums/${id}?limit=500`,
      ),
  });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const album = q.data?.album;
  const actions = useNodeActions(items);
  const me = useMe();
  const myId = me.data?.user.id;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { setList, head, wide, box, cols, tile } = useGridLayout();
  const rows = useMemo(() => flatRows(items, cols), [items, cols]);
  useEffect(() => {
    if (album) document.title = `${album.name} · Zeiko`;
  }, [album]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['album', id] });
    void qc.invalidateQueries({ queryKey: albumsKey });
  };
  async function change(body: Record<string, unknown>, done?: string) {
    try {
      await changeAlbum(id, body);
      if (done) toast(done);
      refresh();
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  }
  const sel = [...selected].filter((s) => items.some((i) => i.id === s));
  const toggle = (nid: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(nid)) next.delete(nid);
      else next.add(nid);
      return next;
    });
  if (q.isError)
    return <p className="p-6 text-center text-sm text-[var(--fg-muted)]">{t.albums.notFound}</p>;
  const albumMenu: MenuItem[] = album
    ? [
        ...(items.length
          ? [
              {
                label: t.albums.shareAlbum,
                icon: Share2,
                // A bundle share link takes up to 100 files (ADR-054).
                onSelect: () => {
                  if (items.length > 100) toast(t.albums.shareLimit(100));
                  actions
                    .menuFor(items.slice(0, 100).map((i) => i.id))
                    .find((m) => m.label === t.common.share)
                    ?.onSelect();
                },
              },
            ]
          : []),
        ...(album.canManage
          ? [
              { label: t.common.rename, onSelect: () => setRenaming(true) },
              {
                label: t.albums.deleteAlbum,
                icon: Trash2,
                danger: true,
                onSelect: () => setDeleting(true),
              },
            ]
          : []),
      ]
    : [];
  return (
    <div>
      <div
        ref={head}
        className="z-glass relative border-b border-[var(--border)] px-4 py-3 md:sticky md:top-0 md:z-10"
      >
        <div className="flex items-center gap-2">
          <Link
            to="/galeri/album"
            className="text-sm text-brand-700 hover:underline"
            aria-label={t.albums.title}
          >
            {t.albums.title}
          </Link>
          <span className="text-[var(--fg-muted)]">/</span>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{album?.name ?? ''}</h1>
          {albumMenu.length > 0 && (
            <button
              type="button"
              className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
              aria-label={t.a11y.moreActions}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.right, y: r.bottom });
              }}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          )}
        </div>
        {album && (
          <div className="mt-1 flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            <span className="flex items-center gap-1">
              {album.space === 'family' && <Users className="h-3 w-3" aria-hidden="true" />}
              {t.albums.count(album.count)}
            </span>
            {album?.canManage && (
              <select
                aria-label={t.albums.sort}
                value={album.sort}
                onChange={(e) => void change({ sort: e.target.value })}
                className="ml-auto h-8 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 text-xs text-[var(--fg)]"
              >
                <option value="added">{t.albums.sortAdded}</option>
                <option value="newest">{t.albums.sortNewest}</option>
                <option value="oldest">{t.albums.sortOldest}</option>
              </select>
            )}
          </div>
        )}
        {sel.length > 0 && (
          <div className="absolute inset-0 z-10 flex items-center gap-2 bg-[var(--bg)] px-4">
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
              <Button
                variant="secondary"
                className="h-8 shrink-0 px-3 text-xs"
                onClick={() =>
                  void change({ remove: sel }, t.albums.removed(sel.length)).then(() =>
                    setSelected(new Set()),
                  )
                }
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" /> {t.albums.removeFrom}
              </Button>
              {sel.length === 1 && album?.canManage && (
                <Button
                  variant="secondary"
                  className="h-8 shrink-0 px-3 text-xs"
                  onClick={() =>
                    void change({ coverId: sel[0] }, t.albums.coverSet).then(() =>
                      setSelected(new Set()),
                    )
                  }
                >
                  <Star className="h-3.5 w-3.5" aria-hidden="true" /> {t.albums.setCover}
                </Button>
              )}
              {actions
                .menuFor(sel)
                .filter((m) => m.label !== t.albums.addTo)
                .map((m) => (
                  <button
                    key={m.label}
                    type="button"
                    disabled={m.disabled}
                    onClick={() => m.onSelect()}
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
        )}
      </div>
      <div ref={setList} style={{ paddingInline: PAD, paddingTop: GAP }}>
        {q.isPending ? (
          <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
        ) : !items.length ? (
          <p className="p-6 text-center text-sm text-[var(--fg-muted)]">{t.albums.emptyAlbum}</p>
        ) : (
          <VirtualGrid
            rows={rows}
            tile={tile}
            box={box}
            wide={wide}
            onNearEnd={() => undefined}
            renderRow={(row) =>
              row.kind === 'tiles' ? (
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
              ) : null
            }
          />
        )}
      </div>
      {menu && <Menu items={albumMenu} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      <PromptDialog
        open={renaming}
        title={t.common.rename}
        initial={album?.name ?? ''}
        confirmLabel={t.common.save}
        onCancel={() => setRenaming(false)}
        onSubmit={(name) => {
          setRenaming(false);
          void change({ name });
        }}
      />
      <Dialog
        open={deleting}
        title={t.albums.deleteAlbum}
        onClose={() => setDeleting(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                void api(`/api/albums/${id}`, { method: 'DELETE' })
                  .then(() => {
                    void qc.invalidateQueries({ queryKey: albumsKey });
                    void navigate({ to: '/galeri/album' });
                  })
                  .catch((e: unknown) => toast(errorText(e), { tone: 'error' }))
              }
            >
              {t.albums.deleteAlbum}
            </Button>
          </>
        }
      >
        <p>{t.albums.deleteBody}</p>
      </Dialog>
      {actions.ui}
    </div>
  );
}
