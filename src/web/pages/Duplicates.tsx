// D11 (ADR-081): files with the same content in the person's own pool. They pick the copy to
// keep and the others go to the Trash.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatBytes, formatDate } from '../../shared/format';
import { t } from '../lib/i18n';
import { Button } from '../components/Button';
import { FileIcon } from '../components/FileIcon';
import { toast } from '../components/ui/Toast';
import { findDuplicates, filesKeys, trashNodes, type DuplicateGroup } from '../lib/files';
import { meQueryKey } from '../lib/session';

const duplicatesKey = ['duplicates'] as const;

export function Duplicates() {
  const q = useQuery({ queryKey: duplicatesKey, queryFn: findDuplicates });
  const groups = q.data?.groups ?? [];

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <h1 className="text-xl font-semibold">{t.duplicates.title}</h1>
      <p className="mt-2 text-sm text-[var(--fg-muted)]">{t.duplicates.intro}</p>
      {q.data && q.data.saving > 0 && (
        <p className="mt-3 text-sm font-semibold text-brand-700">
          {t.duplicates.total(formatBytes(q.data.saving))}
        </p>
      )}
      {q.isPending && <p className="mt-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
      {q.isError && <p className="mt-6 text-sm text-red-600">{t.errors.generic}</p>}
      {q.isSuccess && !groups.length && (
        <p className="mt-10 text-center text-sm text-[var(--fg-muted)]">{t.duplicates.none}</p>
      )}
      <div className="mt-4 space-y-4">
        {groups.map((g) => (
          <Group key={g.items.map((n) => n.id).join()} group={g} />
        ))}
      </div>
    </div>
  );
}

function Group({ group }: { group: DuplicateGroup }) {
  const qc = useQueryClient();
  const [keep, setKeep] = useState(
    () => (group.items.find((n) => !n.canRemove) ?? group.items[0])!.id,
  );
  const others = group.items.filter((n) => n.id !== keep && n.canRemove).map((n) => n.id);

  const move = useMutation({
    mutationFn: () => trashNodes(others),
    onSuccess: async (r) => {
      toast(t.duplicates.trashed(r.count));
      await Promise.all([
        qc.invalidateQueries({ queryKey: duplicatesKey }),
        qc.invalidateQueries({ queryKey: filesKeys.trash }),
        qc.invalidateQueries({ queryKey: ['children'] }),
        qc.invalidateQueries({ queryKey: meQueryKey }),
      ]);
    },
    onError: () => toast(t.errors.generic, { tone: 'error' }),
  });

  return (
    <section className="z-card rounded-2xl p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{group.items[0]!.name}</h2>
        <p className="text-xs text-[var(--fg-muted)]">
          {t.duplicates.group(group.items.length, formatBytes(group.size))}
        </p>
      </div>
      <ul className="mt-2 divide-y divide-[var(--border)]">
        {group.items.map((n) => (
          <li key={n.id}>
            <label className="flex cursor-pointer items-center gap-3 py-2.5">
              <input
                type="radio"
                name={`keep-${group.items[0]!.id}`}
                checked={keep === n.id}
                onChange={() => setKeep(n.id)}
                className="h-4 w-4 accent-brand-600"
                aria-label={`${t.duplicates.keep}: ${n.name}`}
              />
              <FileIcon node={n} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{n.name}</span>
                <span className="block truncate text-xs text-[var(--fg-muted)]">
                  {n.path.map((c) => c.name).join(' / ')} · {formatDate(n.createdAt)}
                </span>
              </span>
              <span className="shrink-0 text-xs text-[var(--fg-muted)]">
                {keep === n.id ? t.duplicates.kept : !n.canRemove ? t.duplicates.notYours : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end">
        <Button
          variant="secondary"
          disabled={!others.length || move.isPending}
          onClick={() => move.mutate()}
        >
          {t.duplicates.trashOthers(others.length)}
        </Button>
      </div>
    </section>
  );
}
