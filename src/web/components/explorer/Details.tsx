// Right-hand Detail panel (SPEC §8.1).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, X } from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatDate, formatDateTime } from '../../../shared/format';
import { addDaysWib, wibDate } from '../../../shared/time';
import { useCatalog } from '../../lib/catalog';
import { t } from '../../lib/i18n';
import { nodeInfo, setExpiry, type NodeDto } from '../../lib/files';
import { useMe } from '../../lib/session';
import { Button } from '../Button';
import { FileIcon } from '../FileIcon';
import { toast } from '../ui/Toast';

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
          <Expiry
            key={n.id}
            node={n}
            canSet={Boolean(q.data?.access.remove) && n.trashedAt === null}
          />
        </>
      )}
    </aside>
  );
}

/** D12 (ADR-082): the day it goes to the Trash by itself, set by whoever may remove it. */
function Expiry({ node, canSet }: { node: NodeDto; canSet: boolean }) {
  const qc = useQueryClient();
  const [tomorrow] = useState(() => addDaysWib(wibDate(Date.now()), 1));
  const [date, setDate] = useState(() => (node.expiresAt ? wibDate(node.expiresAt) : ''));
  const save = useMutation({
    mutationFn: (value: string | null) => setExpiry(node.id, value),
    onSuccess: async (r) => {
      toast(r.node.expiresAt ? t.expiry.saved : t.expiry.cleared);
      if (!r.node.expiresAt) setDate('');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['node', node.id] }),
        qc.invalidateQueries({ queryKey: ['children'] }),
      ]);
    },
    onError: () => toast(t.errors.generic, { tone: 'error' }),
  });
  if (!canSet && node.expiresAt === null) return null;
  return (
    <section className="mt-5 border-t border-[var(--border)] pt-4" aria-labelledby="expiry">
      <h3 id="expiry" className="flex items-center gap-2 text-sm font-medium">
        <Clock className="h-4 w-4" aria-hidden="true" /> {t.expiry.title}
      </h3>
      <p className="mt-1 text-sm">
        {node.expiresAt ? t.expiry.on(formatDate(node.expiresAt)) : t.expiry.none}
      </p>
      {canSet && (
        <>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.expiry.hint}</p>
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (date) save.mutate(date);
            }}
          >
            <input
              type="date"
              min={tomorrow}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label={t.expiry.title}
              className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
            />
            <Button type="submit" variant="secondary" disabled={!date || save.isPending}>
              {t.expiry.set}
            </Button>
            {node.expiresAt !== null && (
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                {t.expiry.clear}
              </Button>
            )}
          </form>
        </>
      )}
    </section>
  );
}
