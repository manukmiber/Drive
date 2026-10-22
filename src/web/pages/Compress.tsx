// /kompres — credits, standalone compression, and job history (SPEC §11).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Download, FolderOpen, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { formatBytes, formatDateTime } from '../../shared/format';
import { t } from '../../shared/strings.id';
import { Button } from '../components/Button';
import { FileIcon } from '../components/FileIcon';
import { MediaOptionsForm, defaultMediaOptions } from '../components/explorer/MediaOptionsForm';
import { toast } from '../components/ui/Toast';
import { api } from '../lib/api';
import {
  compressStandalone,
  listCompressJobs,
  mediaKind,
  reasonCode,
  standaloneResultUrl,
  type CompressJob,
  type MediaOptions,
} from '../lib/compress';
import { nodeInfo } from '../lib/files';
import type { Catalog } from '../lib/types';

const card = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5';
const active = (j: CompressJob) => ['uploading', 'queued', 'running'].includes(j.status);

export function Compress() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [o, setO] = useState<MediaOptions>(defaultMediaOptions);
  const [progress, setProgress] = useState<number | null>(null);
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/api/public/catalog'),
  });
  const q = useQuery({
    queryKey: ['compress'],
    queryFn: listCompressJobs,
    refetchInterval: (query) => (query.state.data?.jobs.some(active) ? 3000 : false),
  });
  const max = catalog.data?.config.standalone_compress_max_bytes ?? 0;

  async function onFile(file: File) {
    if (!mediaKind(file.name, file.type))
      return toast(t.compress.reasons.NOT_MEDIA!, { tone: 'error' });
    if (max && file.size > max) return toast(t.errors.fileTooLarge, { tone: 'error' });
    setProgress(0);
    try {
      await compressStandalone(file, o, setProgress);
      toast(t.compress.started(1));
    } catch (e) {
      toast(t.compress.reasons[reasonCode(e)] ?? t.errors.generic, { tone: 'error' });
    } finally {
      setProgress(null);
      await qc.invalidateQueries({ queryKey: ['compress'] });
    }
  }

  async function openResult(j: CompressJob) {
    if (!j.outNodeId) return;
    const info = await nodeInfo(j.outNodeId).catch(() => null);
    const node = info?.node;
    if (node?.parentId)
      await navigate({ to: '/drive/$folderId', params: { folderId: node.parentId } });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">{t.compress.title}</h1>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.compress.subtitle}</p>
        </div>
        <p className="text-sm">
          <span className="font-medium">{t.compress.credits(q.data?.credits ?? 0)}</span>
          {' · '}
          <Link to="/paket" className="text-brand-700 hover:underline">
            {t.compress.buyCredits}
          </Link>
        </p>
      </header>

      <section className={card} aria-labelledby="standalone">
        <h2 id="standalone" className="font-medium">
          {t.compress.standaloneTitle}
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          {t.compress.standaloneBody(max ? formatBytes(max) : '—')}
        </p>
        <div className="mt-4 text-sm">
          <MediaOptionsForm value={o} onChange={setO} image video />
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onFile(f);
          }}
        />
        <Button
          className="mt-4"
          disabled={progress !== null || (q.data?.credits ?? 0) < 1}
          onClick={() => fileInput.current?.click()}
        >
          <Upload className="h-4 w-4" />
          {progress === null
            ? t.compress.chooseFile
            : t.compress.uploading(Math.round(progress * 100))}
        </Button>
      </section>

      <section className={card} aria-labelledby="jobs">
        <h2 id="jobs" className="font-medium">
          {t.compress.jobs}
        </h2>
        {q.data && !q.data.jobs.length && (
          <p className="mt-3 text-sm text-[var(--fg-muted)]">{t.compress.empty}</p>
        )}
        <ul className="mt-2 divide-y divide-[var(--border)]">
          {q.data?.jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-3 py-3 text-sm">
              <FileIcon
                node={{
                  kind: 'file',
                  name: j.name,
                  mime: j.kind === 'image' ? 'image/*' : 'video/*',
                }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{j.name}</p>
                <p className="text-xs text-[var(--fg-muted)]">
                  {t.compress.status[j.status]}
                  {j.status === 'done' && j.savedBytes
                    ? ` · ${t.compress.saved(formatBytes(j.savedBytes))}`
                    : ''}
                  {j.error && j.status !== 'done'
                    ? ` · ${t.compress.reasons[j.error] ?? j.error}`
                    : ''}
                  {' · '}
                  {formatDateTime(j.createdAt)}
                </p>
              </div>
              {j.status === 'done' && j.standalone && (
                <a
                  href={standaloneResultUrl(j.id)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-brand-700 hover:bg-[var(--bg-subtle)]"
                >
                  <Download className="h-4 w-4" />
                  {t.compress.download}
                </a>
              )}
              {j.status === 'done' && !j.standalone && j.outNodeId && (
                <button
                  type="button"
                  onClick={() => void openResult(j)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-brand-700 hover:bg-[var(--bg-subtle)]"
                >
                  <FolderOpen className="h-4 w-4" />
                  {t.compress.openResult}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
