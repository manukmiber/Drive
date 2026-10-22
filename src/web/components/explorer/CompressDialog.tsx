// "Kompres" options for a selection of photos/videos (SPEC §11).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { t } from '../../../shared/strings.id';
import {
  listCompressJobs,
  mediaKind,
  reasonCode,
  startCompress,
  type MediaOptions,
} from '../../lib/compress';
import type { NodeDto } from '../../lib/files';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';
import { toast } from '../ui/Toast';
import { MediaOptionsForm, defaultMediaOptions } from './MediaOptionsForm';

export function CompressDialog({ nodes, onClose }: { nodes: NodeDto[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [o, setO] = useState<MediaOptions>(defaultMediaOptions);
  const [save, setSave] = useState<'copy' | 'replace'>('copy');
  const credits = useQuery({ queryKey: ['compress'], queryFn: listCompressJobs });
  const hasImage = nodes.some((n) => mediaKind(n.name, n.mime) === 'image');
  const hasVideo = nodes.some((n) => mediaKind(n.name, n.mime) === 'video');
  const balance = credits.data?.credits ?? 0;

  const run = useMutation({
    mutationFn: () =>
      startCompress(
        nodes.map((n) => n.id),
        { ...o, save },
      ),
    onSuccess: async (r) => {
      onClose();
      if (r.queued) toast(t.compress.started(r.queued));
      if (r.failed.length) {
        const first = t.compress.reasons[r.failed[0]!.reason] ?? '';
        toast(`${t.compress.someFailed(r.failed.length)}: ${first}`, { tone: 'error' });
      }
      await qc.invalidateQueries({ queryKey: ['compress'] });
    },
    onError: (e) => toast(t.compress.reasons[reasonCode(e)] ?? t.errors.generic, { tone: 'error' }),
  });

  return (
    <Dialog
      open
      title={t.compress.dialogTitle(nodes.length)}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending || balance < 1}>
            {t.compress.start}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="flex items-center justify-between rounded-xl bg-[var(--bg-subtle)] px-3 py-2">
          <span>
            {t.compress.credits(balance)} · {t.compress.estimate(nodes.length, hasVideo)}
          </span>
          {balance < nodes.length && (
            <Link to="/paket" className="font-medium text-brand-700 hover:underline">
              {t.compress.buyCredits}
            </Link>
          )}
        </p>
        <MediaOptionsForm value={o} onChange={setO} image={hasImage} video={hasVideo} />
        <fieldset>
          <legend className="mb-1 font-medium">{t.compress.save}</legend>
          {(['copy', 'replace'] as const).map((v) => (
            <label key={v} className="flex items-center gap-2 py-1">
              <input type="radio" name="save" checked={save === v} onChange={() => setSave(v)} />
              {v === 'copy' ? t.compress.saveCopy : t.compress.saveReplace}
            </label>
          ))}
          {save === 'replace' && (
            <p className="mt-1 text-xs text-amber-700">{t.compress.replaceWarn}</p>
          )}
        </fieldset>
      </div>
    </Dialog>
  );
}
