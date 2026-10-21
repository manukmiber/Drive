// Full-screen preview (SPEC §8.4): bytes come from USERCONTENT_ORIGIN via short-lived signed URLs.
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useEffect } from 'react';
import { formatBytes } from '../../../shared/format';
import { t } from '../../../shared/strings.id';
import { downloadFile, previewInfo, type NodeDto } from '../../lib/files';
import { FileIcon } from '../FileIcon';

function TextView({ url }: { url: string }) {
  const q = useQuery({
    queryKey: ['preview-text', url],
    queryFn: () => fetch(url).then((r) => r.text()),
  });
  return (
    <pre className="max-h-full w-full max-w-5xl overflow-auto rounded-xl bg-[#0f1117] p-4 text-left font-mono text-xs leading-relaxed whitespace-pre-wrap text-gray-100">
      {q.data ?? t.common.loading}
    </pre>
  );
}

export function Preview({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: NodeDto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const node = items[index];
  const info = useQuery({
    queryKey: ['preview', node?.id],
    queryFn: () => previewInfo(node!.id),
    enabled: Boolean(node && node.kind === 'file'),
    staleTime: 60_000,
  });
  const prev = index > 0 ? index - 1 : null;
  const next = index < items.length - 1 ? index + 1 : null;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && prev !== null) onIndex(prev);
      if (e.key === 'ArrowRight' && next !== null) onIndex(next);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [prev, next, onIndex, onClose]);

  if (!node) return null;
  const d = info.data;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={node.name}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white"
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-2 hover:bg-white/10"
          aria-label={t.common.close}
        >
          <X className="h-5 w-5" />
        </button>
        <FileIcon node={node} />
        <span className="min-w-0 flex-1 truncate text-sm">{node.name}</span>
        <span className="hidden text-xs text-white/60 sm:inline">{formatBytes(node.size)}</span>
        <button
          type="button"
          onClick={() => void downloadFile(node.id)}
          className="rounded-full p-2 hover:bg-white/10"
          aria-label={t.common.download}
        >
          <Download className="h-5 w-5" />
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {prev !== null && (
          <button
            type="button"
            onClick={() => onIndex(prev)}
            className="absolute left-2 z-10 rounded-full bg-white/10 p-2 hover:bg-white/20"
            aria-label="Sebelumnya"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {info.isPending && <p className="text-sm text-white/70">{t.common.loading}</p>}
        {info.isError && <p className="text-sm text-red-300">{t.errors.generic}</p>}
        {d && d.kind === 'image' && (
          <img src={d.url} alt={node.name} className="max-h-full max-w-full object-contain" />
        )}
        {d && d.kind === 'video' && (
          <video src={d.url} controls autoPlay className="max-h-full max-w-full" />
        )}
        {d && d.kind === 'audio' && (
          <audio src={d.url} controls autoPlay className="w-full max-w-lg" />
        )}
        {d && d.kind === 'pdf' && (
          <iframe
            src={d.url}
            title={node.name}
            className="h-full w-full max-w-5xl rounded-lg bg-white"
          />
        )}
        {d && d.kind === 'text' && <TextView url={d.url} />}
        {d && !d.kind && (
          <div className="flex flex-col items-center gap-4 text-center">
            <FileIcon node={node} className="h-16 w-16" />
            <p className="text-sm text-white/70">{t.files.noPreview}</p>
            <button
              type="button"
              onClick={() => void downloadFile(node.id)}
              className="rounded-full bg-white px-5 py-2 text-sm font-medium text-gray-900"
            >
              {t.common.download}
            </button>
          </div>
        )}
        {next !== null && (
          <button
            type="button"
            onClick={() => onIndex(next)}
            className="absolute right-2 z-10 rounded-full bg-white/10 p-2 hover:bg-white/20"
            aria-label="Berikutnya"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>
  );
}
