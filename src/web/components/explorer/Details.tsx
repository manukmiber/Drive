// Right-hand Detail panel (SPEC §8.1).
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { formatBytes, formatDateTime } from '../../../shared/format';
import { useCatalog } from '../../lib/catalog';
import { t } from '../../lib/i18n';
import { nodeInfo } from '../../lib/files';
import { useMe } from '../../lib/session';
import { FileIcon } from '../FileIcon';

export function Details({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const catalog = useCatalog();
  const q = useQuery({ queryKey: ['node', id], queryFn: () => nodeInfo(id) });
  const n = q.data?.node;
  // "Safe" only when an antivirus looked; the basic check says what it is (ADR-056).
  const scan =
    n?.scanStatus === 'clean' && catalog.data?.capabilities?.antivirus === false
      ? 'basic'
      : (n?.scanStatus ?? 'pending');
  const row = (label: string, value: string) => (
    <div>
      <dt className="text-xs text-[var(--fg-muted)]">{label}</dt>
      <dd className="text-sm break-words">{value}</dd>
    </div>
  );
  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 w-[min(92vw,22rem)] overflow-auto border-l border-[var(--border)] bg-[var(--card)] p-5 shadow-xl"
      aria-label={t.files.detailsTitle}
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-semibold">{t.files.detailsTitle}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
          aria-label={t.common.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {n && (
        <>
          <div className="my-5 flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-[var(--bg-subtle)]">
            {n.hasThumb ? (
              <img
                src={`/api/files/${n.id}/thumbnail`}
                alt=""
                className="h-full w-full object-contain"
              />
            ) : (
              <FileIcon node={n} className="h-12 w-12" />
            )}
          </div>
          <p className="font-medium break-words">{n.name}</p>
          <dl className="mt-4 space-y-3">
            {row(t.files.type, n.kind === 'folder' ? 'Folder' : (n.mime ?? '—'))}
            {n.kind === 'file' && row(t.files.colSize, formatBytes(n.size))}
            {row(
              t.files.location,
              (q.data?.path ?? [])
                .slice(0, -1)
                .map((c) => c.name)
                .join(' / ') || '—',
            )}
            {row(t.files.owner, n.ownerId === me.data?.user.id ? t.files.you : n.ownerId)}
            {row(t.files.space, n.space === 'family' ? t.files.spaceFamily : t.files.spacePersonal)}
            {row(t.files.created, formatDateTime(n.createdAt))}
            {row(t.files.modified, formatDateTime(n.updatedAt))}
            {n.kind === 'file' && row(t.files.scanStatus, t.files.scanLabels[scan] ?? '—')}
          </dl>
        </>
      )}
    </aside>
  );
}
