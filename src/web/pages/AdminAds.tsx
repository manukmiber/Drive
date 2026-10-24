// Admin → Iklan (ADR-043). An advertiser emails the operator; the operator enters the ad here, every
// creative is checked by a person (UMKM, small businesses and students first), and the advertiser
// pays on /iklan once it is approved. Takedowns and the campaign list live here too.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ImagePlus, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  AD_BODY_MAX,
  AD_CATEGORIES,
  AD_CTA_TYPES,
  AD_TITLE_MAX,
  adCampaignPricePerDay,
} from '../../shared/ad-policy';
import { formatRupiah } from '../../shared/format';
import { wibDate } from '../../shared/time';
import { t } from '../lib/i18n';
import { Button } from '../components/Button';
import { PromptDialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import {
  createCampaign,
  findAdvertiser,
  saveAdvertiser,
  saveCreative,
  searchAreas,
  toAdWebp,
  uploadCreativeImage,
  type Area,
  type AreaRef,
  type CreativeInput,
  type OperatorAdvertiser,
} from '../lib/ads';
import { api, postJson } from '../lib/api';
import { useCatalog } from '../lib/catalog';
import { cn } from '../lib/cn';
import { adError } from './Advertiser';

const box = 'rounded-xl border border-[var(--border)] p-3 text-sm';
const input = 'h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm';
const label = 'block text-xs text-[var(--fg-muted)]';
const KEY = ['admin', 'ads'] as const;

type Sub = 'queue' | 'new' | 'campaigns' | 'checked';

type ReviewRow = {
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
  advertiserEmail: string;
  openReports: number;
  waitingCampaigns: number;
  flag: string | null;
};

type CampaignRow = {
  id: string;
  title: string;
  businessName: string;
  advertiserKind: string;
  advertiserEmail: string;
  scope: 'cities' | 'national';
  areas: AreaRef[];
  startDate: string;
  endDate: string;
  days: number;
  pricePerDayIdr: number;
  totalIdr: number;
  status: string;
  reason: string | null;
  impressions: number;
  clicks: number;
};

const fail = (e: unknown) => toast(adError(e), { tone: 'error' });

export function AdsTab({ isAdmin }: { isAdmin: boolean }) {
  const [sub, setSub] = useState<Sub>('queue');
  const subs: Sub[] = isAdmin ? ['queue', 'new', 'campaigns', 'checked'] : ['queue', 'campaigns', 'checked'];
  return (
    <div className="space-y-3">
      <h2 className="font-medium">{t.ads.adminTitle}</h2>
      <nav className="flex flex-wrap gap-2" aria-label={t.ads.adminTitle}>
        {subs.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={sub === k}
            onClick={() => setSub(k)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm',
              sub === k
                ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-800/40'
                : 'border-[var(--border)]',
            )}
          >
            {t.ads.adminTabs[k]}
          </button>
        ))}
      </nav>
      {sub === 'queue' && <Review statuses={['pending']} />}
      {sub === 'checked' && <Review statuses={['approved', 'rejected', 'suspended']} />}
      {sub === 'new' && isAdmin && <NewAd onDone={() => setSub('queue')} />}
      {sub === 'campaigns' && <Campaigns isAdmin={isAdmin} />}
    </div>
  );
}

// ───────────────────────────── the manual check ─────────────────────────────

function Review({ statuses }: { statuses: string[] }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(statuses[0]!);
  const [severe, setSevere] = useState(false);
  const q = useQuery({
    queryKey: [...KEY, 'review', status],
    queryFn: () => api<{ items: ReviewRow[] }>(`/api/admin/ads?status=${status}`),
  });
  const act = useMutation({
    mutationFn: ({ id, kind, reason }: { id: string; kind: 'approve' | 'reject' | 'suspend'; reason: string }) =>
      kind === 'suspend'
        ? postJson(`/api/admin/ads/${id}/suspend`, { severe, reason })
        : postJson(`/api/admin/ads/${id}/review`, { decision: kind, reason }),
    onSuccess: async () => {
      toast(t.admin.saved);
      await qc.invalidateQueries({ queryKey: KEY });
    },
    onError: fail,
  });
  const [asking, setAsking] = useState<{ id: string; kind: 'reject' | 'suspend' } | null>(null);
  const ask = (id: string, kind: 'approve' | 'reject' | 'suspend') =>
    kind === 'approve' ? act.mutate({ id, kind, reason: '' }) : setAsking({ id, kind });
  return (
    <div className="space-y-3">
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
      {statuses.length > 1 && (
        <select className={cn(input, 'w-48')} value={status} onChange={(e) => setStatus(e.target.value)}>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {t.ads.statuses[s]}
            </option>
          ))}
        </select>
      )}
      {status === 'approved' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={severe} onChange={(e) => setSevere(e.target.checked)} />
          {t.ads.severe}
        </label>
      )}
      {(q.data?.items ?? []).map((a) => (
        <div key={a.id} className={cn(box, 'flex gap-3')}>
          {a.hasImage && (
            <img
              src={`/api/admin/ads/${a.id}/image`}
              alt=""
              className="h-20 w-20 shrink-0 rounded-lg object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {a.title}
              {a.advertiserKind !== 'lainnya' && (
                <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-800 dark:bg-brand-800/40">
                  {t.ads.priority}
                </span>
              )}
            </p>
            <p className="text-[var(--fg-muted)]">{a.body}</p>
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              {a.businessName} ({t.ads.kinds[a.advertiserKind]}) · {a.advertiserEmail} ·{' '}
              {t.ads.categories[a.category]} · {t.ads.ctaTypes[a.ctaType]}:{' '}
              <code className="break-all">{a.ctaValue}</code>
              {a.openReports > 0 && <b className="ml-2 text-red-700">{t.ads.openReports(a.openReports)}</b>}
            </p>
            {a.flag && (
              <p className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {t.ads.flag(a.flag)}
              </p>
            )}
            {a.status === 'pending' && a.waitingCampaigns > 0 && (
              <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.ads.waitingCampaigns(a.waitingCampaigns)}</p>
            )}
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
        <p className="text-sm text-[var(--fg-muted)]">
          {status === 'pending' ? t.ads.queueEmpty : t.common.empty}
        </p>
      )}
    </div>
  );
}

// ───────────────────────────── entering an ad from an email ─────────────────────────────

function NewAd({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<OperatorAdvertiser | null>(null);
  const find = useMutation({
    mutationFn: () => findAdvertiser(email.trim()),
    onSuccess: setFound,
    onError: (e) => (setFound(null), fail(e)),
  });
  return (
    <section className={cn(box, 'space-y-4')}>
      <div>
        <h3 className="font-medium">{t.ads.newTitle}</h3>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.ads.newBody}</p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) find.mutate();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className={label}>{t.ads.advertiserEmail}</span>
          <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <Button className="self-end" type="submit" disabled={find.isPending}>
          <Search className="h-4 w-4" aria-hidden="true" /> {t.ads.find}
        </Button>
      </form>
      {found && (
        <Steps
          key={found.user.id}
          data={found}
          onChange={setFound}
          onDone={async () => {
            await qc.invalidateQueries({ queryKey: KEY });
            onDone();
          }}
        />
      )}
    </section>
  );
}

function Steps({
  data,
  onChange,
  onDone,
}: {
  data: OperatorAdvertiser;
  onChange: (d: OperatorAdvertiser) => void;
  onDone: () => void;
}) {
  const [adv, setAdv] = useState({
    businessName: data.advertiser?.businessName ?? data.user.name ?? '',
    kind: data.advertiser?.kind ?? 'umkm',
    phone: data.advertiser?.phone ?? '',
  });
  const save = useMutation({
    mutationFn: () => saveAdvertiser({ email: data.user.email, ...adv }),
    onSuccess: (d) => (onChange(d), toast(t.admin.saved)),
    onError: fail,
  });
  const usable = data.creatives.filter((c) => c.status !== 'rejected' && c.status !== 'suspended');
  const [creativeId, setCreativeId] = useState<string>(usable[0]?.id ?? 'new');
  return (
    <div className="space-y-4">
      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="mb-1 text-xs font-medium">{t.ads.advertiser}: {data.user.email}</legend>
        <label>
          <span className={label}>{t.ads.businessName}</span>
          <input
            className={input}
            value={adv.businessName}
            onChange={(e) => setAdv({ ...adv, businessName: e.target.value })}
          />
        </label>
        <label>
          <span className={label}>{t.ads.kind}</span>
          <select className={input} value={adv.kind} onChange={(e) => setAdv({ ...adv, kind: e.target.value })}>
            {['umkm', 'mahasiswa', 'lainnya'].map((k) => (
              <option key={k} value={k}>
                {t.ads.kinds[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={label}>{t.ads.phone}</span>
          <input className={input} value={adv.phone} onChange={(e) => setAdv({ ...adv, phone: e.target.value })} />
        </label>
        <div className="sm:col-span-3">
          <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate()}>
            {t.ads.saveAdvertiser}
          </Button>
        </div>
      </fieldset>
      {data.advertiser && (
        <>
          <label className="block">
            <span className={label}>{t.ads.creative}</span>
            <select className={input} value={creativeId} onChange={(e) => setCreativeId(e.target.value)}>
              {usable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} · {t.ads.statuses[c.status]}
                </option>
              ))}
              <option value="new">{t.ads.newCreative}</option>
            </select>
          </label>
          {creativeId === 'new' ? (
            <CreativeForm
              advertiserId={data.user.id}
              onSaved={async (id) => {
                onChange(await findAdvertiser(data.user.email));
                setCreativeId(id);
              }}
            />
          ) : (
            <CampaignForm creativeId={creativeId} onDone={onDone} />
          )}
        </>
      )}
    </div>
  );
}

function CreativeForm({
  advertiserId,
  onSaved,
}: {
  advertiserId: string;
  onSaved: (id: string) => Promise<void>;
}) {
  const catalog = useCatalog();
  const maxBytes = Number(catalog.data?.config.ad_image_max_bytes ?? 200 * 1024);
  const [f, setF] = useState<CreativeInput>({
    title: '',
    body: '',
    ctaType: 'whatsapp',
    ctaValue: '',
    category: 'kuliner',
  });
  const [file, setFile] = useState<File | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('IMAGE_REQUIRED');
      const blob = await toAdWebp(file, maxBytes);
      if (!blob) throw new Error('UNSUPPORTED');
      const c = await saveCreative(advertiserId, f);
      await uploadCreativeImage(advertiserId, c.id, blob);
      return c.id;
    },
    onSuccess: (id) => onSaved(id),
    onError: (e) =>
      e instanceof Error && e.message === 'UNSUPPORTED'
        ? toast(t.ads.imageUnsupported, { tone: 'error' })
        : e instanceof Error && e.message === 'IMAGE_REQUIRED'
          ? toast(t.ads.errors.IMAGE_REQUIRED!, { tone: 'error' })
          : fail(e),
  });
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="sm:col-span-2">
        <span className={label}>{t.ads.headline(AD_TITLE_MAX)}</span>
        <input
          className={input}
          maxLength={AD_TITLE_MAX}
          value={f.title}
          onChange={(e) => setF({ ...f, title: e.target.value })}
        />
      </label>
      <label className="sm:col-span-2">
        <span className={label}>{t.ads.body(AD_BODY_MAX)}</span>
        <input
          className={input}
          maxLength={AD_BODY_MAX}
          value={f.body}
          onChange={(e) => setF({ ...f, body: e.target.value })}
        />
      </label>
      <label>
        <span className={label}>{t.ads.ctaType}</span>
        <select className={input} value={f.ctaType} onChange={(e) => setF({ ...f, ctaType: e.target.value })}>
          {AD_CTA_TYPES.map((x) => (
            <option key={x} value={x}>
              {t.ads.ctaTypes[x]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={label} aria-hidden="true">
          &nbsp;
        </span>
        <input
          className={input}
          aria-label={t.ads.ctaTypes[f.ctaType]}
          placeholder={t.ads.ctaValue[f.ctaType]}
          value={f.ctaValue}
          onChange={(e) => setF({ ...f, ctaValue: e.target.value })}
        />
      </label>
      <label>
        <span className={label}>{t.ads.category}</span>
        <select className={input} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {AD_CATEGORIES.map((x) => (
            <option key={x} value={x}>
              {t.ads.categories[x]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className={label}>{t.ads.image}</span>
        <span className="mt-1 flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-2 text-xs">
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          <span className="truncate">{file?.name ?? t.ads.imageHint(Math.round(maxBytes / 1024))}</span>
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </span>
      </label>
      <div className="sm:col-span-2">
        <Button disabled={save.isPending || !f.title.trim() || !f.body.trim()} onClick={() => save.mutate()}>
          {t.ads.saveCreative}
        </Button>
      </div>
    </div>
  );
}

function CityPicker({ value, onChange }: { value: AreaRef[]; onChange: (v: AreaRef[]) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);
  const hits = useQuery({
    queryKey: ['ad-areas', debounced],
    queryFn: () => searchAreas(debounced),
    enabled: debounced.length >= 2,
  });
  const cities = (hits.data?.areas ?? []).filter(
    (a: Area) => a.level === 'regency' && !value.some((v) => v.code === a.code),
  );
  return (
    <div className="space-y-2">
      <input className={input} placeholder={t.ads.areaSearch} value={q} onChange={(e) => setQ(e.target.value)} />
      {cities.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-[var(--border)]">
          {cities.map((a) => (
            <li key={a.code}>
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-subtle)]"
                onClick={() => (onChange([...value, { code: a.code, name: a.name }]), setQ(''))}
              >
                {a.name}
                {a.province && <span className="text-[var(--fg-muted)]"> · {a.province}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {value.map((a) => (
            <li
              key={a.code}
              className="flex items-center gap-1 rounded-full border border-[var(--border)] py-0.5 pl-2.5 pr-1 text-xs"
            >
              {a.name}
              <button
                type="button"
                aria-label={`${t.ads.cancel} ${a.name}`}
                className="rounded-full p-0.5 hover:bg-[var(--bg-subtle)]"
                onClick={() => onChange(value.filter((v) => v.code !== a.code))}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CampaignForm({ creativeId, onDone }: { creativeId: string; onDone: () => void }) {
  const catalog = useCatalog();
  const cfg = (catalog.data?.config ?? {}) as Record<string, unknown>;
  const n = (k: string, d: number) => Number(cfg[k] ?? d);
  const [scope, setScope] = useState<'cities' | 'national'>('cities');
  const [cities, setCities] = useState<AreaRef[]>([]);
  const [today] = useState(() => wibDate(Date.now()));
  const [startDate, setStartDate] = useState(today);
  const [days, setDays] = useState(7);
  const perDay = adCampaignPricePerDay(
    {
      ad_price_city_idr: n('ad_price_city_idr', 1000),
      ad_price_bundle_idr: n('ad_price_bundle_idr', 3000),
      ad_bundle_cities: n('ad_bundle_cities', 10),
      ad_price_national_idr: n('ad_price_national_idr', 10000),
    },
    scope,
    cities.length,
  );
  const create = useMutation({
    mutationFn: () =>
      createCampaign({ creativeId, scope, areaCodes: cities.map((c) => c.code), startDate, days }),
    onSuccess: (k) => {
      toast(k.status === 'pending' ? t.ads.createdPending : t.ads.createdPayable);
      onDone();
    },
    onError: fail,
  });
  const ready = scope === 'national' || cities.length > 0;
  return (
    <div className="space-y-3">
      <fieldset>
        <legend className={label}>{t.ads.scope}</legend>
        <div className="mt-1 flex gap-4">
          {(['cities', 'national'] as const).map((s) => (
            <label key={s} className="flex items-center gap-2">
              <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} />
              {t.ads.scopes[s]}
            </label>
          ))}
        </div>
      </fieldset>
      {scope === 'cities' && <CityPicker value={cities} onChange={setCities} />}
      <div className="grid grid-cols-2 gap-2">
        <label>
          <span className={label}>{t.ads.start}</span>
          <input
            className={input}
            type="date"
            min={today}
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label>
          <span className={label}>{t.ads.days}</span>
          <input
            className={input}
            type="number"
            min={1}
            max={n('ad_campaign_max_days', 90)}
            value={days}
            onChange={(e) => setDays(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          />
        </label>
      </div>
      {ready && (
        <p className="font-medium tabular-nums">
          {t.ads.quote(formatRupiah(perDay), days, formatRupiah(perDay * days))}
        </p>
      )}
      <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
        {t.ads.createCampaign}
      </Button>
    </div>
  );
}

// ───────────────────────────── campaigns ─────────────────────────────

function Campaigns({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const q = useQuery({
    queryKey: [...KEY, 'campaigns', status],
    queryFn: () =>
      api<{ items: CampaignRow[] }>(`/api/admin/ads/campaigns${status ? `?status=${status}` : ''}`),
  });
  const resend = useMutation({
    mutationFn: (id: string) =>
      postJson<{ sent: string }>(`/api/admin/ads/campaigns/${id}/send-payment`, {}),
    onSuccess: async (r) => {
      toast(t.ads.resent[r.sent] ?? t.admin.saved, r.sent === 'failed' ? { tone: 'error' } : undefined);
      await qc.invalidateQueries({ queryKey: KEY });
    },
    onError: fail,
  });
  const [cancelling, setCancelling] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      postJson(`/api/admin/ads/campaigns/${id}/cancel`, { reason }),
    onSuccess: async () => {
      toast(t.admin.saved);
      await qc.invalidateQueries({ queryKey: KEY });
    },
    onError: fail,
  });
  return (
    <div className="space-y-3">
      <PromptDialog
        open={Boolean(cancelling)}
        title={t.ads.reasonPrompt}
        initial=""
        confirmLabel={t.ads.cancel}
        onCancel={() => setCancelling(null)}
        onSubmit={(reason) => {
          const id = cancelling!;
          setCancelling(null);
          if (reason.trim().length >= 3) cancel.mutate({ id, reason: reason.trim() });
        }}
      />
      <select className={cn(input, 'w-56')} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">{t.ads.all}</option>
        {['pending', 'awaiting_payment', 'paid', 'live', 'completed', 'expired', 'rejected', 'cancelled', 'suspended'].map(
          (s) => (
            <option key={s} value={s}>
              {t.ads.statuses[s]}
            </option>
          ),
        )}
      </select>
      {(q.data?.items ?? []).map((k) => (
        <div key={k.id} className={cn(box, 'flex flex-wrap items-start justify-between gap-2')}>
          <div className="min-w-0">
            <p className="font-medium">
              {k.title} · {t.ads.statuses[k.status] ?? k.status}
            </p>
            <p className="text-xs text-[var(--fg-muted)]">
              {k.businessName} ({t.ads.kinds[k.advertiserKind]}) · {k.advertiserEmail}
            </p>
            <p className="text-xs text-[var(--fg-muted)]">
              {k.scope === 'national' ? t.ads.national : k.areas.map((a) => a.name).join(', ')} ·{' '}
              {t.ads.dates(k.startDate, k.endDate, k.days)} · {formatRupiah(k.totalIdr)}
            </p>
            <p className="text-xs tabular-nums text-[var(--fg-muted)]">
              {t.ads.impressions} {k.impressions.toLocaleString()} · {t.ads.clicks} {k.clicks.toLocaleString()}
            </p>
            {k.reason && <p className="text-xs text-red-700">{t.ads.reason(k.reason)}</p>}
          </div>
          {isAdmin && (k.status === 'pending' || k.status === 'awaiting_payment') && (
            <div className="flex shrink-0 flex-col gap-1">
              {k.status === 'awaiting_payment' && (
                <Button disabled={resend.isPending} onClick={() => resend.mutate(k.id)}>
                  {t.ads.resend}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setCancelling(k.id)}>
                {t.ads.cancel}
              </Button>
            </div>
          )}
        </div>
      ))}
      {q.isSuccess && !q.data.items.length && <p className="text-sm text-[var(--fg-muted)]">{t.common.empty}</p>}
    </div>
  );
}
