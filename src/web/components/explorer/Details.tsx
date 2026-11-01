// Right-hand Detail panel (SPEC §8.1).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, History, X } from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatDate, formatDateTime } from '../../../shared/format';
import { addDaysWib, wibDate } from '../../../shared/time';
import { useCatalog } from '../../lib/catalog';
import { t } from '../../lib/i18n';
import {
  deleteVersion,
  keepVersion,
  listVersions,
  nodeActivity,
  nodeInfo,
  restoreVersion,
  setExpiry,
  versionUrl,
  type NodeDto,
  type VersionDto,
} from '../../lib/files';
import { useMe } from '../../lib/session';
import { ActivityList } from '../ActivityList';
import { Button } from '../Button';
import { FileIcon } from '../FileIcon';
import { Dialog } from '../ui/Dialog';
import { toast } from '../ui/Toast';

export function Details({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const catalog = useCatalog();
  const q = useQuery({ queryKey: ['node', id], queryFn: () => nodeInfo(id) });
  const [tab, setTab] = useState<'details' | 'activity' | 'versions'>('details');
  const activity = useQuery({
    queryKey: ['activity', id],
    queryFn: () => nodeActivity(id),
    enabled: tab === 'activity',
  });
  const n = q.data?.node;
  const tabs =
    n?.kind === 'file'
      ? (['details', 'activity', 'versions'] as const)
      : (['details', 'activity'] as const);
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
      <div role="tablist" className="mt-3 flex gap-1 rounded-xl bg-[var(--bg-subtle)] p-1 text-sm">
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`flex-1 rounded-lg px-3 py-1.5 ${tab === k ? 'bg-[var(--card)] font-medium shadow-sm' : 'text-[var(--fg-muted)]'}`}
          >
            {k === 'details'
              ? t.activity.detailsTab
              : k === 'activity'
                ? t.activity.tab
                : t.versions.tab}
          </button>
        ))}
      </div>
      {tab === 'activity' &&
        (activity.isPending ? (
          <p className="mt-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
        ) : activity.isError ? (
          <p className="mt-6 text-sm text-red-600">{t.errors.generic}</p>
        ) : (
          <div className="mt-3">
            <ActivityList items={activity.data.items} />
          </div>
        ))}
      {tab === 'versions' && n?.kind === 'file' && q.data && (
        <Versions
          node={n}
          canEdit={q.data.access.edit && n.trashedAt === null}
          canRemove={q.data.access.remove && n.trashedAt === null}
        />
      )}
      {tab === 'details' && n && (
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

/** D1 (ADR-084): a file's earlier contents, newest first, with what the person may do to each. */
function Versions({
  node,
  canEdit,
  canRemove,
}: {
  node: NodeDto;
  canEdit: boolean;
  canRemove: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['versions', node.id], queryFn: () => listVersions(node.id) });
  const [doomed, setDoomed] = useState<VersionDto | null>(null);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['versions', node.id] }),
      qc.invalidateQueries({ queryKey: ['node', node.id] }),
      qc.invalidateQueries({ queryKey: ['children'] }),
    ]);
  const act = useMutation({
    mutationFn: async (a: { kind: 'restore' | 'keep' | 'unkeep' | 'delete'; v: VersionDto }) => {
      if (a.kind === 'restore') await restoreVersion(node.id, a.v.id);
      else if (a.kind === 'delete') await deleteVersion(node.id, a.v.id);
      else await keepVersion(node.id, a.v.id, a.kind === 'keep');
      return a.kind;
    },
    onSuccess: async (kind) => {
      if (kind === 'restore') toast(t.versions.restored);
      if (kind === 'delete') toast(t.versions.deleted);
      await refresh();
    },
    onError: () => toast(t.errors.generic, { tone: 'error' }),
  });
  async function download(v: VersionDto) {
    try {
      const { url } = await versionUrl(node.id, v.id);
      window.location.assign(url);
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    }
  }
  if (q.isPending) return <p className="mt-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (q.isError) return <p className="mt-6 text-sm text-red-600">{t.errors.generic}</p>;
  const small = 'h-8 rounded-full border border-[var(--border)] px-3 text-xs disabled:opacity-50';
  return (
    <section className="mt-4" aria-labelledby="versi">
      <h3 id="versi" className="flex items-center gap-2 text-sm font-medium">
        <History className="h-4 w-4" aria-hidden="true" /> {t.versions.title}
      </h3>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">
        {t.versions.note(q.data.keep, q.data.days)}
      </p>
      {q.data.items.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--fg-muted)]">{t.versions.none}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {q.data.items.map((v) => (
            <li key={v.id} className="rounded-xl border border-[var(--border)] p-3">
              <p className="text-sm font-medium">
                {t.versions.item(v.number)} · {formatBytes(v.size)}
                {v.kept && (
                  <span className="ml-2 rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-xs font-normal">
                    {t.versions.kept}
                  </span>
                )}
              </p>
              <p className="text-xs text-[var(--fg-muted)]">
                {t.versions.savedOn(formatDateTime(v.savedAt))} ·{' '}
                {t.versions.goesOn(formatDate(v.expiresAt))}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={small} onClick={() => void download(v)}>
                  {t.versions.download}
                </button>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      className={small}
                      disabled={act.isPending}
                      onClick={() => act.mutate({ kind: 'restore', v })}
                    >
                      {t.versions.restore}
                    </button>
                    <button
                      type="button"
                      className={small}
                      disabled={act.isPending}
                      onClick={() => act.mutate({ kind: v.kept ? 'unkeep' : 'keep', v })}
                    >
                      {v.kept ? t.versions.unkeep : t.versions.keep}
                    </button>
                  </>
                )}
                {canRemove && (
                  <button
                    type="button"
                    className={`${small} text-red-600`}
                    disabled={act.isPending}
                    onClick={() => setDoomed(v)}
                  >
                    {t.versions.delete}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={doomed !== null}
        title={doomed ? t.versions.item(doomed.number) : ''}
        onClose={() => setDoomed(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDoomed(null)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={() => {
                const v = doomed!;
                setDoomed(null);
                act.mutate({ kind: 'delete', v });
              }}
            >
              {t.versions.delete}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t.versions.deleteConfirm}</p>
      </Dialog>
    </section>
  );
}
