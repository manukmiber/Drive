// Keluarga (SPEC §9): Drive Keluarga + members, invites and caps; plus the invite landing page.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, Crown, MessageCircle, Send, Users } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { formatBytes, formatDate, formatRupiah } from '../../shared/format';
import { t } from '../lib/i18n';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { StorageMeter } from '../components/StorageMeter';
import { Dialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { api, ApiError, postJson, sendJson } from '../lib/api';
import { cn } from '../lib/cn';
import { meQueryKey, useMe } from '../lib/session';
import type { Catalog } from '../lib/types';
import { Drive } from './Drive';

interface Overview {
  family: null | {
    id: string;
    name: string;
    role: 'owner' | 'member';
    ownerId: string;
    plan: { code: string; name: string; maxMembers: number; priceIdr: number } | null;
    subscriptionStatus: string | null;
    storage: { limitBytes: number; usedBytes: number; reservedBytes: number };
    members: Array<{
      id: string;
      name: string;
      email: string;
      role: string;
      capBytes: number | null;
      usedBytes: number;
      joinedAt: number;
    }>;
    invites: Array<{ id: string; channel: string; expiresAt: number }>;
  };
}

const card = 'z-card rounded-2xl p-5';
const errText = (e: unknown) => (e instanceof ApiError ? `${e.message}` : t.errors.generic);

function InvitePanel({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const make = useMutation({
    mutationFn: () => postJson<{ url: string }>('/api/family/invites', { channel: 'link' }),
    onSuccess: async ({ url: u }) => {
      setUrl(u);
      setQr(await QRCode.toDataURL(u, { margin: 1, width: 200 }));
      onDone();
    },
    onError: (e) => toast(errText(e), { tone: 'error' }),
  });
  useEffect(() => {
    if (!url && make.isIdle) make.mutate();
  }, [url, make]);
  const text = url ? `Ayo gabung ke paket keluarga Zeiko-ku: ${url}` : '';
  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--fg-muted)]">{t.family.inviteLink}</p>
      {url && (
        <>
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard.writeText(url).then(() => toast(t.share.linkCopied))
              }
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
              }
            >
              <MessageCircle className="h-4 w-4" /> WhatsApp
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                window.open(
                  `https://t.me/share/url?url=${encodeURIComponent(url)}`,
                  '_blank',
                  'noopener',
                )
              }
            >
              <Send className="h-4 w-4" /> Telegram
            </Button>
          </div>
          {qr && <img src={qr} alt="QR undangan" className="h-40 w-40 rounded-xl bg-white p-2" />}
          <div className="flex gap-2">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t.auth.emailPlaceholder}
              inputMode="email"
              className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm"
            />
            <Button
              variant="secondary"
              disabled={!email.includes('@')}
              onClick={() =>
                void postJson('/api/family/invites', { email })
                  .then(() => {
                    toast(t.family.inviteSent);
                    setEmail('');
                    onDone();
                  })
                  .catch((e) => toast(errText(e), { tone: 'error' }))
              }
            >
              {t.family.inviteEmail}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function Members({ o }: { o: NonNullable<Overview['family']> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<{ body: string; run: () => Promise<unknown> } | null>(
    null,
  );
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['family'] }),
      qc.invalidateQueries({ queryKey: meQueryKey }),
    ]);
  const isOwner = o.role === 'owner';
  const max = o.plan?.maxMembers ?? 0;
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <section className={card}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-lg font-medium">{o.name}</h2>
          <span className="text-xs text-[var(--fg-muted)]">
            {o.plan?.name} · {o.members.length}/{max}
          </span>
        </div>
        <div className="mt-3">
          <StorageMeter storage={o.storage} />
        </div>
        {isOwner && <p className="mt-3 text-xs text-[var(--fg-muted)]">{t.family.privacy}</p>}
      </section>

      <section className={card}>
        <div className="flex items-center gap-2">
          <h3 className="flex-1 font-medium">{t.family.members}</h3>
          {isOwner && o.members.length < max && (
            <Button onClick={() => setInviting(true)}>
              <Users className="h-4 w-4" /> {t.family.invite}
            </Button>
          )}
        </div>
        <ul className="mt-3 divide-y divide-[var(--border)]">
          {o.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-800/50 text-sm font-semibold text-brand-800">
                {(m.name || m.email).slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 truncate text-sm">
                  {m.name || m.email}{' '}
                  {m.role === 'owner' && (
                    <Crown className="h-3.5 w-3.5 text-amber-500" aria-label={t.family.owner} />
                  )}
                </p>
                <p className="text-xs text-[var(--fg-muted)]">
                  {t.family.used(formatBytes(m.usedBytes))}
                  {m.capBytes ? ` / ${formatBytes(m.capBytes)}` : ''}
                </p>
              </div>
              {isOwner && m.role !== 'owner' && (
                <>
                  <input
                    defaultValue={
                      m.capBytes ? String(Math.round((m.capBytes / 2 ** 30) * 10) / 10) : ''
                    }
                    placeholder="GB"
                    aria-label={t.family.cap}
                    title={t.family.cap}
                    className="h-9 w-20 rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm"
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      void sendJson('PATCH', `/api/family/members/${m.id}`, {
                        capBytes: v ? Math.round(Number(v) * 2 ** 30) : null,
                      })
                        .then(refresh)
                        .catch((err) => toast(errText(err), { tone: 'error' }));
                    }}
                  />
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setConfirm({
                        body: t.family.removeConfirm(m.name || m.email),
                        run: () => sendJson('DELETE', `/api/family/members/${m.id}`),
                      })
                    }
                  >
                    {t.family.remove}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
        {isOwner && o.invites.length > 0 && (
          <div className="mt-3">
            <p className="text-xs text-[var(--fg-muted)]">{t.family.pendingInvites}</p>
            <ul className="mt-1 space-y-1 text-sm">
              {o.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2">
                  <span className="flex-1">
                    {i.channel} · s.d. {formatDate(i.expiresAt)}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-red-600 hover:underline"
                    onClick={() =>
                      void sendJson('DELETE', `/api/family/invites/${i.id}`).then(refresh)
                    }
                  >
                    {t.family.revoke}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="flex justify-end">
        {isOwner ? (
          o.members.length === 1 && (
            <Button
              variant="ghost"
              onClick={() =>
                setConfirm({
                  body: t.family.dissolveConfirm,
                  run: () => postJson('/api/family/dissolve', {}),
                })
              }
            >
              {t.family.dissolve}
            </Button>
          )
        ) : (
          <Button
            variant="ghost"
            onClick={() =>
              setConfirm({
                body: t.family.leaveConfirm,
                run: () => postJson('/api/family/leave', {}),
              })
            }
          >
            {t.family.leave}
          </Button>
        )}
      </div>

      <Dialog open={inviting} title={t.family.invite} onClose={() => setInviting(false)}>
        {inviting && <InvitePanel onDone={() => void refresh()} />}
      </Dialog>
      <Dialog
        open={Boolean(confirm)}
        title={t.family.title}
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const c = confirm!;
                setConfirm(null);
                void c
                  .run()
                  .then(async () => {
                    await refresh();
                    if (me.data && !isOwner) void navigate({ to: '/drive' });
                  })
                  .catch((e) => toast(errText(e), { tone: 'error' }));
              }}
            >
              {t.common.ok}
            </Button>
          </>
        }
      >
        <p className="text-sm">{confirm?.body}</p>
      </Dialog>
    </div>
  );
}

export function FamilyPage() {
  const me = useMe();
  const q = useQuery({ queryKey: ['family'], queryFn: () => api<Overview>('/api/family') });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/api/public/catalog'),
  });
  const [tab, setTab] = useState<'drive' | 'members'>('drive');
  const qc = useQueryClient();
  useEffect(() => void (document.title = `${t.family.title} · Zeiko`), []);
  if (q.isPending || !me.data)
    return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  const fam = q.data?.family;
  if (!fam) {
    const plan = catalog.data?.plans.find((p) => p.kind === 'family');
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className={card}>
          <Users className="h-8 w-8 text-brand-600" />
          <h1 className="mt-3 text-lg font-semibold">{t.family.noFamilyTitle}</h1>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            {t.family.noFamilyBody(plan?.maxMembers ?? 6)}
          </p>
          {plan ? (
            <Button
              className="mt-4"
              onClick={() =>
                void postJson('/api/billing/plan', { planCode: plan.code })
                  .then(() =>
                    Promise.all([
                      qc.invalidateQueries({ queryKey: ['family'] }),
                      qc.invalidateQueries({ queryKey: meQueryKey }),
                    ]),
                  )
                  .catch((e) =>
                    e instanceof ApiError && e.code === 'INSUFFICIENT_BALANCE'
                      ? toast(t.billing.notEnough(formatRupiah(plan.priceIdr)), { tone: 'error' })
                      : toast(errText(e), { tone: 'error' }),
                  )
              }
            >
              {t.family.buy(formatRupiah(plan.priceIdr))}
            </Button>
          ) : (
            <p className="mt-4 text-sm">{t.family.unavailable}</p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <nav
        className="flex gap-1 border-b border-[var(--border)] px-4 pt-2"
        aria-label={t.family.title}
      >
        {(['drive', 'members'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm',
              tab === k
                ? 'border-brand-600 font-medium'
                : 'border-transparent text-[var(--fg-muted)]',
            )}
          >
            {k === 'drive' ? t.family.drive : t.family.members}
          </button>
        ))}
      </nav>
      {tab === 'drive' && me.data.space.familyRootId ? (
        <Drive key="family" folderId={me.data.space.familyRootId} />
      ) : (
        <Members o={fam} />
      )}
    </div>
  );
}

export function JoinFamily({ token }: { token: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['family-invite', token, Boolean(me.data)],
    queryFn: () =>
      api<{
        state: string;
        familyName: string;
        ownerName: string;
        planName: string | null;
        storageBytes: number;
        members: number;
        maxMembers: number;
        you?: {
          inFamily: string | null;
          cooldownUntil: number | null;
          personalPlan: string | null;
          convertCreditIdr: number;
          fits: boolean;
        };
      }>(`/api/family/invites/${token}`),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () =>
      postJson('/api/family/invites/' + token + '/accept', {
        convertPlan: Boolean(q.data?.you?.personalPlan),
      }),
    onSuccess: async () => {
      toast(t.family.join.done);
      await qc.invalidateQueries();
      void navigate({ to: '/keluarga' });
    },
    onError: (e) => toast(errText(e), { tone: 'error' }),
  });
  const d = q.data;
  const you = d?.you;
  const blocked =
    !d || d.state !== 'valid' || !you || you.inFamily || you.cooldownUntil || !you.fits;
  return (
    <div className="flex min-h-screen items-start justify-center bg-[var(--bg-subtle)] p-4 sm:items-center">
      <main className="w-full max-w-md z-card rounded-2xl p-6">
        <Logo />
        {q.isError && <p className="mt-4 text-sm">{t.share.linkNotFound}</p>}
        {d && (
          <>
            <h1 className="mt-4 text-lg font-semibold">{t.family.join.title(d.familyName)}</h1>
            <p className="text-sm text-[var(--fg-muted)]">{t.family.join.by(d.ownerName)}</p>
            {d.planName && (
              <p className="mt-2 text-sm">
                {t.family.join.plan(d.planName, formatBytes(d.storageBytes))}
              </p>
            )}
            {d.state !== 'valid' && (
              <p className="mt-4 text-sm text-red-600">{t.family.join.invalid[d.state]}</p>
            )}
            {d.state === 'valid' && !me.data && (
              <a
                href={`/masuk?next=${encodeURIComponent(`/keluarga/gabung/${token}`)}`}
                className="mt-4 inline-block rounded-full bg-brand-700 px-5 py-2 text-sm font-medium text-white"
              >
                {t.family.join.signIn}
              </a>
            )}
            {you && (
              <div className="mt-4 space-y-2 text-sm">
                {you.inFamily && <p className="text-amber-700">{t.family.join.already}</p>}
                {you.cooldownUntil && (
                  <p className="text-amber-700">
                    {t.family.join.cooldown(formatDate(you.cooldownUntil))}
                  </p>
                )}
                {!you.fits && <p className="text-amber-700">{t.family.join.fitsNo}</p>}
                {you.personalPlan && (
                  <p>{t.family.join.convert(formatRupiah(you.convertCreditIdr))}</p>
                )}
                <p className="text-xs text-[var(--fg-muted)]">{t.family.privacy}</p>
                <Button
                  className="w-full"
                  disabled={Boolean(blocked) || accept.isPending}
                  onClick={() => accept.mutate()}
                >
                  {t.family.join.accept}
                </Button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
