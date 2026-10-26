// "Unduh" for several items or a folder (SPEC §7.1): separate files through the app's download
// queue (ADR-053; optionally into a picked folder), ZIP cepat (default), ZIP terkompres, or TAR.ZST.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatBytes } from '../../../shared/format';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import { useCatalog } from '../../lib/catalog';
import { downloadZip, estimateArchive, type ArchiveFormat } from '../../lib/files';
import { useTransferSettings } from '../../lib/transfer';
import { canSaveToFolder, queueDriveDownload } from '../../download/useDownloads';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';
import { toast } from '../ui/Toast';

type Level = 'fast' | 'normal' | 'max';
type Choice = ArchiveFormat | 'separate';

const LAST = 'zk_dl_format';
function lastChoice(): Choice {
  try {
    const v = localStorage.getItem(LAST);
    if (v === 'separate' || v === 'zip_store' || v === 'zip_deflate' || v === 'tar_zst') return v;
  } catch {
    // ignore
  }
  return 'zip_store';
}

export function ArchiveDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const catalog = useCatalog();
  const asyncOk = catalog.data?.capabilities?.asyncArchives !== false;
  const [format, setFormatState] = useState<Choice>(lastChoice);
  const setFormat = (f: Choice) => {
    setFormatState(f);
    try {
      localStorage.setItem(LAST, f);
    } catch {
      // ignore
    }
  };
  const [toFolder, setToFolder] = useState(false);
  const folderOk = canSaveToFolder();
  const parallel = useTransferSettings().downloadFiles;
  const [level, setLevel] = useState<Level>('normal');
  const est = useQuery({
    queryKey: ['archive-estimate', ids],
    queryFn: () => estimateArchive(ids),
  });
  const total = est.data?.totalBytes ?? 0;
  const deflateAsync = Boolean(est.data && total > est.data.streamDeflateMax);
  const tooBigAsync = Boolean(est.data && total > est.data.asyncMax);

  const separate = useMutation({
    mutationFn: () => queueDriveDownload(ids, folderOk && toFolder),
    onSuccess: (r) => {
      if (!r) return; // folder picker closed
      onClose();
      if (!r.files) toast(t.transfer.nothingToDownload, { tone: 'error' });
      else
        toast(
          r.skipped ? t.transfer.queuedSkipped(r.files, r.skipped) : t.transfer.queued(r.files),
        );
    },
    onError: (e) =>
      toast(
        e instanceof ApiError && e.code === 'PAYLOAD_TOO_LARGE'
          ? t.transfer.tooMany(Number((e.data as { max?: number } | undefined)?.max ?? 0))
          : t.errors.generic,
        { tone: 'error' },
      ),
  });

  const go = useMutation({
    mutationFn: () =>
      downloadZip(ids, choice as ArchiveFormat, choice === 'tar_zst' ? level : undefined),
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

  const options: Array<{ value: Choice; label: string; hint: string; disabled: boolean }> = [
    {
      value: 'separate',
      label: t.transfer.separate,
      hint: t.transfer.separateHint(parallel),
      disabled: false,
    },
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

  // A remembered choice that is not possible here (e.g. no async archives) falls back to ZIP.
  const choice: Choice =
    options.find((o) => o.value === format && !o.disabled)?.value ?? 'zip_store';

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
          <Button
            onClick={() => (choice === 'separate' ? separate.mutate() : go.mutate())}
            disabled={go.isPending || separate.isPending || !est.data?.fileCount}
          >
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
              className={`flex gap-3 rounded-xl border p-3 ${choice === o.value ? 'border-brand-500' : 'border-[var(--border)]'} ${o.disabled ? 'opacity-50' : ''}`}
            >
              <input
                type="radio"
                name="format"
                className="mt-1"
                checked={choice === o.value}
                disabled={o.disabled}
                onChange={() => setFormat(o.value)}
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="text-xs text-[var(--fg-muted)]">{o.hint}</span>
                {o.value === 'separate' && choice === 'separate' && folderOk && (
                  <span className="mt-2 flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={toFolder}
                      onChange={(e) => setToFolder(e.target.checked)}
                    />
                    {t.transfer.toFolder}
                  </span>
                )}
                {o.value === 'tar_zst' && choice === 'tar_zst' && (
                  <span className="mt-2 flex gap-2">
                    {(['fast', 'normal', 'max'] as const).map((l) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setLevel(l)}
                        className={`rounded-full border px-3 py-1 text-xs ${level === l ? 'border-brand-500 bg-brand-50 dark:bg-brand-800/40 text-brand-800' : 'border-[var(--border)]'}`}
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
