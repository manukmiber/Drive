import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { formatBytes, formatDate } from '../../shared/format';
import { t } from '../../shared/strings.id';
import { Button } from '../components/Button';
import { FileIcon } from '../components/FileIcon';
import { Dialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { deleteForever, emptyTrash, filesKeys, listTrash, restoreNodes } from '../lib/files';
import { meQueryKey } from '../lib/session';

export function Trash() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: filesKeys.trash, queryFn: listTrash });
  const [confirm, setConfirm] = useState<null | { ids: string[] } | 'all'>(null);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: filesKeys.trash }),
      qc.invalidateQueries({ queryKey: ['children'] }),
      qc.invalidateQueries({ queryKey: meQueryKey }),
    ]);
  };

  const restore = useMutation({
    mutationFn: (ids: string[]) => restoreNodes(ids),
    onSuccess: async () => {
      toast(t.files.restored);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (what: { ids: string[] } | 'all') =>
      what === 'all' ? emptyTrash() : deleteForever(what.ids),
    onSuccess: async () => {
      toast(t.files.deletedForever);
      await refresh();
    },
    onError: () => toast(t.errors.generic, { tone: 'error' }),
  });

  const items = q.data?.items ?? [];

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">{t.nav.trash}</h1>
        {items.length > 0 && (
          <Button variant="secondary" onClick={() => setConfirm('all')}>
            {t.files.emptyTrashButton}
          </Button>
        )}
      </div>
      {q.data && (
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          {t.files.trashNote(q.data.retentionDays)}
        </p>
      )}
      {q.isPending && <p className="mt-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
      {q.isSuccess && !items.length && (
        <p className="mt-10 text-center text-sm text-[var(--fg-muted)]">{t.files.emptyTrash}</p>
      )}
      <ul className="mt-4 divide-y divide-[var(--border)]">
        {items.map((n) => (
          <li key={n.id} className="flex items-center gap-3 py-3">
            <FileIcon node={n} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{n.name}</p>
              <p className="text-xs text-[var(--fg-muted)]">
                {t.files.trashedOn(formatDate(n.trashedAt ?? n.updatedAt))}
                {n.kind === 'file' && ` · ${formatBytes(n.size)}`}
              </p>
            </div>
            <button
              type="button"
              className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
              onClick={() => restore.mutate([n.id])}
              aria-label={`${t.files.restore} ${n.name}`}
            >
              <RotateCcw className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded-full p-2 text-red-600 hover:bg-[var(--bg-subtle)]"
              onClick={() => setConfirm({ ids: [n.id] })}
              aria-label={`${t.files.deleteForever} ${n.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={confirm !== null}
        title={t.files.deleteForever}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm) remove.mutate(confirm);
                setConfirm(null);
              }}
            >
              {t.files.deleteForever}
            </Button>
          </>
        }
      >
        <p>{confirm === 'all' ? t.files.emptyTrashConfirm : t.files.deleteForeverConfirm}</p>
      </Dialog>
    </div>
  );
}
