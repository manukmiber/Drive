// Full-screen preview (SPEC §8.4): bytes come from USERCONTENT_ORIGIN via short-lived signed URLs.
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, Pencil, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { formatBytes } from '../../../shared/format';
import { t } from '../../lib/i18n';
import { downloadFile, previewInfo, type NodeDto } from '../../lib/files';
import { FileIcon } from '../FileIcon';
import { editable, isDoc, maxBytes, toolFor } from '../../editors/files';
import { useConfig } from '../../editors/ui';

// pdf.js shows PDFs (SPEC §8.4; Chrome on Android has no PDF viewer for iframes). It loads only for a
// PDF, and the browser's own viewer is the fallback.
const PdfPreview = lazy(() =>
  import('../../editors/pdf/PdfView').then((m) => ({ default: m.PdfPreview })),
);

function PdfFrame({ url, title }: { url: string; title: string }) {
  const [fallback, setFallback] = useState(false);
  const fail = useCallback(() => setFallback(true), []);
  if (fallback)
    return (
      <iframe src={url} title={title} className="h-full w-full max-w-5xl rounded-lg bg-white" />
    );
  return (
    <Suspense fallback={<p className="text-sm text-white/70">{t.common.loading}</p>}>
      <PdfPreview url={url} onFail={fail} />
    </Suspense>
  );
}

// A .docx is drawn by docx-preview, in the app (ADR-051); a file too big for that can be downloaded.
const DocxPreview = lazy(() =>
  import('../../editors/doc/DocxPreview').then((m) => ({ default: m.DocxPreview })),
);

function DocxFrame({ url, node, onEdit }: { url: string; node: NodeDto; onEdit?: () => void }) {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const max = maxBytes(useConfig(), 'doc');
  if (failed || !max || node.size > max) return <NoPreview node={node} onEdit={onEdit} />;
  return (
    <Suspense fallback={<p className="text-sm text-white/70">{t.common.loading}</p>}>
      <DocxPreview url={url} onFail={fail} />
    </Suspense>
  );
}

/** No picture of the file; one an editor opens (a spreadsheet, a ZIP) can be opened there. */
function NoPreview({ node, onEdit }: { node: NodeDto; onEdit?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <FileIcon node={node} className="h-16 w-16" />
      <p className="text-sm text-white/70">{t.files.noPreview}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="rounded-full bg-white px-5 py-2 text-sm font-medium text-gray-900"
          >
            {t.editor.openInEditor}
          </button>
        )}
        <button
          type="button"
          onClick={() => void downloadFile(node.id)}
          className={
            onEdit
              ? 'rounded-full border border-white/40 px-5 py-2 text-sm font-medium text-white'
              : 'rounded-full bg-white px-5 py-2 text-sm font-medium text-gray-900'
          }
        >
          {t.common.download}
        </button>
      </div>
    </div>
  );
}

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
  onEdit,
}: {
  items: NodeDto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Opens the photo, video or PDF editor (ADR-050). */
  onEdit?: (node: NodeDto) => void;
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
  const editIt =
    onEdit && editable(node) && toolFor(node.mime, node.name) ? () => onEdit(node) : undefined;
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
        {editIt && (
          <button
            type="button"
            onClick={editIt}
            aria-label={t.editor.edit}
            className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm hover:bg-white/10"
          >
            <Pencil className="h-4 w-4" />
            <span className="hidden sm:inline">{t.editor.edit}</span>
          </button>
        )}
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
            aria-label={t.a11y.previous}
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
        {d && d.kind === 'pdf' && <PdfFrame key={d.url} url={d.url} title={node.name} />}
        {d && d.kind === 'text' && <TextView url={d.url} />}
        {d &&
          !d.kind &&
          (isDoc(node.mime, node.name) ? (
            <DocxFrame key={d.url} url={d.url} node={node} onEdit={editIt} />
          ) : (
            <NoPreview node={node} onEdit={editIt} />
          ))}
        {next !== null && (
          <button
            type="button"
            onClick={() => onIndex(next)}
            className="absolute right-2 z-10 rounded-full bg-white/10 p-2 hover:bg-white/20"
            aria-label={t.a11y.next}
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>
  );
}
