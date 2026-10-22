// "Unduh sebagai arsip" (SPEC §7.1): ZIP cepat (default), ZIP terkompres, or TAR.ZST with a level.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatBytes } from '../../../shared/format';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import { useCatalog } from '../../lib/catalog';
import { downloadZip, estimateArchive, type ArchiveFormat } from '../../lib/files';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';
import { toast } from '../ui/Toast';

type Level = 'fast' | 'normal' | 'max';

export function ArchiveDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const catalog = useCatalog();
  const asyncOk = catalog.data?.capabilities?.asyncArchives !== false;
  const [format, setFormat] = useState<ArchiveFormat>('zip_store');
  const [level, setLevel] = useState<Level>('normal');
  const est = useQuery({
    queryKey: ['archive-estimate', ids],
    queryFn: () => estimateArchive(ids),
  });
  const total = est.data?.totalBytes ?? 0;
  const deflateAsync = Boolean(est.data && total > est.data.streamDeflateMax);
  const tooBigAsync = Boolean(est.data && total > est.data.asyncMax);

  const go = useMutation({
    mutationFn: () => downloadZip(ids, format, format === 'tar_zst' ? level : undefined),
    onSuccess: async (r) => {
      onClose();
      if (r.async) {
        toast(t.archive.queued);
        await qc.invalidateQueries({ queryKey: ['archives'] });
      } else toast(t.files.preparingZip);
    },
    onError: (e) =>
      toast(
        e instanceof ApiError && e.message === 'ARCHIVE_JOB_RUNNING'
          ? t.archive.jobRunning
          : e instanceof ApiError && e.message === 'ARCHIVE_TOO_LARGE'
            ? t.archive.tooLarge(formatBytes(est.data?.asyncMax ?? 0))
            : t.errors.generic,
        { tone: 'error' },
      ),
  });

  const options: Array<{ value: ArchiveFormat; label: string; hint: string; disabled: boolean }> = [
    {
      value: 'zip_store',
      label: t.archive.zipStore,
      hint: t.archive.zipStoreHint,
      disabled: false,
    },
    {
      value: 'zip_deflate',
      label: t.archive.zipDeflate,
      hint: deflateAsync ? t.archive.zipDeflateAsync : t.archive.zipDeflateHint,
      disabled: deflateAsync && (!asyncOk || tooBigAsync),
    },
    {
      value: 'tar_zst',
      label: t.archive.tarZst,
      hint: !asyncOk ? t.archive.unavailable : t.archive.tarZstHint,
      disabled: !asyncOk || tooBigAsync,
    },
  ];

  return (
    <Dialog
      open
      title={t.archive.title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => go.mutate()} disabled={go.isPending || !est.data?.fileCount}>
            {t.archive.download}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-[var(--fg-muted)]">
          {est.data ? t.archive.summary(est.data.fileCount, formatBytes(total)) : t.common.loading}
        </p>
        <fieldset className="space-y-2">
          {options.map((o) => (
            <label
              key={o.value}
              className={`flex gap-3 rounded-xl border p-3 ${format === o.value ? 'border-brand-500' : 'border-[var(--border)]'} ${o.disabled ? 'opacity-50' : ''}`}
            >
              <input
                type="radio"
                name="format"
                className="mt-1"
                checked={format === o.value}
                disabled={o.disabled}
                onChange={() => setFormat(o.value)}
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="text-xs text-[var(--fg-muted)]">{o.hint}</span>
                {o.value === 'tar_zst' && format === 'tar_zst' && (
                  <span className="mt-2 flex gap-2">
                    {(['fast', 'normal', 'max'] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setLevel(l)}
                        className={`rounded-full border px-3 py-1 text-xs ${level === l ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-[var(--border)]'}`}
                      >
                        {t.archive.levels[l]}
                      </button>
                    ))}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs text-[var(--fg-muted)]">{t.archive.mediaNote}</p>
      </div>
    </Dialog>
  );
}
