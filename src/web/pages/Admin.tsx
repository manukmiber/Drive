// Panel admin (SPEC §13.1). Staff only; the API enforces role + second factor on every call.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatBytes, formatDateTime, formatRupiah } from '../../shared/format';
import { t } from '../lib/i18n';
import { Button } from '../components/Button';
import { PromptDialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { api, ApiError, postJson, sendJson } from '../lib/api';
import { cn } from '../lib/cn';
import { useMe } from '../lib/session';

const card = 'z-card rounded-2xl p-4';
const input = 'h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm';
type Tab = 'dashboard' | 'users' | 'reports' | 'ads' | 'scanner' | 'config' | 'catalog' | 'audit';

const fail = (e: unknown) =>
  toast(e instanceof ApiError ? `${e.code}: ${e.message}` : t.errors.generic, { tone: 'error' });

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={card}>
      <p className="text-xs text-[var(--fg-muted)]">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {sub && <p className="text-xs text-[var(--fg-muted)]">{sub}</p>}
    </div>
  );
}

interface Dashboard {
  periodDays: number;
  users: { total: number; new: number; active: number };
  revenue: { totalIdr: number; byProduct: Array<{ reason: string; idr: number; n: number }> };
  storage: { usedBytes: number; soldBytes: number };
  plans: Array<{
    plan: string;
    name: string;
    subs: number;
    usedBytes: number;
    revenueIdr: number;
    costAtUsageIdr: number;
    breakEvenUsagePct: number | null;
    scenarios: Array<{ pct: number; marginIdr: number }>;
  }>;
  compress: { used: number; freeQuota: number };
  costs: {
    storageIdr: number;
    compressIdr: number;
    paymentFeesIdr: number;
    totalIdr: number;
    note: string;
  };
  marginIdr: number;
  reports: { open: number; overdue: number };
}

function DashboardTab() {
  const q = useQuery({
    queryKey: ['admin', 'dash'],
    queryFn: () => api<Dashboard>('/api/admin/dashboard'),
  });
  const d = q.data;
  if (!d) return <p className="text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t.admin.usersTotal}
          value={String(d.users.total)}
          sub={`${t.admin.usersActive(d.periodDays)}: ${d.users.active} · baru ${d.users.new}`}
        />
        <Stat
          label={`${t.admin.revenue} (${d.periodDays} hari)`}
          value={formatRupiah(d.revenue.totalIdr)}
          sub={d.revenue.byProduct
            .map((r) => `${t.billing.reasons[r.reason] ?? r.reason}: ${formatRupiah(r.idr)}`)
            .join(' · ')}
        />
        <Stat
          label={t.admin.costs}
          value={formatRupiah(d.costs.totalIdr)}
          sub={`${t.admin.margin}: ${formatRupiah(d.marginIdr)}`}
        />
        <Stat
          label={t.admin.storageUsed}
          value={formatBytes(d.storage.usedBytes)}
          sub={`${t.admin.storageSold}: ${formatBytes(d.storage.soldBytes)}`}
        />
      </div>
      <p className="text-xs text-[var(--fg-muted)]">
        {t.admin.compressUsed(d.compress.used, d.compress.freeQuota)} ·{' '}
        {t.admin.openReports(d.reports.open, d.reports.overdue)}
      </p>
      <div className={cn(card, 'overflow-x-auto')}>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--fg-muted)]">
            <tr>
              <th className="py-1">{t.admin.plan}</th>
              <th>{t.admin.subs}</th>
              <th>{t.admin.used}</th>
              <th>{t.admin.revenue}</th>
              <th>Biaya (aktual)</th>
              <th>Margin @20/50/100%</th>
              <th>{t.admin.breakEven}</th>
            </tr>
          </thead>
          <tbody>
            {d.plans.map((p) => (
              <tr key={p.plan} className="border-t border-[var(--border)]">
                <td className="py-1.5">{p.name}</td>
                <td>{p.subs}</td>
                <td>{formatBytes(p.usedBytes ?? 0)}</td>
                <td>{formatRupiah(p.revenueIdr)}</td>
                <td>{formatRupiah(p.costAtUsageIdr)}</td>
                <td>{p.scenarios.map((s) => formatRupiah(s.marginIdr)).join(' / ')}</td>
                <td>{p.breakEvenUsagePct === null ? '—' : `${p.breakEvenUsagePct}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-[var(--fg-muted)]">{d.costs.note}</p>
      </div>
    </div>
  );
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  planCode: string | null;
  subStatus: string | null;
  usedBytes: number;
  limitBytes: number;
  bonusBytes: number;
  balanceIdr: number;
  createdAt: number;
}

function UserCard({ u, isAdmin }: { u: UserRow; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [delta, setDelta] = useState('');
  const [bonus, setBonus] = useState(String(Math.round((u.bonusBytes / 2 ** 30) * 100) / 100));
  const run = (p: Promise<unknown>) =>
    p
      .then(() => {
        toast(t.admin.saved);
        void qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      })
      .catch(fail);
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 font-medium">{u.email}</p>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs',
            u.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700',
          )}
        >
          {u.status}
        </span>
        <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-xs">{u.role}</span>
      </div>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">
        {u.planCode ?? 'tanpa paket'} {u.subStatus && `(${u.subStatus})`} ·{' '}
        {formatBytes(u.usedBytes ?? 0)} / {formatBytes(u.limitBytes ?? 0)} · Kredit{' '}
        {formatRupiah(u.balanceIdr)} · daftar {formatDateTime(u.createdAt)}
      </p>
      <input
        className={cn(input, 'mt-3')}
        placeholder={t.admin.reason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant={u.status === 'active' ? 'danger' : 'secondary'}
          onClick={() =>
            run(
              postJson(`/api/admin/users/${u.id}/suspend`, {
                suspended: u.status === 'active',
                reason,
              }),
            )
          }
        >
          {u.status === 'active' ? t.admin.suspend : t.admin.unsuspend}
        </Button>
        {isAdmin && (
          <>
            <span className="flex items-center gap-1">
              <input
                className={cn(input, 'w-28')}
                placeholder="±Rp"
                value={delta}
                onChange={(e) => setDelta(e.target.value.replace(/[^\d-]/g, ''))}
                aria-label={t.admin.balance}
              />
              <Button
                variant="secondary"
                onClick={() =>
                  run(
                    postJson(`/api/admin/users/${u.id}/balance`, {
                      deltaIdr: Number(delta),
                      reason,
                    }),
                  )
                }
              >
                Kredit
              </Button>
            </span>
            <span className="flex items-center gap-1">
              <input
                className={cn(input, 'w-20')}
                value={bonus}
                onChange={(e) => setBonus(e.target.value)}
                aria-label={t.admin.bonus}
              />
              <Button
                variant="secondary"
                onClick={() =>
                  run(
                    postJson(`/api/admin/users/${u.id}/bonus`, {
                      bonusBytes: Math.round(Number(bonus) * 2 ** 30),
                      reason,
                    }),
                  )
                }
              >
                Bonus GB
              </Button>
            </span>
            <select
              className={cn(input, 'w-32')}
              value={u.role}
              onChange={(e) =>
                run(postJson(`/api/admin/users/${u.id}/role`, { role: e.target.value, reason }))
              }
              aria-label={t.admin.role}
            >
              <option value="user">user</option>
              <option value="moderator">moderator</option>
              <option value="admin">admin</option>
            </select>
          </>
        )}
      </div>
    </div>
  );
}

function UsersTab({ isAdmin }: { isAdmin: boolean }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const users = useQuery({
    queryKey: ['admin', 'users', term],
    queryFn: () => api<{ items: UserRow[] }>(`/api/admin/users?q=${encodeURIComponent(term)}`),
  });
  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--fg-muted)]">{t.admin.noContentAccess}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q);
        }}
      >
        <input
          className={input}
          placeholder={t.admin.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>
      {(users.data?.items ?? []).map((u) => (
        <UserCard key={u.id} u={u} isAdmin={isAdmin} />
      ))}
    </div>
  );
}

interface ReportRow {
  id: string;
  targetType: string;
  targetId: string;
  category: string;
  priority: string;
  details: string | null;
  reporterContact: string | null;
  status: string;
  slaDueAt: number;
  createdAt: number;
}

function ReportCard({ r, now }: { r: ReportRow; now: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const detail = useQuery({
    queryKey: ['admin', 'report', r.id],
    queryFn: () =>
      api<{
        files: Array<{
          id: string;
          name: string;
          kind: string;
          size: number;
          scanStatus: string;
          held: number | null;
        }>;
      }>(`/api/admin/reports/${r.id}`),
    enabled: open,
  });
  const act = useMutation({
    mutationFn: (actions: string[]) =>
      postJson(`/api/admin/reports/${r.id}/actions`, { actions, note }),
    onSuccess: () => {
      toast(t.admin.saved);
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: fail,
  });
  const late = r.slaDueAt < now && (r.status === 'open' || r.status === 'in_review');
  const left = Math.round((r.slaDueAt - now) / 60_000);
  return (
    <div className={cn(card, r.priority === 'urgent' && 'border-red-400')}>
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        {r.priority === 'urgent' && <AlertTriangle className="h-4 w-4 text-red-600" />}
        <span className="font-medium">{t.report.categories[r.category] ?? r.category}</span>
        <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-xs">{r.status}</span>
        <span
          className={cn(
            'ml-auto text-xs',
            late ? 'font-semibold text-red-600' : 'text-[var(--fg-muted)]',
          )}
        >
          {t.admin.sla}: {late ? t.admin.overdue : `${Math.floor(left / 60)}j ${left % 60}m`}
        </span>
      </button>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">
        {r.targetType} {r.targetId.slice(0, 16)}… · {formatDateTime(r.createdAt)}{' '}
        {r.reporterContact && `· ${r.reporterContact}`}
      </p>
      {r.details && <p className="mt-2 text-sm whitespace-pre-wrap">{r.details}</p>}
      {open && (
        <div className="mt-3 space-y-2">
          {(detail.data?.files ?? []).map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="flex-1 truncate">
                {f.name}{' '}
                <span className="text-xs text-[var(--fg-muted)]">
                  ({f.kind === 'file' ? formatBytes(f.size) : 'folder'} · {f.scanStatus ?? '—'}
                  {f.held ? ' · legal hold' : ''})
                </span>
              </span>
              {f.kind === 'file' && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void postJson<{ url: string }>(`/api/admin/reports/${r.id}/preview`, {
                      nodeId: f.id,
                    })
                      .then(({ url }) => window.open(url, '_blank', 'noopener'))
                      .catch(fail)
                  }
                >
                  {t.admin.reviewContent}
                </Button>
              )}
            </div>
          ))}
          <input
            className={input}
            placeholder={t.admin.note}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(t.admin.actions).map(([k, label]) => (
              <Button
                key={k}
                variant={
                  k === 'delete' || k === 'ban_uploader'
                    ? 'danger'
                    : k === 'resolve'
                      ? 'primary'
                      : 'secondary'
                }
                disabled={note.trim().length < 3 || act.isPending}
                onClick={() => act.mutate([k])}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReportsTab() {
  const [status, setStatus] = useState('active');
  const [now] = useState(() => Date.now());
  const q = useQuery({
    queryKey: ['admin', 'reports', status],
    queryFn: () => api<{ items: ReportRow[] }>(`/api/admin/reports?status=${status}`),
    refetchInterval: 60_000,
  });
  return (
    <div className="space-y-3">
      <select
        className={cn(input, 'w-48')}
        value={status}
        onChange={(e) => setStatus(e.target.value)}
      >
        {['active', 'open', 'in_review', 'resolved', 'rejected', 'all'].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      {(q.data?.items ?? []).map((r) => (
        <ReportCard key={r.id} r={r} now={now} />
      ))}
      {q.isSuccess && !q.data.items.length && (
        <p className="text-sm text-[var(--fg-muted)]">{t.common.empty}</p>
      )}
    </div>
  );
}

type AdReviewRow = {
  id: string;
  title: string;
  body: string;
  hasImage: boolean;
  ctaType: string;
  ctaValue: string;
  category: string;
  status: string;
  rejectReason: string | null;
  businessName: string;
  advertiserKind: string;
  openReports: number;
};

function AdsTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [severe, setSevere] = useState(false);
  const q = useQuery({
    queryKey: ['admin', 'ads', status],
    queryFn: () => api<{ items: AdReviewRow[] }>(`/api/admin/ads?status=${status}`),
  });
  const act = useMutation({
    mutationFn: ({
      id,
      kind,
      reason,
    }: {
      id: string;
      kind: 'approve' | 'reject' | 'suspend';
      reason: string;
    }) =>
      kind === 'suspend'
        ? postJson(`/api/admin/ads/${id}/suspend`, { severe, reason })
        : postJson(`/api/admin/ads/${id}/review`, { decision: kind, reason }),
    onSuccess: async () => {
      toast(t.admin.saved);
      await qc.invalidateQueries({ queryKey: ['admin', 'ads'] });
    },
    onError: () => toast(t.errors.generic, { tone: 'error' }),
  });
  const [asking, setAsking] = useState<{ id: string; kind: 'reject' | 'suspend' } | null>(null);
  const ask = (id: string, kind: 'approve' | 'reject' | 'suspend') =>
    kind === 'approve' ? act.mutate({ id, kind, reason: '' }) : setAsking({ id, kind });
  return (
    <div className="space-y-3">
      <h2 className="font-medium">{t.ads.adminTitle}</h2>
      <PromptDialog
        open={Boolean(asking)}
        title={t.ads.reasonPrompt}
        initial=""
        confirmLabel={asking?.kind === 'suspend' ? t.ads.suspend : t.ads.reject}
        onCancel={() => setAsking(null)}
        onSubmit={(reason) => {
          const a = asking!;
          setAsking(null);
          if (reason.trim()) act.mutate({ id: a.id, kind: a.kind, reason: reason.trim() });
        }}
      />
      <select
        className={cn(input, 'w-48')}
        value={status}
        onChange={(e) => setStatus(e.target.value)}
      >
        {['pending', 'approved', 'rejected', 'suspended'].map((s) => (
          <option key={s} value={s}>
            {t.ads.statuses[s]}
          </option>
        ))}
      </select>
      {status === 'approved' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={severe} onChange={(e) => setSevere(e.target.checked)} />
          {t.ads.severe}
        </label>
      )}
      {(q.data?.items ?? []).map((a) => (
        <div key={a.id} className="flex gap-3 rounded-xl border border-[var(--border)] p-3 text-sm">
          {a.hasImage && (
            <img
              src={`/api/admin/ads/${a.id}/image`}
              alt=""
              className="h-20 w-20 shrink-0 rounded-lg object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{a.title}</p>
            <p className="text-[var(--fg-muted)]">{a.body}</p>
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              {a.businessName} ({t.ads.kinds[a.advertiserKind]}) · {t.ads.categories[a.category]} ·{' '}
              {t.ads.ctaTypes[a.ctaType]}: <code className="break-all">{a.ctaValue}</code>
              {a.openReports > 0 && (
                <b className="ml-2 text-red-700">{t.ads.openReports(a.openReports)}</b>
              )}
            </p>
            {a.rejectReason && <p className="text-xs text-red-700">{a.rejectReason}</p>}
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            {a.status === 'pending' && (
              <>
                <Button onClick={() => ask(a.id, 'approve')}>{t.ads.approve}</Button>
                <Button variant="ghost" onClick={() => ask(a.id, 'reject')}>
                  {t.ads.reject}
                </Button>
              </>
            )}
            {a.status === 'approved' && (
              <Button variant="ghost" onClick={() => ask(a.id, 'suspend')}>
                {t.ads.suspend}
              </Button>
            )}
          </div>
        </div>
      ))}
      {q.isSuccess && !q.data.items.length && (
        <p className="text-sm text-[var(--fg-muted)]">{t.common.empty}</p>
      )}
    </div>
  );
}

function ScannerTab() {
  const q = useQuery({
    queryKey: ['admin', 'scanner'],
    queryFn: () =>
      api<{
        last7Days: Array<{ status: string; n: number; bytes: number }>;
        errorRatePct: number;
        recent: Array<{
          id: string;
          status: string;
          detail: string | null;
          attempts: number;
          size: number;
          createdAt: number;
        }>;
        blockedHashes: number;
        scanner: string;
      }>('/api/admin/scanner'),
  });
  const d = q.data;
  if (!d) return <p className="text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Scanner: <b>{d.scanner}</b> · {t.admin.errorRate(d.errorRatePct)} · {d.blockedHashes} hash
        diblokir
      </p>
      <div className="flex flex-wrap gap-2">
        {d.last7Days.map((s) => (
          <span key={s.status} className="rounded-full bg-[var(--bg-subtle)] px-3 py-1 text-xs">
            {s.status}: {s.n} ({formatBytes(s.bytes)})
          </span>
        ))}
      </div>
      <ul className="divide-y divide-[var(--border)] text-sm">
        {d.recent.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-2 py-2">
            <span className="flex-1 font-mono text-xs">{b.id}</span>
            <span className="text-xs">
              {b.status} {b.detail && `· ${b.detail}`} · {b.attempts}× · {formatBytes(b.size)}
            </span>
            {b.status === 'error' && (
              <Button
                variant="secondary"
                onClick={() =>
                  void postJson(`/api/admin/scanner/${b.id}/retry`, {}).then(
                    () => toast(t.admin.saved),
                    fail,
                  )
                }
              >
                {t.admin.retry}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfigRow({
  item,
}: {
  item: { key: string; value: unknown; default: unknown; updatedAt: number | null };
}) {
  const [text, setText] = useState(JSON.stringify(item.value, null, 1));
  const changed = text !== JSON.stringify(item.value, null, 1);
  const save = () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      toast('JSON tidak valid', { tone: 'error' });
      return;
    }
    void sendJson('PUT', `/api/admin/config/${item.key}`, { value }).then(
      () => toast(t.admin.saved),
      fail,
    );
  };
  const multiline = text.includes('\n');
  return (
    <div className="grid gap-1 border-t border-[var(--border)] py-2 md:grid-cols-[16rem_1fr_auto] md:items-start">
      <div>
        <p className="font-mono text-xs">{item.key}</p>
        {JSON.stringify(item.value) !== JSON.stringify(item.default) && (
          <p className="text-[11px] text-amber-700">
            diubah {item.updatedAt ? formatDateTime(item.updatedAt) : ''}
          </p>
        )}
      </div>
      {multiline ? (
        <textarea
          className="min-h-20 w-full rounded-lg border border-[var(--border)] bg-transparent p-2 font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <input
          className={cn(input, 'font-mono text-xs')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <Button variant="secondary" disabled={!changed} onClick={save}>
        {t.common.save}
      </Button>
    </div>
  );
}

function ConfigTab() {
  const q = useQuery({
    queryKey: ['admin', 'config'],
    queryFn: () =>
      api<{
        items: Array<{ key: string; value: unknown; default: unknown; updatedAt: number | null }>;
      }>('/api/admin/config'),
  });
  const [filter, setFilter] = useState('');
  return (
    <div className={card}>
      <p className="mb-2 text-xs text-[var(--fg-muted)]">{t.admin.configHint}</p>
      <input
        className={cn(input, 'mb-2')}
        placeholder={t.admin.filter}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {(q.data?.items ?? [])
        .filter((i) => i.key.includes(filter))
        .map((i) => (
          <ConfigRow key={i.key} item={i} />
        ))}
    </div>
  );
}

function CatalogTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'catalog'],
    queryFn: () =>
      api<Record<string, Array<Record<string, string | number>>>>('/api/admin/catalog'),
  });
  const save = (kind: string, code: string, field: string, raw: string) => {
    const value =
      field === 'name'
        ? raw
        : field === 'active' || field === 'show_ads'
          ? raw === '1'
          : Number(raw);
    void sendJson('PATCH', `/api/admin/catalog/${kind}/${code}`, { [field]: value })
      .then(() => {
        toast(t.admin.saved);
        void qc.invalidateQueries({ queryKey: ['admin', 'catalog'] });
        void qc.invalidateQueries({ queryKey: ['catalog'] });
      })
      .catch(fail);
  };
  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--fg-muted)]">
        Perubahan harga berlaku untuk pembelian baru dan perpanjangan berikutnya. Ukuran dalam byte.
      </p>
      {Object.entries(q.data ?? {}).map(([kind, rows]) => (
        <div key={kind} className={cn(card, 'overflow-x-auto')}>
          <p className="mb-2 font-medium">{kind}</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--fg-muted)]">
                {Object.keys(rows[0] ?? {}).map((k) => (
                  <th key={k} className="px-1 py-1">
                    {k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.code)} className="border-t border-[var(--border)]">
                  {Object.entries(row).map(([k, v]) => (
                    <td key={k} className="px-1 py-1">
                      {k === 'code' || k === 'kind' ? (
                        <span className="font-mono">{String(v)}</span>
                      ) : (
                        <input
                          defaultValue={String(v)}
                          className="h-7 w-24 rounded border border-[var(--border)] bg-transparent px-1"
                          onBlur={(e) =>
                            e.target.value !== String(v) &&
                            save(kind, String(row.code), k, e.target.value)
                          }
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function AuditTab() {
  const [action, setAction] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'audit', action],
    queryFn: () =>
      api<{
        items: Array<{
          id: string;
          actorEmail: string | null;
          action: string;
          targetType: string;
          targetId: string;
          meta: string;
          createdAt: number;
        }>;
      }>(`/api/admin/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`),
  });
  return (
    <div className="space-y-2">
      <input
        className={input}
        placeholder={t.admin.auditFilter}
        value={action}
        onChange={(e) => setAction(e.target.value)}
      />
      <ul className="divide-y divide-[var(--border)] text-xs">
        {(q.data?.items ?? []).map((a) => (
          <li key={a.id} className="py-2">
            <p>
              <b>{a.action}</b> · {a.targetType} <span className="font-mono">{a.targetId}</span> ·{' '}
              {a.actorEmail ?? 'sistem'} · {formatDateTime(a.createdAt)}
            </p>
            <p className="font-mono break-all text-[var(--fg-muted)]">{a.meta}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Admin() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('dashboard');
  const who = useQuery({
    queryKey: ['admin', 'whoami'],
    queryFn: () => api<{ user: { role: string } }>('/api/admin/whoami'),
    retry: false,
  });
  useEffect(() => void (document.title = `${t.admin.title} · Zeiko`), []);
  if (who.isPending)
    return <p className="p-6 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (who.isError) {
    const need2fa =
      who.error instanceof ApiError &&
      (who.error.data as { reason?: string } | undefined)?.reason === 'ADMIN_2FA_REQUIRED';
    return (
      <div className="mx-auto max-w-lg p-6">
        <p className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4" /> {need2fa ? t.admin.need2fa : t.admin.forbidden}
        </p>
      </div>
    );
  }
  const isAdmin = me.data?.user.role === 'admin';
  const tabs: Tab[] = isAdmin
    ? ['dashboard', 'users', 'reports', 'ads', 'scanner', 'config', 'catalog', 'audit']
    : ['users', 'reports', 'ads', 'scanner'];
  const active = tabs.includes(tab) ? tab : tabs[0]!;
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <h1 className="text-xl font-semibold">{t.admin.title}</h1>
      <nav className="my-4 flex gap-1 overflow-x-auto" aria-label={t.a11y.adminSections}>
        {tabs.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'shrink-0 rounded-full px-4 py-1.5 text-sm',
              active === k ? 'bg-brand-700 text-white' : 'hover:bg-[var(--bg-subtle)]',
            )}
          >
            {t.admin.tabs[k]}
          </button>
        ))}
      </nav>
      {active === 'dashboard' && <DashboardTab />}
      {active === 'users' && <UsersTab isAdmin={isAdmin} />}
      {active === 'reports' && <ReportsTab />}
      {active === 'ads' && <AdsTab />}
      {active === 'scanner' && <ScannerTab />}
      {active === 'config' && <ConfigTab />}
      {active === 'catalog' && <CatalogTab />}
      {active === 'audit' && <AuditTab />}
    </div>
  );
}
