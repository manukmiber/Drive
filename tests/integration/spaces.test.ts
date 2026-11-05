// W1 (ADR-095): Zeiko Spaces' teams and Spaces — roles, seats, guests, and what goes with an account.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { FakeClock } from '../../src/worker/adapters/clock';
import { DAY_MS } from '../../src/shared/constants';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { noticesOf } from '../helpers/notices';

interface Team {
  id: string;
  name: string;
  role: string;
  seats: { used: number; total: number; invited: number };
}
interface Space {
  id: string;
  name: string;
  role: string;
  team: { id: string; name: string };
}
interface Member {
  userId: string;
  email: string | null;
  role: string;
}

function setConfig(rt: DevRuntime, key: string, value: unknown) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
  void rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

async function open(config: Record<string, unknown> = {}, clock?: FakeClock) {
  const rt = await makeRuntime(clock ? { clock } : {});
  for (const [k, v] of Object.entries({ spaces_open: true, ...config })) setConfig(rt, k, v);
  return rt;
}

async function json<T>(s: Session, method: string, path: string, body?: unknown, want = 200) {
  const res = await s.req(method, path, body);
  expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBe(want);
  return (await res.json()) as T;
}

const status = async (s: Session, method: string, path: string, body?: unknown) =>
  (await s.req(method, path, body)).status;

const reason = async (s: Session, method: string, path: string, body?: unknown) =>
  ((await (await s.req(method, path, body)).json()) as { error: { data?: { reason?: string } } })
    .error.data?.reason;

async function team(s: Session, name = 'Studio Lumen') {
  return (await json<{ team: Team }>(s, 'POST', '/api/teams', { name }, 201)).team;
}

async function space(s: Session, teamId: string, name = 'Klien: rebrand') {
  return (await json<{ space: Space }>(s, 'POST', `/api/teams/${teamId}/spaces`, { name }, 201))
    .space;
}

const mine = (s: Session) => json<{ teams: Team[]; spaces: Space[] }>(s, 'GET', '/api/teams');

describe('Zeiko Spaces: teams and Spaces (W1, ADR-095)', () => {
  it('is closed until the owner opens it, and says so in the catalog', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'tutup@example.com');
    const cat = (await (
      await rt.fetch(new Request('http://localhost:5173/api/public/catalog'))
    ).json()) as {
      capabilities: { spaces: boolean };
    };
    expect(cat.capabilities.spaces).toBe(false);
    expect(await status(s, 'POST', '/api/teams', { name: 'Tim' })).toBe(403);
    expect(await mine(s)).toEqual({ teams: [], spaces: [] });

    setConfig(rt, 'spaces_open', true);
    const opened = (await (
      await rt.fetch(new Request('http://localhost:5173/api/public/catalog'))
    ).json()) as { capabilities: { spaces: boolean } };
    expect(opened.capabilities.spaces).toBe(true);
    expect(await status(s, 'POST', '/api/teams', { name: 'Tim' })).toBe(201);
  });

  it('keeps teams, members and Spaces in the access database only', async () => {
    const rt = await open();
    const owner = await signIn(rt, 'pemilik-w1@example.com');
    const t = await team(owner);
    await space(owner, t.id);
    for (const table of ['teams', 'team_members', 'spaces', 'space_members']) {
      expect(() => rt.d1.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).get()).toThrow();
    }
    const n = (table: string) =>
      (rt.access.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([n('teams'), n('team_members'), n('spaces')]).toEqual([1, 1, 1]);
  });

  it('gives the owner every Space, members only theirs, and guests no list of people', async () => {
    const rt = await open();
    const owner = await signIn(rt, 'pemilik@example.com');
    const admin = await signIn(rt, 'admin@example.com');
    const member = await signIn(rt, 'anggota@example.com');
    const client = await signIn(rt, 'klien@example.com');
    const t = await team(owner);
    expect(t).toMatchObject({ role: 'owner', seats: { used: 1, total: 5 } });

    await json(owner, 'POST', `/api/teams/${t.id}/members`, {
      email: 'Admin@Example.com',
      role: 'admin',
    });
    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'anggota@example.com' });
    const a = await space(admin, t.id, 'Klien: Lumen');
    const b = await space(owner, t.id, 'Internal');

    // A member sees no Space until added to one.
    expect((await mine(member)).spaces).toEqual([]);
    await json(admin, 'POST', `/api/spaces/${a.id}/members`, {
      email: 'anggota@example.com',
      role: 'member',
    });
    await json(admin, 'POST', `/api/spaces/${a.id}/members`, {
      email: 'klien@example.com',
      role: 'guest',
    });

    expect((await mine(owner)).spaces.map((s) => [s.name, s.role])).toEqual([
      ['Internal', 'admin'],
      ['Klien: Lumen', 'admin'],
    ]);
    expect((await mine(member)).spaces.map((s) => [s.id, s.role])).toEqual([[a.id, 'member']]);
    const guestView = await mine(client);
    expect(guestView.teams).toEqual([]);
    expect(guestView.spaces).toMatchObject([
      { id: a.id, role: 'guest', team: { id: t.id, name: 'Studio Lumen' } },
    ]);

    const full = await json<{ members: Member[] }>(member, 'GET', `/api/spaces/${a.id}`);
    expect(full.members.map((m) => [m.email, m.role])).toEqual([
      ['pemilik@example.com', 'admin'],
      ['admin@example.com', 'admin'],
      ['anggota@example.com', 'member'],
      ['klien@example.com', 'guest'],
    ]);
    expect(
      (await json<{ members: Member[] }>(client, 'GET', `/api/spaces/${a.id}`)).members,
    ).toEqual([]);

    // Neither the guest nor the member reaches the other Space or the team's settings.
    for (const s of [client, member])
      expect(await status(s, 'GET', `/api/spaces/${b.id}`)).toBe(404);
    expect(await status(client, 'GET', `/api/teams/${t.id}`)).toBe(404);
    expect(await status(member, 'GET', `/api/teams/${t.id}`)).toBe(200);
    expect(await status(member, 'POST', `/api/teams/${t.id}/spaces`, { name: 'x' })).toBe(403);
    expect(await status(member, 'PATCH', `/api/spaces/${a.id}`, { name: 'x' })).toBe(403);
    expect(
      await status(client, 'POST', `/api/spaces/${a.id}/members`, {
        email: 'pemilik@example.com',
        role: 'guest',
      }),
    ).toBe(403);
  });

  it('only the owner makes admins, removes admins, and deletes the team', async () => {
    const rt = await open();
    const owner = await signIn(rt, 'o@example.com');
    const admin = await signIn(rt, 'a@example.com');
    const member = await signIn(rt, 'm@example.com');
    const t = await team(owner);
    await json(owner, 'POST', `/api/teams/${t.id}/members`, {
      email: 'a@example.com',
      role: 'admin',
    });
    await signIn(rt, 'a2@example.com');
    expect(
      await status(admin, 'POST', `/api/teams/${t.id}/members`, {
        email: 'a2@example.com',
        role: 'admin',
      }),
    ).toBe(403);
    await json(admin, 'POST', `/api/teams/${t.id}/members`, { email: 'm@example.com' });
    expect(
      await status(admin, 'PATCH', `/api/teams/${t.id}/members/${member.userId}`, {
        role: 'admin',
      }),
    ).toBe(403);
    await json(owner, 'PATCH', `/api/teams/${t.id}/members/${member.userId}`, { role: 'admin' });
    expect(await status(admin, 'DELETE', `/api/teams/${t.id}/members/${member.userId}`)).toBe(403);
    expect(await status(admin, 'DELETE', `/api/teams/${t.id}/members/${owner.userId}`)).toBe(409);
    expect(await status(admin, 'DELETE', `/api/teams/${t.id}`)).toBe(403);
    // Anyone but the owner may leave; the owner hands the team over first.
    expect(await status(owner, 'DELETE', `/api/teams/${t.id}/members/${owner.userId}`)).toBe(409);
    expect(await status(member, 'DELETE', `/api/teams/${t.id}/members/${member.userId}`)).toBe(204);
    expect(await status(owner, 'DELETE', `/api/teams/${t.id}`)).toBe(204);
    expect(await status(admin, 'GET', `/api/teams/${t.id}`)).toBe(404);
  });

  it('counts seats, Spaces per team, guests per Space and teams per owner', async () => {
    const rt = await open({
      team_default_seats: 2,
      team_default_max_spaces: 1,
      team_default_max_guests: 1,
      team_max_owned: 1,
    });
    const owner = await signIn(rt, 'kursi@example.com');
    for (const e of [
      'satu@example.com',
      'dua@example.com',
      'tamu1@example.com',
      'tamu2@example.com',
    ])
      await signIn(rt, e);
    const t = await team(owner);
    expect(await reason(owner, 'POST', '/api/teams', { name: 'Kedua' })).toBe('teams_full');

    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'satu@example.com' });
    expect(
      await reason(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'dua@example.com' }),
    ).toBe('seats_full');

    const s = await space(owner, t.id);
    expect(await reason(owner, 'POST', `/api/teams/${t.id}/spaces`, { name: 'Lagi' })).toBe(
      'spaces_full',
    );
    // Guests take no seat, but a Space holds so many.
    await json(owner, 'POST', `/api/spaces/${s.id}/members`, {
      email: 'tamu1@example.com',
      role: 'guest',
    });
    expect(
      await reason(owner, 'POST', `/api/spaces/${s.id}/members`, {
        email: 'tamu2@example.com',
        role: 'guest',
      }),
    ).toBe('guests_full');
    const got = await json<{ team: Team }>(owner, 'GET', `/api/teams/${t.id}`);
    expect(got.team.seats).toEqual({ used: 2, total: 2, invited: 0 });
  });

  it('keeps members and guests apart, and turns a guest who joins the team into a member', async () => {
    const rt = await open();
    const owner = await signIn(rt, 'pisah@example.com');
    const friend = await signIn(rt, 'teman@example.com');
    const t = await team(owner);
    const s = await space(owner, t.id);
    const add = (email: string, role: string) =>
      reason(owner, 'POST', `/api/spaces/${s.id}/members`, { email, role });

    expect(await add('teman@example.com', 'member')).toBe('not_on_team');
    expect(await add('pisah@example.com', 'guest')).toBe('team_admin');
    // An address without Drive is invited (W1c): as a guest only, since it is on no team.
    expect(await add('belum-ada@example.com', 'member')).toBe('not_on_team');
    await json(owner, 'POST', `/api/spaces/${s.id}/members`, {
      email: 'teman@example.com',
      role: 'guest',
    });
    expect((await mine(friend)).spaces[0]?.role).toBe('guest');

    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'teman@example.com' });
    expect((await mine(friend)).spaces[0]?.role).toBe('member');
    expect(await add('teman@example.com', 'guest')).toBe('on_team');

    // Leaving the team takes them out of its Spaces too.
    expect(await status(friend, 'DELETE', `/api/teams/${t.id}/members/${friend.userId}`)).toBe(204);
    expect((await mine(friend)).spaces).toEqual([]);
  });

  it('hands a team over: the new owner owns it, the old one stays on as an admin', async () => {
    const rt = await open();
    const owner = await signIn(rt, 'lama@example.com');
    const next = await signIn(rt, 'baru@example.com');
    const t = await team(owner);
    const s = await space(owner, t.id);
    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'baru@example.com' });
    await json(owner, 'POST', `/api/spaces/${s.id}/members`, {
      email: 'baru@example.com',
      role: 'member',
    });
    expect(await status(next, 'POST', `/api/teams/${t.id}/owner`, { userId: next.userId })).toBe(
      403,
    );
    const after = await json<{ members: Member[] }>(owner, 'POST', `/api/teams/${t.id}/owner`, {
      userId: next.userId,
    });
    expect(after.members.map((m) => [m.email, m.role])).toEqual([
      ['lama@example.com', 'admin'],
      ['baru@example.com', 'owner'],
    ]);
    expect((await mine(next)).spaces[0]?.role).toBe('admin');
    expect(await status(next, 'DELETE', `/api/teams/${t.id}`)).toBe(204);
  });

  it('a deleted account takes its own teams with it and leaves the others', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 5));
    const rt = await open({}, clock);
    const leaver = await signIn(rt, 'pergi-w1@example.com');
    const other = await signIn(rt, 'tinggal-w1@example.com');
    const own = await team(leaver, 'Milik yang pergi');
    const theirs = await team(other, 'Milik yang tinggal');
    const s = await space(other, theirs.id);
    await json(leaver, 'POST', `/api/teams/${own.id}/members`, { email: 'tinggal-w1@example.com' });
    await json(other, 'POST', `/api/teams/${theirs.id}/members`, { email: 'pergi-w1@example.com' });
    await json(other, 'POST', `/api/spaces/${s.id}/members`, {
      email: 'pergi-w1@example.com',
      role: 'member',
    });

    const exported = await json<{ spaces: { teams: Team[]; spaces: Space[] } }>(
      leaver,
      'GET',
      '/api/me/export',
    );
    expect(exported.spaces.teams.map((t) => [t.name, t.role])).toEqual([
      ['Milik yang pergi', 'owner'],
      ['Milik yang tinggal', 'member'],
    ]);
    expect(exported.spaces.spaces.map((x) => x.id)).toEqual([s.id]);

    await json(leaver, 'POST', '/api/me/delete', { confirmEmail: 'pergi-w1@example.com' });
    clock.advance(8 * DAY_MS);
    await rt.runCron('0 19 * * *');
    await rt.settle();

    expect(await status(other, 'GET', `/api/teams/${own.id}`)).toBe(404);
    const left = await json<{ members: Member[] }>(other, 'GET', `/api/teams/${theirs.id}`);
    expect(left.members.map((m) => m.userId)).toEqual([other.userId]);
    const inSpace = await json<{ members: Member[] }>(other, 'GET', `/api/spaces/${s.id}`);
    expect(inSpace.members.map((m) => m.userId)).toEqual([other.userId]);
    const rows = rt.access.sqlite
      .prepare(
        'SELECT (SELECT COUNT(*) FROM team_members WHERE user_id = ?) + (SELECT COUNT(*) FROM space_members WHERE user_id = ?) AS n',
      )
      .get(leaver.userId, leaver.userId) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('invites an address without Drive: the seat waits, one email goes, and signing in claims it', async () => {
    const rt = await open({ team_default_seats: 3 });
    const owner = await signIn(rt, 'pengundang@example.com');
    const admin = await signIn(rt, 'wakil@example.com');
    const t = await team(owner);
    const s = await space(owner, t.id);
    await json(owner, 'POST', `/api/teams/${t.id}/members`, {
      email: 'wakil@example.com',
      role: 'admin',
    });

    const after = await json<{
      team: Team;
      invites: Array<{ id: string; email: string; role: string }>;
    }>(admin, 'POST', `/api/teams/${t.id}/members`, { email: 'Calon@Example.com' });
    expect(after.invites).toMatchObject([{ email: 'calon@example.com', role: 'member' }]);
    expect(after.team.seats).toEqual({ used: 3, total: 3, invited: 1 });
    // The seat it holds is taken; asking again renews it instead of taking another.
    await signIn(rt, 'lain@example.com');
    expect(
      await reason(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'lain@example.com' }),
    ).toBe('seats_full');
    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'calon@example.com' });
    // A guest invitation to the Space for an address without Drive.
    const sp = await json<{ invites: Array<{ email: string; role: string }> }>(
      owner,
      'POST',
      `/api/spaces/${s.id}/members`,
      { email: 'klien-baru@example.com', role: 'guest' },
    );
    expect(sp.invites).toMatchObject([{ email: 'klien-baru@example.com', role: 'guest' }]);

    await rt.settle();
    const { mails } = (await (
      await rt.fetch(new Request('http://localhost:5173/__dev/mail'))
    ).json()) as {
      mails: Array<{ to: string[]; subject: string; text: string }>;
    };
    const toCalon = mails.filter((m) => m.to.includes('calon@example.com'));
    expect(toCalon.length).toBeGreaterThanOrEqual(1);
    expect(toCalon[0]!.subject).toContain('Studio Lumen');
    expect(toCalon[0]!.text).toContain('/spaces');
    expect(mails.some((m) => m.to.includes('klien-baru@example.com'))).toBe(true);

    // Signing in with that address: the team for one, the Space as a guest for the other.
    const calon = await signIn(rt, 'calon@example.com');
    expect((await mine(calon)).teams.map((x) => [x.id, x.role])).toEqual([[t.id, 'member']]);
    const klien = await signIn(rt, 'klien-baru@example.com');
    expect((await mine(klien)).spaces.map((x) => [x.id, x.role])).toEqual([[s.id, 'guest']]);
    const now = await json<{ team: Team; invites: unknown[] }>(owner, 'GET', `/api/teams/${t.id}`);
    expect(now.invites).toEqual([]);
    expect(now.team.seats).toEqual({ used: 3, total: 3, invited: 0 });
  });

  it('takes back a waiting invitation, frees its seat, and lets nobody else see or take it', async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 5));
    const rt = await open({ team_default_seats: 3, space_invite_days: 14 }, clock);
    const owner = await signIn(rt, 'cabut@example.com');
    const member = await signIn(rt, 'biasa@example.com');
    const t = await team(owner);
    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'biasa@example.com' });
    expect(
      (await json<{ invites: unknown[] }>(member, 'GET', `/api/teams/${t.id}`)).invites,
    ).toEqual([]);
    await json(owner, 'PATCH', `/api/teams/${t.id}/members/${member.userId}`, { role: 'admin' });
    const inv = (
      await json<{ invites: Array<{ id: string }> }>(owner, 'POST', `/api/teams/${t.id}/members`, {
        email: 'jadi-admin@example.com',
        role: 'admin',
      })
    ).invites[0]!;
    // An admin may not take back an admin's invitation; the owner may.
    expect(await status(member, 'DELETE', `/api/teams/${t.id}/invites/${inv.id}`)).toBe(403);
    expect(await status(owner, 'DELETE', `/api/teams/${t.id}/invites/${inv.id}`)).toBe(204);
    expect(await status(owner, 'DELETE', `/api/teams/${t.id}/invites/${inv.id}`)).toBe(404);

    // One that runs out frees its seat and is never claimed.
    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'telat@example.com' });
    clock.advance(15 * DAY_MS);
    const late = await signIn(rt, 'telat@example.com');
    expect((await mine(late)).teams).toEqual([]);
    expect(
      (await json<{ team: Team }>(owner, 'GET', `/api/teams/${t.id}`)).team.seats.invited,
    ).toBe(0);
  });

  it('tells people already on Drive when they are added, with a notice', async () => {
    const rt = await open();
    const owner = await signIn(rt, 'pemberi-tahu@example.com');
    const friend = await signIn(rt, 'yang-diberi@example.com');
    const t = await team(owner);
    const s = await space(owner, t.id);
    await json(owner, 'POST', `/api/teams/${t.id}/members`, { email: 'yang-diberi@example.com' });
    await json(owner, 'POST', `/api/spaces/${s.id}/members`, {
      email: 'yang-diberi@example.com',
      role: 'member',
    });
    const notices = (await noticesOf(rt, friend.userId)).filter((n) => n.type === 'space_added');
    expect(notices.map((n) => [n.payload.name, n.payload.role, n.payload.space ?? null])).toEqual([
      ['Studio Lumen', 'member', null],
      ['Klien: rebrand', 'member', s.id],
    ]);
  });
});
