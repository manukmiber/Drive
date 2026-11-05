// Who is on a team or in a Space, and what the person looking may do about it (W1b, ADR-098). The
// server decides every rule (services/spaces.ts); this only offers what the rules allow, so a
// refusal is rare and is said in plain words (spaceError).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Crown, MoreHorizontal, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { formatDate } from '../../../shared/format';
import { sendJson } from '../../lib/api';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import {
  initial,
  personName,
  spaceError,
  spaceKey,
  spacesKey,
  teamKey,
  type InviteDto,
  type MemberDto,
  type SpaceView,
  type TeamView,
} from '../../lib/spaces';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';
import { Menu, type MenuItem } from '../ui/Menu';
import { toast } from '../ui/Toast';
import { useConfirm } from './Confirm';

type Scope =
  { kind: 'team'; id: string; view: TeamView } | { kind: 'space'; id: string; view: SpaceView };

const roleChip: Record<string, string> = {
  owner: 'bg-amber-400/15 text-amber-700 dark:text-amber-300',
  admin: 'bg-[var(--accent-soft)] text-brand-700',
  member: 'bg-[var(--bg-subtle)] text-[var(--fg-muted)]',
  guest: 'bg-teal-500/10 text-teal-700 dark:text-teal-300',
};

export function RoleChip({ role }: { role: string }) {
  const label = t.spaces.roles[role as keyof typeof t.spaces.roles] ?? role;
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', roleChip[role])}>
      {label}
    </span>
  );
}

export function People({
  scope,
  me,
  online,
  readOnly,
}: {
  scope: Scope;
  me: string;
  /** Who is in the Space's live room now, when it is connected. */
  online?: readonly string[];
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [ask, confirmUi] = useConfirm();
  const base = scope.kind === 'team' ? `/api/teams/${scope.id}` : `/api/spaces/${scope.id}`;
  const key = scope.kind === 'team' ? teamKey(scope.id) : spaceKey(scope.id);

  const myTeamRole = scope.kind === 'team' ? scope.view.team.role : null;
  const mySpaceRole = scope.kind === 'space' ? scope.view.space.role : null;
  const manager = myTeamRole === 'owner' || myTeamRole === 'admin' || mySpaceRole === 'admin';

  const put = (view: TeamView | SpaceView) => {
    qc.setQueryData(key, view);
    void qc.invalidateQueries({ queryKey: spacesKey, exact: true });
  };
  const act = useMutation({
    mutationFn: (a: { method: 'PATCH' | 'DELETE' | 'POST'; path: string; body?: unknown }) =>
      sendJson<TeamView | SpaceView | undefined>(a.method, `${base}${a.path}`, a.body),
    onSuccess: (view) => {
      if (view) put(view);
      else void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast(spaceError(e), { tone: 'error' }),
  });

  const members = scope.view.members;
  const invites = scope.view.invites;

  function itemsFor(m: MemberDto): MenuItem[] {
    const name = personName(m);
    const items: MenuItem[] = [];
    if (readOnly || m.userId === me) return items;
    if (scope.kind === 'team') {
      if (m.role === 'owner') return items;
      if (myTeamRole === 'owner') {
        items.push({
          label: m.role === 'admin' ? t.spaces.people.makeMember : t.spaces.people.makeAdmin,
          onSelect: () =>
            act.mutate({
              method: 'PATCH',
              path: `/members/${m.userId}`,
              body: { role: m.role === 'admin' ? 'member' : 'admin' },
            }),
        });
        items.push({
          label: t.spaces.people.transfer,
          onSelect: () =>
            ask({
              title: t.spaces.people.transfer,
              body: t.spaces.people.transferConfirm(name),
              run: () => act.mutate({ method: 'POST', path: '/owner', body: { userId: m.userId } }),
            }),
        });
      }
      if (myTeamRole === 'owner' || (myTeamRole === 'admin' && m.role === 'member'))
        items.push({
          label: t.spaces.people.remove,
          danger: true,
          onSelect: () =>
            ask({
              title: t.spaces.people.remove,
              body: t.spaces.people.removeConfirm(name),
              run: () => act.mutate({ method: 'DELETE', path: `/members/${m.userId}` }),
            }),
        });
      return items;
    }
    // In a Space, the team's owner and admins are there by being on the team: nothing to change here.
    if (mySpaceRole !== 'admin' || m.role === 'admin') return items;
    items.push({
      label: m.role === 'guest' ? t.spaces.people.makeMember : t.spaces.people.makeGuest,
      onSelect: () =>
        act.mutate({
          method: 'PATCH',
          path: `/members/${m.userId}`,
          body: { role: m.role === 'guest' ? 'member' : 'guest' },
        }),
    });
    items.push({
      label: t.spaces.people.remove,
      danger: true,
      onSelect: () =>
        ask({
          title: t.spaces.people.remove,
          body: t.spaces.people.removeConfirm(name),
          run: () => act.mutate({ method: 'DELETE', path: `/members/${m.userId}` }),
        }),
    });
    return items;
  }

  const canRevoke = (i: InviteDto) =>
    !readOnly && manager && (i.role !== 'admin' || myTeamRole === 'owner');

  return (
    <section className="z-card rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 font-medium">
          {scope.kind === 'team' ? t.spaces.people.teamTitle : t.spaces.people.spaceTitle}
        </h2>
        {manager && !readOnly && (
          <Button onClick={() => setAdding(true)}>
            <UserPlus className="h-4 w-4" /> {t.spaces.people.add}
          </Button>
        )}
      </div>
      {scope.kind === 'space' && (
        <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.spaces.people.adminsEverywhere}</p>
      )}
      <ul className="mt-3 divide-y divide-[var(--border)]">
        {members.map((m) => (
          <PersonRow
            key={`${m.userId}-${m.role}`}
            m={m}
            me={me}
            online={online?.includes(m.userId) ?? false}
            items={itemsFor(m)}
          />
        ))}
      </ul>
      {invites.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-[var(--fg-muted)]">{t.spaces.people.pending}</p>
          <ul className="mt-1 divide-y divide-[var(--border)]">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <RoleChip role={i.role} />
                <span className="text-xs text-[var(--fg-muted)]">
                  {t.spaces.people.expires(formatDate(i.expiresAt))}
                </span>
                {canRevoke(i) && (
                  <button
                    type="button"
                    className="text-xs font-medium text-red-600 hover:underline"
                    onClick={() =>
                      act.mutate(
                        { method: 'DELETE', path: `/invites/${i.id}` },
                        { onSuccess: () => toast(t.spaces.people.revoked) },
                      )
                    }
                  >
                    {t.spaces.people.revoke}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <AddPerson
        open={adding}
        scope={scope}
        onClose={() => setAdding(false)}
        onDone={(view, email) => {
          put(view);
          setAdding(false);
          const waiting = view.invites.some((i) => i.email === email);
          toast(waiting ? t.spaces.people.invited(email) : t.spaces.people.added(email));
        }}
      />
      {confirmUi}
    </section>
  );
}

function PersonRow({
  m,
  me,
  online,
  items,
}: {
  m: MemberDto;
  me: string;
  online: boolean;
  items: MenuItem[];
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const name = personName(m);
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="relative">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800 dark:bg-brand-800/50">
          {initial(name)}
        </span>
        {online && (
          <span
            className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-[var(--card)]"
            aria-label={t.spaces.people.online}
            title={t.spaces.people.online}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm">
          {name}
          {m.userId === me && (
            <span className="text-xs text-[var(--fg-muted)]">({t.spaces.you})</span>
          )}
          {m.role === 'owner' && (
            <Crown className="h-3.5 w-3.5 text-amber-500" aria-label={t.spaces.roles.owner} />
          )}
        </p>
        {m.name && m.email && <p className="truncate text-xs text-[var(--fg-muted)]">{m.email}</p>}
      </div>
      <RoleChip role={m.role} />
      {items.length > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 192, y: r.bottom + 4 });
          }}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
          aria-label={t.spaces.people.actions(name)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      ) : (
        <span className="w-8" aria-hidden="true" />
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </li>
  );
}

function AddPerson({
  open,
  scope,
  onClose,
  onDone,
}: {
  open: boolean;
  scope: Scope;
  onClose: () => void;
  onDone: (view: TeamView | SpaceView, email: string) => void;
}) {
  const roles =
    scope.kind === 'team'
      ? scope.view.team.role === 'owner'
        ? (['member', 'admin'] as const)
        : (['member'] as const)
      : (['member', 'guest'] as const);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(roles[0]);
  const base = scope.kind === 'team' ? `/api/teams/${scope.id}` : `/api/spaces/${scope.id}`;
  const add = useMutation({
    mutationFn: () =>
      sendJson<TeamView | SpaceView>('POST', `${base}/members`, { email: email.trim(), role }),
    onSuccess: (view) => {
      onDone(view, email.trim().toLowerCase());
      setEmail('');
    },
    onError: (e) => toast(spaceError(e), { tone: 'error' }),
  });
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <Dialog
      open={open}
      title={t.spaces.people.add}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" form="add-person" disabled={!ok || add.isPending}>
            {t.spaces.people.add}
          </Button>
        </>
      }
    >
      <form
        id="add-person"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) add.mutate();
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--fg-muted)]">
            {t.spaces.people.emailLabel}
          </span>
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.auth.emailPlaceholder}
            className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 outline-none focus:border-brand-500"
            autoFocus
          />
        </label>
        {roles.length > 1 && (
          <fieldset>
            <legend className="mb-1 text-xs text-[var(--fg-muted)]">
              {t.spaces.people.roleLabel}
            </legend>
            <div className="flex gap-2">
              {roles.map((r) => (
                <label
                  key={r}
                  className={cn(
                    'flex h-9 cursor-pointer items-center rounded-xl border px-3 text-sm',
                    role === r
                      ? 'border-brand-500 bg-[var(--accent-soft)] font-medium'
                      : 'border-[var(--border)]',
                  )}
                >
                  <input
                    type="radio"
                    name="role"
                    value={r}
                    checked={role === r}
                    onChange={() => setRole(r)}
                    className="sr-only"
                  />
                  {t.spaces.roles[r]}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <p className="text-xs text-[var(--fg-muted)]">
          {scope.kind === 'team' ? t.spaces.people.addHintTeam : t.spaces.people.addHintSpace}
        </p>
      </form>
    </Dialog>
  );
}
