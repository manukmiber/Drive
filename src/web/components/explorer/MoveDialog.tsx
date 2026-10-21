// "Pindahkan ke…" folder picker (SPEC §8.2).
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Folder } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../../shared/strings.id';
import { listChildren } from '../../lib/files';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';

export function MoveDialog({
  rootId,
  familyRootId,
  excludeIds,
  onCancel,
  onMove,
}: {
  rootId: string;
  familyRootId?: string | null;
  excludeIds: string[];
  onCancel: () => void;
  onMove: (targetId: string) => void;
}) {
  const [folderId, setFolderId] = useState(rootId);
  const q = useQuery({
    queryKey: ['move-picker', folderId],
    queryFn: () => listChildren(folderId, 'name', 'asc'),
  });
  const folders = (q.data?.items ?? []).filter(
    (i) => i.kind === 'folder' && !excludeIds.includes(i.id),
  );
  const path = q.data?.path ?? [];
  return (
    <Dialog
      open
      title={t.files.moveTo}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => onMove(folderId)}>{t.files.moveHere}</Button>
        </>
      }
    >
      {familyRootId && (
        <div className="mb-3 flex gap-2">
          {[
            [rootId, t.nav.myDrive],
            [familyRootId, t.nav.familyDrive],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFolderId(id!)}
              className={`rounded-full border px-3 py-1 text-xs ${path[0]?.id === id ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-[var(--border)]'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <nav className="mb-2 flex flex-wrap items-center gap-1 text-xs text-[var(--fg-muted)]">
        {path.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3" />}
            <button type="button" className="hover:underline" onClick={() => setFolderId(c.id)}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>
      <ul className="max-h-64 overflow-auto rounded-xl border border-[var(--border)]">
        {folders.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => setFolderId(f.id)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--bg-subtle)]"
            >
              <Folder className="h-4 w-4 text-brand-600" />
              <span className="flex-1 truncate">{f.name}</span>
              <ChevronRight className="h-4 w-4 text-[var(--fg-muted)]" />
            </button>
          </li>
        ))}
        {q.isSuccess && !folders.length && (
          <li className="px-3 py-4 text-center text-xs text-[var(--fg-muted)]">—</li>
        )}
      </ul>
    </Dialog>
  );
}
