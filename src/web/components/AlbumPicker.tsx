// D10 (ADR-093): the album pieces the explorer needs too ("Add to album", "New album"), kept apart
// from the Gallery page so the Drive views don't load it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from './Button';
import { Dialog } from './ui/Dialog';
import { toast } from './ui/Toast';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import type { NodeDto } from '../lib/files';
import { t } from '../lib/i18n';
import { useMe } from '../lib/session';

export interface AlbumDto {
  id: string;
  name: string;
  space: 'personal' | 'family';
  count: number;
  coverId: string | null;
  sort: 'added' | 'newest' | 'oldest';
  createdAt: number;
  updatedAt: number;
  canManage: boolean;
}

export const albumsKey = ['albums'];

export const fetchAlbums = () => api<{ items: AlbumDto[] }>('/api/albums');

export const changeAlbum = (id: string, body: Record<string, unknown>) =>
  api<{ album: AlbumDto }>(`/api/albums/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const createAlbum = (body: { name: string; space: string; nodeIds?: string[] }) =>
  api<{ album: AlbumDto }>('/api/albums', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : t.errors.generic);

export function Cover({ id, className }: { id: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  return id && !failed ? (
    <img
      src={`/api/files/${id}/thumbnail`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn('h-full w-full object-cover', className)}
    />
  ) : (
    <span className="flex h-full w-full items-center justify-center text-[var(--fg-muted)]">
      <BookImage className="h-8 w-8" aria-hidden="true" />
    </span>
  );
}

/** "New album": a name, and where it lives when the person has a family. */
export function NewAlbumDialog({
  open,
  nodeIds,
  onClose,
  onMade,
}: {
  open: boolean;
  nodeIds?: string[];
  onClose: () => void;
  onMade: (a: AlbumDto) => void;
}) {
  const me = useMe();
  const family = Boolean(me.data?.space.familyId);
  const [name, setName] = useState('');
  const [space, setSpace] = useState<'personal' | 'family'>('personal');
  const [busy, setBusy] = useState(false);
  async function make() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { album } = await createAlbum({
        name: name.trim(),
        space,
        ...(nodeIds ? { nodeIds } : {}),
      });
      setName('');
      onMade(album);
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      title={t.albums.newAlbum}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void make()}>
            {t.albums.create}
          </Button>
        </>
      }
    >
      <label className="block text-sm">
        {t.albums.namePrompt}
        <input
          autoFocus
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void make()}
          className="mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 outline-none focus:border-brand-500"
        />
      </label>
      {family && (
        <fieldset className="mt-3 text-sm">
          <legend className="text-[var(--fg-muted)]">{t.albums.spaceLabel}</legend>
          <div className="mt-1 flex gap-4">
            {(['personal', 'family'] as const).map((sp) => (
              <label key={sp} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="album-space"
                  checked={space === sp}
                  onChange={() => setSpace(sp)}
                />
                {sp === 'personal' ? t.albums.spacePersonal : t.albums.spaceFamily}
              </label>
            ))}
          </div>
          {space === 'family' && (
            <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.albums.familyHint}</p>
          )}
        </fieldset>
      )}
    </Dialog>
  );
}

/** "Add to album": pick one of the person's albums, or make a new one with these files. */
export function AlbumPicker({ nodes, onClose }: { nodes: NodeDto[]; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: albumsKey, queryFn: fetchAlbums });
  const [making, setMaking] = useState(false);
  const ids = nodes.map((n) => n.id);
  async function add(a: AlbumDto) {
    try {
      await changeAlbum(a.id, { add: ids });
      toast(t.albums.addedTo(a.name));
      void qc.invalidateQueries({ queryKey: albumsKey });
      void qc.invalidateQueries({ queryKey: ['album', a.id] });
      onClose();
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  }
  if (making)
    return (
      <NewAlbumDialog
        open
        nodeIds={ids}
        onClose={() => setMaking(false)}
        onMade={(a) => {
          toast(t.albums.addedTo(a.name));
          void qc.invalidateQueries({ queryKey: albumsKey });
          onClose();
        }}
      />
    );
  return (
    <Dialog open title={t.albums.addTo} onClose={onClose}>
      <button
        type="button"
        onClick={() => setMaking(true)}
        className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-[var(--bg-subtle)]"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-800/40 dark:text-brand-100">
          <Plus className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="font-medium">{t.albums.newAlbum}</span>
      </button>
      <ul className="mt-1 max-h-[50vh] overflow-y-auto">
        {(q.data?.items ?? []).map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => void add(a)}
              className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-[var(--bg-subtle)]"
            >
              <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[var(--bg-subtle)]">
                <Cover id={a.coverId} />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{a.name}</span>
                <span className="text-xs text-[var(--fg-muted)]">
                  {t.albums.count(a.count)}
                  {a.space === 'family' && ` · ${t.albums.spaceFamily}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
