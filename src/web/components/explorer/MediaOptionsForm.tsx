// Photo/video compression options, shared by the Drive dialog and the standalone page.
import { t } from '../../../shared/strings.id';
import type { MediaOptions, Quality } from '../../lib/compress';

export const defaultMediaOptions: MediaOptions = {
  image: { format: 'webp', quality: 'seimbang' },
  video: { preset: '720p', quality: 'seimbang' },
};

const select =
  'h-9 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-2 text-sm outline-none focus:border-brand-500';
const QUALITIES: Quality[] = ['hemat', 'seimbang', 'tinggi'];

export function MediaOptionsForm({
  value: o,
  onChange,
  image,
  video,
}: {
  value: MediaOptions;
  onChange: (o: MediaOptions) => void;
  image: boolean;
  video: boolean;
}) {
  return (
    <div className="space-y-3">
      {image && (
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="col-span-2 mb-1 font-medium">{t.compress.image}</legend>
          <label className="text-xs text-[var(--fg-muted)]">
            {t.compress.format}
            <select
              className={select}
              value={o.image.format}
              onChange={(e) =>
                onChange({
                  ...o,
                  image: { ...o.image, format: e.target.value as MediaOptions['image']['format'] },
                })
              }
            >
              <option value="webp">WebP</option>
              <option value="avif">AVIF</option>
              <option value="jpeg">JPEG</option>
            </select>
          </label>
          <label className="text-xs text-[var(--fg-muted)]">
            {t.compress.quality}
            <select
              className={select}
              value={o.image.quality}
              onChange={(e) =>
                onChange({ ...o, image: { ...o.image, quality: e.target.value as Quality } })
              }
            >
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {t.compress.qualities[q]}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs text-[var(--fg-muted)]">
            {t.compress.maxWidth}
            <input
              type="number"
              min={16}
              max={12000}
              inputMode="numeric"
              className={select}
              value={o.image.maxWidth ?? ''}
              onChange={(e) => {
                const n = Number(e.target.value);
                const { maxWidth: _drop, ...rest } = o.image;
                void _drop;
                onChange({ ...o, image: n >= 16 ? { ...rest, maxWidth: n } : rest });
              }}
            />
          </label>
          <p className="col-span-2 text-xs text-[var(--fg-muted)]">{t.compress.stripExif}</p>
        </fieldset>
      )}
      {video && (
        <fieldset className="grid grid-cols-2 gap-2">
          <legend className="col-span-2 mb-1 font-medium">{t.compress.video}</legend>
          <label className="text-xs text-[var(--fg-muted)]">
            {t.compress.preset}
            <select
              className={select}
              value={o.video.preset}
              onChange={(e) =>
                onChange({
                  ...o,
                  video: { ...o.video, preset: e.target.value as MediaOptions['video']['preset'] },
                })
              }
            >
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </select>
          </label>
          <label className="text-xs text-[var(--fg-muted)]">
            {t.compress.quality}
            <select
              className={select}
              value={o.video.quality}
              onChange={(e) =>
                onChange({ ...o, video: { ...o.video, quality: e.target.value as Quality } })
              }
            >
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {t.compress.qualities[q]}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}
    </div>
  );
}
