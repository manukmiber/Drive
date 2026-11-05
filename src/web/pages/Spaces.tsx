// Zeiko Spaces in the app (W1b/W4, ADR-098): the person's teams and Spaces, a team's page, and a
// Space with its chat and its people. Inside Drive (T2), apart from the person's own files.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  LayoutGrid,
  LogOut,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { sendJson } from '../lib/api';
import { FolderNavContext } from '../lib/folder-nav';
import { useCatalog } from '../lib/catalog';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import { useMe } from '../lib/session';
import { useSpaceRoom } from '../lib/space-room';
import {
  personName,
  spaceError,
  spaceKey,
  spacesKey,
  teamKey,
  useMySpaces,
  useSpace,
  useTeam,
  type SpaceDto,
  type TeamDto,
  type TeamStatus,
} from '../lib/spaces';
import { Button } from '../components/Button';
import { SpaceChat } from '../components/spaces/Chat';
import { useConfirm } from '../components/spaces/Confirm';
import { People, RoleChip } from '../components/spaces/People';
import { PromptDialog } from '../components/ui/Dialog';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { toast } from '../components/ui/Toast';
import { Drive } from './Drive';

const card = 'z-card rounded-2xl p-5';

function useTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · Zeiko Spaces`;
  }, [title]);
}

function StatusNote({ status }: { status: TeamStatus }) {
  if (status === 'active') return null;
  return (
    <p className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
      {t.spaces.status[status]}
    </p>
  );
}

function SpaceLink({ s }: { s: SpaceDto }) {
  return (
    <li>
      <Link
        to="/spaces/$spaceId"
        params={{ spaceId: s.id }}
        className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-[var(--bg-subtle)]"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-brand-700">
          <MessagesSquare className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.name}</span>
        {s.role === 'guest' && <RoleChip role="guest" />}
        <ChevronRight className="h-4 w-4 text-[var(--fg-muted)]" />
      </Link>
    </li>
  );
}

/** Ask a name, make the thing, then go where it is. */
function useMake() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [asking, setAsking] = useState<null | { kind: 'team' } | { kind: 'space'; team: string }>(
    null,
  );
  const make = useMutation({
    mutationFn: async (name: string) => {
      if (asking?.kind === 'space')
        return sendJson<{ space: SpaceDto }>('POST', `/api/teams/${asking.team}/spaces`, { name });
      return sendJson<{ team: TeamDto }>('POST', '/api/teams', { name });
    },
    onSuccess: async (out) => {
      setAsking(null);
      await qc.invalidateQueries({ queryKey: spacesKey });
      if ('space' in out) {
        toast(t.spaces.created);
        void navigate({ to: '/spaces/$spaceId', params: { spaceId: out.space.id } });
      } else void navigate({ to: '/spaces/tim/$teamId', params: { teamId: out.team.id } });
    },
    onError: (e) => toast(spaceError(e), { tone: 'error' }),
  });
  const ui = (
    <PromptDialog
      open={Boolean(asking)}
      title={asking?.kind === 'space' ? t.spaces.newSpace : t.spaces.newTeam}
      initial=""
      confirmLabel={t.common.save}
      onCancel={() => setAsking(null)}
      onSubmit={(v) => !make.isPending && make.mutate(v)}
    />
  );
  return { ask: setAsking, ui };
}

export function SpacesHome() {
  const q = useMySpaces();
  const catalog = useCatalog();
  const open = Boolean(catalog.data?.capabilities?.spaces);
  const make = useMake();
  useTitle(t.spaces.title);

  const teams = q.data?.teams ?? [];
  const spaces = q.data?.spaces ?? [];
  const mine = new Set(teams.map((x) => x.id));
  const guestIn = spaces.filter((s) => !mine.has(s.team.id));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{t.spaces.title}</h1>
          <p className="mt-1 max-w-prose text-sm text-[var(--fg-muted)]">{t.spaces.intro}</p>
        </div>
        {open && (
          <Button onClick={() => make.ask({ kind: 'team' })}>
            <Plus className="h-4 w-4" /> {t.spaces.newTeam}
          </Button>
        )}
      </header>

      {q.isPending && <p className="text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
      {q.isError && <p className="text-sm text-red-600">{t.errors.generic}</p>}

      {q.data && !teams.length && !guestIn.length && (
        <div className={cn(card, 'text-center')}>
          <LayoutGrid className="mx-auto h-8 w-8 text-brand-600" />
          <h2 className="mt-3 font-semibold">{t.spaces.emptyTitle}</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-[var(--fg-muted)]">
            {open ? t.spaces.emptyBody : t.spaces.closed}
          </p>
        </div>
      )}

      {teams.map((team) => {
        const list = spaces.filter((s) => s.team.id === team.id);
        const lead = team.role !== 'member';
        return (
          <section key={team.id} className={card}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate font-semibold">{team.name}</h2>
              <RoleChip role={team.role} />
              <Link
                to="/spaces/tim/$teamId"
                params={{ teamId: team.id }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
              >
                <Settings2 className="h-3.5 w-3.5" /> {t.spaces.manageTeam}
              </Link>
            </div>
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              {t.spaces.seats(team.seats.used, team.seats.total)}
            </p>
            {team.status !== 'active' && (
              <div className="mt-3">
                <StatusNote status={team.status} />
              </div>
            )}
            {list.length ? (
              <ul className="mt-3 -mx-2">
                {list.map((s) => (
                  <SpaceLink key={s.id} s={s} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-[var(--fg-muted)]">
                {lead ? t.spaces.noSpaces : t.spaces.noSpacesMember}
              </p>
            )}
            {lead && team.status === 'active' && (
              <Button
                variant="secondary"
                className="mt-3"
                onClick={() => make.ask({ kind: 'space', team: team.id })}
              >
                <Plus className="h-4 w-4" /> {t.spaces.newSpace}
              </Button>
            )}
          </section>
        );
      })}

      {guestIn.length > 0 && (
        <section className={card}>
          <h2 className="font-semibold">{t.spaces.asGuest}</h2>
          <ul className="mt-3 -mx-2">
            {guestIn.map((s) => (
              <SpaceLink key={s.id} s={s} />
            ))}
          </ul>
        </section>
      )}
      {make.ui}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/spaces"
      className="inline-flex items-center gap-1.5 text-sm text-[var(--fg-muted)] hover:text-[var(--fg)]"
    >
      <ArrowLeft className="h-4 w-4" /> {t.spaces.allSpaces}
    </Link>
  );
}

function Missing() {
  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <BackLink />
      <p className={cn(card, 'text-sm')}>{t.spaces.errors.notFound}</p>
    </div>
  );
}

export function TeamPage({ teamId }: { teamId: string }) {
  const q = useTeam(teamId);
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const make = useMake();
  const [ask, confirmUi] = useConfirm();
  const [renaming, setRenaming] = useState(false);
  useTitle(q.data?.team.name);

  const done = async (leave: boolean) => {
    await qc.invalidateQueries({ queryKey: spacesKey });
    if (leave) void navigate({ to: '/spaces' });
  };
  const act = useMutation({
    mutationFn: (a: { method: 'PATCH' | 'DELETE'; path: string; body?: unknown }) =>
      sendJson(a.method, `/api/teams/${teamId}${a.path}`, a.body),
    onError: (e) => toast(spaceError(e), { tone: 'error' }),
  });

  if (q.isPending || !me.data)
    return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (!q.data) return <Missing />;
  const { team, spaces } = q.data;
  const meId = me.data.user.id;
  const owner = team.role === 'owner';
  const lead = team.role !== 'member';
  const active = team.status === 'active';

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <BackLink />
      <section className={card}>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{team.name}</h1>
          <RoleChip role={team.role} />
          {lead && active && (
            <button
              type="button"
              onClick={() => setRenaming(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
              aria-label={t.spaces.team.rename}
              title={t.spaces.team.rename}
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
        </div>
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="sr-only">{t.spaces.people.teamTitle}</dt>
            <dd>{t.spaces.seats(team.seats.used, team.seats.total)}</dd>
            {team.seats.invited > 0 && (
              <dd className="text-xs text-[var(--fg-muted)]">
                {t.spaces.seatsInvited(team.seats.invited)}
              </dd>
            )}
          </div>
          <div>
            <dt className="sr-only">{t.spaces.title}</dt>
            <dd>{t.spaces.spacesCount(spaces.length, team.maxSpaces)}</dd>
          </div>
          <div>
            <dt className="sr-only">{t.spaces.roles.guest}</dt>
            <dd className="text-[var(--fg-muted)]">{t.spaces.guestsMax(team.maxGuests)}</dd>
          </div>
        </dl>
        {!active && (
          <div className="mt-3">
            <StatusNote status={team.status} />
          </div>
        )}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 font-medium">{t.spaces.title}</h2>
          {lead && active && spaces.length < team.maxSpaces && (
            <Button variant="secondary" onClick={() => make.ask({ kind: 'space', team: team.id })}>
              <Plus className="h-4 w-4" /> {t.spaces.newSpace}
            </Button>
          )}
        </div>
        {spaces.length ? (
          <ul className="mt-2 -mx-2">
            {spaces.map((s) => (
              <SpaceLink key={s.id} s={s} />
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-[var(--fg-muted)]">
            {lead ? t.spaces.noSpaces : t.spaces.noSpacesMember}
          </p>
        )}
      </section>

      <People scope={{ kind: 'team', id: teamId, view: q.data }} me={meId} readOnly={!active} />

      <div className="flex flex-wrap items-center justify-end gap-2">
        {owner ? (
          <>
            <p className="mr-auto text-xs text-[var(--fg-muted)]">{t.spaces.team.ownerLeaves}</p>
            <Button
              variant="ghost"
              className="text-red-600"
              onClick={() =>
                ask({
                  title: t.spaces.team.remove,
                  body: t.spaces.team.removeConfirm(team.name),
                  label: t.common.delete,
                  run: () =>
                    act.mutate({ method: 'DELETE', path: '' }, { onSuccess: () => done(true) }),
                })
              }
            >
              <Trash2 className="h-4 w-4" /> {t.spaces.team.remove}
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            onClick={() =>
              ask({
                title: t.spaces.team.leave,
                body: t.spaces.team.leaveConfirm(team.name),
                label: t.spaces.team.leave,
                run: () =>
                  act.mutate(
                    { method: 'DELETE', path: `/members/${meId}` },
                    { onSuccess: () => done(true) },
                  ),
              })
            }
          >
            <LogOut className="h-4 w-4" /> {t.spaces.team.leave}
          </Button>
        )}
      </div>

      <PromptDialog
        open={renaming}
        title={t.spaces.team.rename}
        initial={team.name}
        confirmLabel={t.common.save}
        onCancel={() => setRenaming(false)}
        onSubmit={(name) => {
          setRenaming(false);
          act.mutate(
            { method: 'PATCH', path: '', body: { name } },
            {
              onSuccess: () => {
                void qc.invalidateQueries({ queryKey: teamKey(teamId) });
                void done(false);
              },
            },
          );
        }}
      />
      {make.ui}
      {confirmUi}
    </div>
  );
}

/** W1e (ADR-099): the Space's files in Drive's own explorer, folders kept inside the Space page. */
function SpaceFiles({
  spaceId,
  rootId,
  folder,
  onOpen,
}: {
  spaceId: string;
  rootId: string | null;
  folder: string | undefined;
  onOpen: (folderId: string | undefined) => void;
}) {
  const qc = useQueryClient();
  const open = useMutation({
    mutationFn: () => sendJson<{ rootId: string }>('POST', `/api/spaces/${spaceId}/files`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: spaceKey(spaceId) }),
    onError: (e) => toast(spaceError(e), { tone: 'error' }),
  });
  const { mutate, isIdle } = open;
  useEffect(() => {
    if (!rootId && isIdle) mutate();
  }, [rootId, isIdle, mutate]);
  const nav = useMemo(
    () =>
      rootId ? { rootId, open: (id: string) => onOpen(id === rootId ? undefined : id) } : null,
    [rootId, onOpen],
  );
  if (!nav) return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  const at = folder ?? nav.rootId;
  return (
    <div className="h-full overflow-y-auto">
      <FolderNavContext.Provider value={nav}>
        <Drive key={at} folderId={at} />
      </FolderNavContext.Provider>
    </div>
  );
}

export type SpaceTab = 'chat' | 'people' | 'files';

export function SpacePage({
  spaceId,
  tab,
  topic,
  folder,
  onNavigate,
}: {
  spaceId: string;
  tab: SpaceTab;
  topic: string | undefined;
  folder: string | undefined;
  onNavigate: (next: { tab?: SpaceTab; topic?: string; folder?: string }) => void;
}) {
  const q = useSpace(spaceId);
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const [ask, confirmUi] = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useTitle(q.data?.space.name);

  const space = q.data?.space;
  const chatOn = Boolean(catalog.data?.capabilities?.spacesChat);
  const room = useSpaceRoom(spaceId, chatOn && Boolean(space) && space?.status !== 'frozen');
  const maxChars = Number(catalog.data?.config.space_message_max_chars ?? 4000);

  const people = useMemo(
    () => (q.data?.members ?? []).map((m) => ({ id: m.userId, name: personName(m) })),
    [q.data?.members],
  );

  // Out of the Space, or the Space is gone: the list of Spaces changes too.
  const status = room.state.status;
  useEffect(() => {
    if (status === 'removed' || status === 'gone')
      void qc.invalidateQueries({ queryKey: spacesKey });
  }, [status, qc]);

  const act = useMutation({
    mutationFn: (a: { method: 'PATCH' | 'DELETE'; path: string; body?: unknown }) =>
      sendJson(a.method, `/api/spaces/${spaceId}${a.path}`, a.body),
    onError: (e) => toast(spaceError(e), { tone: 'error' }),
  });

  if (q.isPending || !me.data)
    return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (!q.data || !space) return <Missing />;
  const meId = me.data.user.id;
  const meName = me.data.user.name || me.data.user.email;
  const admin = space.role === 'admin';
  const active = space.status === 'active';
  const frozen = space.status === 'frozen';

  const leave = async () => {
    await qc.invalidateQueries({ queryKey: spacesKey });
    void navigate({ to: '/spaces' });
  };
  const items: MenuItem[] = [];
  if (admin && active)
    items.push({ label: t.spaces.space.rename, icon: Pencil, onSelect: () => setRenaming(true) });
  if (admin)
    items.push({
      label: t.spaces.space.remove,
      icon: Trash2,
      danger: true,
      onSelect: () =>
        ask({
          title: t.spaces.space.remove,
          body: t.spaces.space.removeConfirm(space.name),
          label: t.common.delete,
          run: () => act.mutate({ method: 'DELETE', path: '' }, { onSuccess: leave }),
        }),
    });
  else
    items.push({
      label: t.spaces.space.leave,
      icon: LogOut,
      danger: true,
      onSelect: () =>
        ask({
          title: t.spaces.space.leave,
          body: t.spaces.space.leaveConfirm(space.name),
          label: t.spaces.space.leave,
          run: () =>
            act.mutate(
              { method: 'DELETE', path: `/members/${meId}` },
              {
                onSuccess: () => {
                  toast(t.spaces.space.left);
                  void leave();
                },
              },
            ),
        }),
    });

  const tabs: Array<{ id: SpaceTab; label: string; icon: typeof Users }> = [
    { id: 'chat', label: t.spaces.tabs.chat, icon: MessagesSquare },
    // W1e (ADR-099): guests have no files yet, and a frozen team's are locked.
    ...(q.data.files && !frozen
      ? [{ id: 'files' as const, label: t.spaces.tabs.files, icon: FolderOpen }]
      : []),
    { id: 'people', label: t.spaces.tabs.people, icon: Users },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-[var(--border)] px-4 pt-3 md:px-6">
        <div className="flex items-center gap-2">
          <Link
            to="/spaces"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
            aria-label={t.spaces.allSpaces}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-[var(--fg-muted)]">{space.team.name}</p>
            <h1 className="truncate text-base font-semibold leading-tight">{space.name}</h1>
          </div>
          <RoleChip role={space.role} />
          <button
            type="button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 192, y: r.bottom + 4 });
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
            aria-label={t.spaces.people.actions(space.name)}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
        <nav className="mt-2 flex gap-1" aria-label={space.name}>
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => onNavigate({ tab: x.id, topic })}
              aria-current={tab === x.id ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm',
                tab === x.id
                  ? 'border-brand-600 font-medium'
                  : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
              )}
            >
              <x.icon className="h-4 w-4" />
              {x.label}
              {x.id === 'chat' &&
                tab !== 'chat' &&
                room.state.topics.some((tp) => tp.unread > 0) && (
                  <span className="h-2 w-2 rounded-full bg-brand-600" aria-hidden="true" />
                )}
            </button>
          ))}
        </nav>
      </header>

      {!active && (
        <div className="shrink-0 px-4 pt-3 md:px-6">
          <StatusNote status={space.status} />
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {tab === 'files' && q.data.files && !frozen ? (
          <SpaceFiles
            spaceId={spaceId}
            rootId={q.data.files.rootId}
            folder={folder}
            onOpen={(id) => onNavigate({ tab: 'files', folder: id })}
          />
        ) : tab === 'chat' ? (
          !chatOn || frozen ? (
            <p className="p-6 text-sm text-[var(--fg-muted)]">{t.spaces.chat.off}</p>
          ) : (
            <SpaceChat
              room={room}
              people={people}
              meName={meName}
              maxChars={maxChars}
              topicId={topic}
              onTopic={(id) => onNavigate({ tab: 'chat', topic: id })}
            />
          )
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
              {space.role === 'guest' ? (
                <p className={cn(card, 'text-sm')}>{t.spaces.space.guestNote}</p>
              ) : (
                <People
                  scope={{ kind: 'space', id: spaceId, view: q.data }}
                  me={meId}
                  online={room.state.status === 'open' ? [...room.state.online, meId] : undefined}
                  readOnly={!active}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <PromptDialog
        open={renaming}
        title={t.spaces.space.rename}
        initial={space.name}
        confirmLabel={t.common.save}
        onCancel={() => setRenaming(false)}
        onSubmit={(name) => {
          setRenaming(false);
          act.mutate(
            { method: 'PATCH', path: '', body: { name } },
            {
              onSuccess: () => {
                void qc.invalidateQueries({ queryKey: spaceKey(spaceId) });
                void qc.invalidateQueries({ queryKey: spacesKey, exact: true });
              },
            },
          );
        }}
      />
      {menu && <Menu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {confirmUi}
    </div>
  );
}
