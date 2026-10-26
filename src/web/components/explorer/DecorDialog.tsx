// Decorating folders (ADR-058): a colour from the palette, an icon or one emoji, and a cover image
// from the same Drive (this folder's images, a search, or a new upload). Several folders at once;
// only the parts touched here are sent, so the rest of each folder's decoration stays.
import { useQuery } from '@tanstack/react-query';
import { Ban, ImagePlus, Search } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  FOLDER_COLORS,
  FOLDER_ICONS,
  isOneEmoji,
  type FolderColor,
} from '../../../shared/folder-decor';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import {
  decorateFolders,
  listChildren,
  previewInfo,
  searchNodes,
  type NodeDto,
} from '../../lib/files';
import { t } from '../../lib/i18n';
import { makeAndUploadThumb } from '../../upload/thumbs';
import { uploads } from '../../upload/useUploads';
import { Button } from '../Button';
import { FileIcon } from '../FileIcon';
import { DECOR_ICONS, decorVars, FolderGlyph } from '../FolderGlyph';
import { Dialog } from '../ui/Dialog';
import { toast } from '../ui/Toast';
import { errorText } from './useNodeActions';

type Part = 'color' | 'icon' | 'coverId';

const isImageNode = (n: NodeDto) =>
  n.kind === 'file' &&
  n.status === 'ready' &&
  ((n.mime ?? '').startsWith('image/') || /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(n.name));

function failText(e: unknown): string {
  const reason = e instanceof ApiError ? e.data?.reason : null;
  if (reason === 'NO_THUMBNAIL' || reason === 'COVER_NOT_IMAGE') return t.decor.noThumb;
  if (reason === 'COVER_OTHER_SPACE') return t.decor.otherSpace;
  return errorText(e);
}

/** A thumbnail for an image that has none yet, made in this browser from its preview (SPEC §5.2). */
async function ensureThumb(n: NodeDto): Promise<void> {
  if (n.hasThumb) return;
  const { url } = await previewInfo(n.id);
  const blob = await (await fetch(url)).blob();
  await makeAndUploadThumb(n.id, new File([blob], n.name, { type: blob.type || n.mime || '' }));
}

export function DecorDialog({
  folders,
  onClose,
  onSaved,
}: {
  folders: NodeDto[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const single = folders.length === 1 ? folders[0]! : null;
  const start = single?.decor ?? null;
  const [color, setColor] = useState<FolderColor | null>(start?.color ?? null);
  const [icon, setIcon] = useState<string | null>(start?.icon ?? null);
  const [cover, setCover] = useState<NodeDto | null>(null);
  const [coverId, setCoverId] = useState<string | null>(start?.coverId ?? null);
  const [touched, setTouched] = useState<Set<Part>>(new Set());
  const [emoji, setEmoji] = useState(start?.icon && isOneEmoji(start.icon) ? start.icon : '');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const touch = (p: Part) => setTouched((s) => new Set(s).add(p));
  const inFolder = useQuery({
    queryKey: ['decor-images', single?.id],
    queryFn: () => listChildren(single!.id, 'updated', 'desc'),
    enabled: Boolean(single),
    refetchInterval: uploading ? 4000 : false,
  });
  const found = useQuery({
    queryKey: ['decor-search', searched],
    queryFn: () => searchNodes(searched, 'image'),
    enabled: searched.length > 0,
  });
  const space = folders[0]?.space;
  const images = (list: NodeDto[] | undefined) =>
    (list ?? []).filter((n) => isImageNode(n) && n.space === space).slice(0, 24);

  async function pick(n: NodeDto) {
    setBusy(true);
    try {
      const made = !n.hasThumb;
      await ensureThumb(n);
      setCover({ ...n, hasThumb: true });
      setCoverId(n.id);
      touch('coverId');
      // The tiles show the thumbnail this browser just made.
      if (made) void Promise.all([inFolder.refetch(), searched ? found.refetch() : null]);
    } catch (e) {
      toast(failText(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function save(patch: {
    color?: string | null;
    icon?: string | null;
    coverId?: string | null;
  }) {
    setBusy(true);
    try {
      await decorateFolders(
        folders.map((f) => f.id),
        patch,
      );
      const cleared = patch.color === null && patch.icon === null && patch.coverId === null;
      toast(cleared ? t.decor.cleared : t.decor.saved);
      onSaved();
      onClose();
    } catch (e) {
      toast(failText(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const changed = () => {
    const patch: { color?: string | null; icon?: string | null; coverId?: string | null } = {};
    if (touched.has('color')) patch.color = color;
    if (touched.has('icon')) patch.icon = icon;
    if (touched.has('coverId')) patch.coverId = coverId;
    return patch;
  };

  const coverThumb = (n: NodeDto) => (
    <button
      key={n.id}
      type="button"
      disabled={busy}
      onClick={() => void pick(n)}
      aria-pressed={coverId === n.id}
      title={n.name}
      className={cn(
        'flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-[var(--bg-subtle)]',
        coverId === n.id ? 'border-brand-500 ring-2 ring-brand-500' : 'border-[var(--border)]',
      )}
    >
      {n.hasThumb ? (
        <img
          src={`/api/files/${n.id}/thumbnail`}
          alt={n.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <FileIcon node={n} className="h-6 w-6" />
      )}
    </button>
  );

  const swatch = 'flex h-9 w-9 items-center justify-center rounded-full border-2';
  return (
    <Dialog
      open
      title={t.decor.title(folders.length)}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void save({ color: null, icon: null, coverId: null })}
          >
            {t.decor.clearAll}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button disabled={busy || !touched.size} onClick={() => void save(changed())}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-sm">
        <div className="overflow-hidden rounded-xl border border-[var(--border)]">
          {coverId && (cover?.hasThumb || coverId === start?.coverId) && (
            <img
              src={`/api/files/${coverId}/thumbnail`}
              alt=""
              className="h-16 w-full object-cover"
            />
          )}
          <div className="flex items-center gap-2 px-3 py-2">
            <FolderGlyph color={color} icon={icon} className="h-6 w-6" />
            <span className="truncate font-medium">
              {single ? single.name : t.decor.title(folders.length)}
            </span>
          </div>
        </div>

        <fieldset>
          <legend className="mb-2 font-medium">{t.decor.color}</legend>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-label={t.decor.none}
              aria-pressed={color === null}
              onClick={() => (setColor(null), touch('color'))}
              className={cn(swatch, color === null ? 'border-brand-500' : 'border-[var(--border)]')}
            >
              <Ban className="h-4 w-4 text-[var(--fg-muted)]" aria-hidden="true" />
            </button>
            {(Object.keys(FOLDER_COLORS) as FolderColor[]).map((c) => (
              <button
                key={c}
                type="button"
                aria-label={t.decor.colors[c]}
                title={t.decor.colors[c]}
                aria-pressed={color === c}
                onClick={() => (setColor(c), touch('color'))}
                className={cn(swatch, color === c ? 'border-[var(--fg)]' : 'border-transparent')}
              >
                <span
                  className="decor-swatch h-6 w-6 rounded-full"
                  style={decorVars(c)}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 font-medium">{t.decor.icon}</legend>
          <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-9">
            <button
              type="button"
              aria-label={t.decor.none}
              aria-pressed={icon === null}
              onClick={() => (setIcon(null), setEmoji(''), touch('icon'))}
              className={cn(
                'flex aspect-square items-center justify-center rounded-lg border',
                icon === null
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-800/40'
                  : 'border-[var(--border)]',
              )}
            >
              <Ban className="h-4 w-4 text-[var(--fg-muted)]" aria-hidden="true" />
            </button>
            {FOLDER_ICONS.map((name) => {
              const Icon = DECOR_ICONS[name];
              return (
                <button
                  key={name}
                  type="button"
                  aria-label={t.decor.icons[name]}
                  title={t.decor.icons[name]}
                  aria-pressed={icon === name}
                  onClick={() => (setIcon(name), setEmoji(''), touch('icon'))}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-lg border',
                    icon === name
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-800/40'
                      : 'border-[var(--border)] hover:bg-[var(--bg-subtle)]',
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <label className="mt-3 flex items-center gap-2">
            <span className="text-[var(--fg-muted)]">{t.decor.emoji}</span>
            <input
              value={emoji}
              onChange={(e) => {
                const v = e.target.value.trim();
                setEmoji(v);
                if (isOneEmoji(v)) {
                  setIcon(v);
                  touch('icon');
                }
              }}
              aria-invalid={emoji !== '' && !isOneEmoji(emoji)}
              className="h-9 w-16 rounded-lg border border-[var(--border)] bg-transparent text-center text-lg"
              maxLength={16}
            />
            {emoji !== '' && !isOneEmoji(emoji) && (
              <span className="text-xs text-red-600">{t.decor.emojiInvalid}</span>
            )}
          </label>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="mb-1 font-medium">{t.decor.cover}</legend>
          <p className="text-xs text-[var(--fg-muted)]">{t.decor.coverHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={coverId === null ? 'primary' : 'secondary'}
              onClick={() => (setCover(null), setCoverId(null), touch('coverId'))}
            >
              {t.decor.noCover}
            </Button>
            {single && (
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                <ImagePlus className="h-4 w-4" aria-hidden="true" /> {t.decor.upload}
              </Button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file || !single) return;
                void uploads()
                  .add([{ file, parentId: single.id }])
                  .then(() => (setUploading(true), toast(t.decor.uploading)))
                  .catch((err: unknown) => toast(errorText(err), { tone: 'error' }));
              }}
            />
          </div>
          {single && (
            <div>
              <p className="mb-1.5 text-xs font-medium">{t.decor.inFolder}</p>
              {images(inFolder.data?.items).length ? (
                <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
                  {images(inFolder.data?.items).map(coverThumb)}
                </div>
              ) : (
                <p className="text-xs text-[var(--fg-muted)]">
                  {uploading ? t.decor.uploading : t.decor.noImages}
                </p>
              )}
            </div>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSearched(query.trim());
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.decor.searchImages}
              aria-label={t.decor.searchImages}
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3"
            />
            <Button type="submit" variant="secondary" aria-label={t.decor.searchImages}>
              <Search className="h-4 w-4" aria-hidden="true" />
            </Button>
          </form>
          {searched &&
            found.isSuccess &&
            (images(found.data.items).length ? (
              <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-6">
                {images(found.data.items).map(coverThumb)}
              </div>
            ) : (
              <p className="text-xs text-[var(--fg-muted)]">{t.decor.noImages}</p>
            ))}
        </fieldset>
      </div>
    </Dialog>
  );
}
