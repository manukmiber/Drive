// D2 (ADR-085): the "People" tab of Share: particular Zeiko accounts, each with view or edit.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../lib/i18n';
import {
  addPeople,
  listPeople,
  removePerson,
  setPersonRole,
  type NodeDto,
  type PersonDto,
} from '../../lib/files';
import { Button } from '../Button';
import { toast } from '../ui/Toast';
import { errorText } from './useNodeActions';

type Role = PersonDto['role'];

const select =
  'h-9 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 text-sm disabled:opacity-50';

export function SharePeople({ node }: { node: NodeDto }) {
  const qc = useQueryClient();
  const key = ['people', node.id];
  const q = useQuery({ queryKey: key, queryFn: () => listPeople(node.id) });
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<Role>('view');
  const done = (r: { items: PersonDto[] }) => qc.setQueryData(key, r);
  const add = useMutation({
    mutationFn: () => addPeople(node.id, emails.split(/[\s,;]+/).filter(Boolean), role),
    onSuccess: (r) => {
      done(r);
      setEmails('');
      toast(t.people.added);
    },
    onError: (e) => toast(errorText(e), { tone: 'error' }),
  });
  const change = useMutation({
    mutationFn: (a: { gid: string; role: Role }) => setPersonRole(node.id, a.gid, a.role),
    onSuccess: done,
    onError: (e) => toast(errorText(e), { tone: 'error' }),
  });
  const remove = useMutation({
    mutationFn: (gid: string) => removePerson(node.id, gid),
    onSuccess: async () => {
      toast(t.people.removed);
      await qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(errorText(e), { tone: 'error' }),
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--fg-muted)]">{t.people.hint}</p>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (emails.trim()) add.mutate();
        }}
      >
        <input
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder={t.people.emailsPlaceholder}
          aria-label={t.people.emails}
          type="text"
          inputMode="email"
          autoComplete="email"
          className="h-11 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className={`${select} flex-1`}
            aria-label={t.people.edit}
          >
            <option value="view">{t.people.view}</option>
            <option value="edit">{t.people.edit}</option>
          </select>
          <Button type="submit" disabled={!emails.trim() || add.isPending}>
            {t.people.add}
          </Button>
        </div>
      </form>
      {q.isPending ? (
        <p className="text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
      ) : q.isError ? (
        <p className="text-sm text-red-600">{errorText(q.error)}</p>
      ) : q.data.items.length === 0 ? (
        <p className="text-sm text-[var(--fg-muted)]">{t.people.none}</p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {q.data.items.map((p) => (
            <li key={p.id} className="flex items-center gap-2 py-2">
              <UserRound className="h-5 w-5 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{p.name || p.email}</p>
                <p className="truncate text-xs text-[var(--fg-muted)]">
                  {p.pending ? t.people.pending : p.email}
                </p>
              </div>
              <select
                value={p.role}
                disabled={change.isPending}
                onChange={(e) => change.mutate({ gid: p.id, role: e.target.value as Role })}
                className={select}
                aria-label={p.email ?? ''}
              >
                <option value="view">{t.people.roleView}</option>
                <option value="edit">{t.people.roleEdit}</option>
              </select>
              <button
                type="button"
                onClick={() => remove.mutate(p.id)}
                disabled={remove.isPending}
                className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
                aria-label={t.people.remove}
                title={t.people.remove}
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
