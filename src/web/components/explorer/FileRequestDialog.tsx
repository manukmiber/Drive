// D3 (ADR-086): "Request files" on a folder: make a link anyone can only upload through, and see
// or turn off the folder's links.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Inbox } from 'lucide-react';
import { useState } from 'react';
import { SHARE_PASSWORD_MIN } from '../../../shared/constants';
import { formatDateTime } from '../../../shared/format';
import { t } from '../../lib/i18n';
import {
  createFileRequest,
  listFileRequests,
  revokeFileRequest,
  type FileRequestDto,
  type NodeDto,
} from '../../lib/files';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';
import { toast } from '../ui/Toast';
import { errorText } from './useNodeActions';

const field =
  'mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm';
const MB = 1024 * 1024;

async function copy(text: string, ok: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok);
  } catch {
    // The link stays on screen to copy by hand.
  }
}

export function FileRequestList({ items }: { items: FileRequestDto[] }) {
  const qc = useQueryClient();
  const revoke = useMutation({
    mutationFn: revokeFileRequest,
    onSuccess: async () => {
      toast(t.requests.revoked);
      await qc.invalidateQueries({ queryKey: ['file-requests'] });
    },
    onError: (e) => toast(errorText(e), { tone: 'error' }),
  });
  if (!items.length) return <p className="text-sm text-[var(--fg-muted)]">{t.requests.none}</p>;
  return (
    <ul className="divide-y divide-[var(--border)]">
      {items.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
          <Inbox className="h-4 w-4 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{r.title}</p>
            <p className="text-xs text-[var(--fg-muted)]">
              {t.requests.states[r.state]} · {t.requests.files(r.fileCount)}
              {r.deadlineAt && ` · ${t.requests.until(formatDateTime(r.deadlineAt))}`}
            </p>
          </div>
          {r.state === 'open' && (
            <>
              <button
                type="button"
                onClick={() => void copy(r.url, t.requests.copied)}
                className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
                aria-label={t.requests.copy}
                title={t.requests.copy}
              >
                <Copy className="h-4 w-4" />
              </button>
              <Button
                variant="ghost"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(r.id)}
              >
                {t.requests.revoke}
              </Button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function FileRequestDialog({ folder, onClose }: { folder: NodeDto; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['file-requests', folder.id],
    queryFn: () => listFileRequests(folder.id),
  });
  const [title, setTitle] = useState(folder.name);
  const [message, setMessage] = useState('');
  const [deadline, setDeadline] = useState('');
  const [maxFiles, setMaxFiles] = useState('');
  const [maxMb, setMaxMb] = useState('');
  const [requireName, setRequireName] = useState(true);
  const [password, setPassword] = useState('');
  const [made, setMade] = useState<FileRequestDto | null>(null);
  const create = useMutation({
    mutationFn: () =>
      createFileRequest({
        folderId: folder.id,
        title: title.trim(),
        message: message.trim() || null,
        deadlineAt: deadline ? new Date(deadline).getTime() : null,
        maxFiles: maxFiles ? Number(maxFiles) : null,
        maxFileBytes: maxMb ? Math.round(Number(maxMb) * MB) : null,
        requireName,
        password: password || null,
      }),
    onSuccess: async ({ request }) => {
      setMade(request);
      await copy(request.url, t.requests.created);
      await qc.invalidateQueries({ queryKey: ['file-requests'] });
    },
    onError: (e) => toast(errorText(e), { tone: 'error' }),
  });
  return (
    <Dialog open title={t.requests.title(folder.name)} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-[var(--fg-muted)]">{t.requests.hint}</p>
        {made ? (
          <div className="flex gap-2">
            <input
              readOnly
              value={made.url}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={t.requests.copy}
              className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 text-sm"
            />
            <Button onClick={() => void copy(made.url, t.requests.copied)}>
              <Copy className="h-4 w-4" /> {t.requests.copy}
            </Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <label className="block text-sm">
              {t.requests.name}
              <input
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                className={field}
              />
            </label>
            <label className="block text-sm">
              {t.requests.message}
              <textarea
                value={message}
                maxLength={1000}
                rows={2}
                onChange={(e) => setMessage(e.target.value)}
                className="mt-1 w-full rounded-xl border border-[var(--border)] bg-transparent p-3 text-sm"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                {t.requests.deadline}
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  className={field}
                />
              </label>
              <label className="block text-sm">
                {t.requests.maxFiles}
                <input
                  type="number"
                  min={1}
                  inputMode="numeric"
                  value={maxFiles}
                  onChange={(e) => setMaxFiles(e.target.value)}
                  className={field}
                />
              </label>
              <label className="block text-sm">
                {t.requests.maxSizeMb}
                <input
                  type="number"
                  min={1}
                  inputMode="decimal"
                  value={maxMb}
                  onChange={(e) => setMaxMb(e.target.value)}
                  className={field}
                />
              </label>
              <label className="block text-sm">
                {t.requests.password}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={field}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={requireName}
                onChange={(e) => setRequireName(e.target.checked)}
              />
              {t.requests.requireName}
            </label>
            <Button
              type="submit"
              disabled={
                create.isPending ||
                !title.trim() ||
                (password.length > 0 && password.length < SHARE_PASSWORD_MIN)
              }
            >
              {t.requests.create}
            </Button>
          </form>
        )}
        <section aria-labelledby="minta-ada">
          <h3 id="minta-ada" className="mb-1 text-sm font-medium">
            {t.requests.existing}
          </h3>
          {list.isPending ? (
            <p className="text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
          ) : (
            <FileRequestList items={list.data?.items ?? []} />
          )}
        </section>
      </div>
    </Dialog>
  );
}
