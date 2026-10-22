// /iklan — self-serve local ads (SPEC §10.5): register, creatives, booking calendar, stats.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ImagePlus, Megaphone, Plus } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { AD_BODY_MAX, AD_CATEGORIES, AD_CTA_TYPES, AD_TITLE_MAX } from '../../shared/ad-policy';
import { formatPercent, formatRupiah } from '../../shared/format';
import { t } from '../lib/i18n';
import { Button } from '../components/Button';
import { Turnstile } from '../components/Turnstile';
import { Dialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import {
  availability,
  cancelHolds,
  checkout,
  dashboard,
  holdBookings,
  saveAdvertiser,
  saveCreative,
  searchAreas,
  submitCreative,
  toAdWebp,
  uploadCreativeImage,
  type Area,
  type Creative,
  type CreativeInput,
  type Dashboard,
  type Placement,
} from '../lib/ads';
import { api, ApiError, postJson } from '../lib/api';
import { useCatalog } from '../lib/catalog';
import type { BillingSummary } from '../lib/types';

const card = 'rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5';
const input =
  'mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-brand-500';
const label = 'block text-xs text-[var(--fg-muted)]';
const KEY = ['advertiser'] as const;

function adError(e: unknown): string {
  if (e instanceof ApiError) {
    return t.ads.errors[e.message] ?? t.ads.errors[e.code] ?? t.errors.generic;
  }
  return t.errors.generic;
}

export function Advertiser() {
  const q = useQuery({ queryKey: KEY, queryFn: dashboard });
  const [tab, setTab] = useState<'creatives' | 'book' | 'stats'>('creatives');
  const d = q.data;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Megaphone className="h-5 w-5 text-brand-600" />
          {t.ads.title}
        </h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.ads.subtitle}</p>
        <Link
          to="/kebijakan/$slug"
          params={{ slug: 'kebijakan-iklan' }}
          className="mt-1 inline-block text-sm text-brand-700 hover:underline"
        >
          {t.ads.policyLink}
        </Link>
      </header>
      {d && !d.advertiser && <Profile data={d} />}
      {d?.advertiser && (
        <>
          <Profile data={d} />
          <nav className="flex gap-2" aria-label={t.ads.title}>
            {(['creatives', 'book', 'stats'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`rounded-full border px-4 py-1.5 text-sm ${tab === k ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-[var(--border)]'}`}
              >
                {t.ads.tabs[k]}
              </button>
            ))}
          </nav>
          {tab === 'creatives' && <Creatives data={d} />}
          {tab === 'book' && <Book data={d} onDone={() => setTab('stats')} />}
          {tab === 'stats' && <Stats data={d} />}
        </>
      )}
    </div>
  );
}

function Profile({ data }: { data: Dashboard }) {
  const qc = useQueryClient();
  const catalog = useCatalog();
  const a = data.advertiser;
  const [f, setF] = useState({
    businessName: a?.businessName ?? '',
    kind: a?.kind ?? 'umkm',
    phone: a?.phone ?? '',
  });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => saveAdvertiser({ ...f, turnstileToken: captcha }),
    onSuccess: (d) => {
      qc.setQueryData(KEY, d);
      toast(t.common.saved);
    },
    onError: (e) => toast(adError(e), { tone: 'error' }),
  });
  const pct = Number(catalog.data?.config.ad_student_discount_pct ?? 50);
  return (
    <section className={card} aria-labelledby="adv-profile">
      <h2 id="adv-profile" className="font-medium">
        {a ? a.businessName : t.ads.registerTitle}
      </h2>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className={label}>
          {t.ads.businessName}
          <input
            className={input}
            value={f.businessName}
            maxLength={80}
            required
            onChange={(e) => setF({ ...f, businessName: e.target.value })}
          />
        </label>
        <label className={label}>
          {t.ads.kind}
          <select
            className={input}
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}
          >
            {Object.entries(t.ads.kinds).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {t.ads.phone}
          <input
            className={input}
            value={f.phone}
            inputMode="tel"
            required
            onChange={(e) => setF({ ...f, phone: e.target.value })}
          />
        </label>
        <div className="sm:col-span-3">
          {!a && <Turnstile onToken={setCaptcha} />}
          <Button type="submit" disabled={save.isPending}>
            {a ? t.ads.saveProfile : t.ads.register}
          </Button>
        </div>
      </form>
      {a?.kind === 'mahasiswa' && (
        <div className="mt-4 rounded-xl bg-[var(--bg-subtle)] p-3 text-sm">
          <p className="font-medium">{t.ads.studentTitle}</p>
          {a.studentVerified ? (
            <p className="text-[var(--fg-muted)]">{t.ads.studentVerified(a.studentEmail ?? '')}</p>
          ) : (
            <>
              <p className="text-[var(--fg-muted)]">{t.ads.studentBody(pct)}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  className={`${input} mt-0 max-w-xs`}
                  type="email"
                  placeholder={t.ads.studentEmail}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Button
                  variant="ghost"
                  onClick={() =>
                    void postJson('/api/advertiser/student/otp', { email })
                      .then(() => setSent(true))
                      .catch((e: unknown) => toast(adError(e), { tone: 'error' }))
                  }
                >
                  {t.ads.sendCode}
                </Button>
                {sent && (
                  <>
                    <input
                      className={`${input} mt-0 w-32`}
                      inputMode="numeric"
                      placeholder={t.ads.code}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <Button
                      onClick={() =>
                        void postJson('/api/advertiser/student/verify', { code })
                          .then(() => qc.invalidateQueries({ queryKey: KEY }))
                          .catch((e: unknown) => toast(adError(e), { tone: 'error' }))
                      }
                    >
                      {t.ads.verify}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function statusTone(s: string): string {
  if (s === 'approved' || s === 'live') return 'bg-green-100 text-green-800';
  if (s === 'rejected' || s === 'suspended') return 'bg-red-100 text-red-800';
  if (s === 'pending' || s === 'held' || s === 'paid') return 'bg-amber-100 text-amber-800';
  return 'bg-[var(--bg-subtle)] text-[var(--fg-muted)]';
}

function Creatives({ data }: { data: Dashboard }) {
  const [editing, setEditing] = useState<Creative | 'new' | null>(null);
  return (
    <section className={card}>
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{t.ads.tabs.creatives}</h2>
        <Button onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" />
          {t.ads.newCreative}
        </Button>
      </div>
      {!data.creatives.length && (
        <p className="mt-3 text-sm text-[var(--fg-muted)]">{t.ads.noCreatives}</p>
      )}
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {data.creatives.map((c) => (
          <li
            key={c.id}
            className="flex gap-3 rounded-xl border border-[var(--border)] p-3 text-sm"
          >
            {c.hasImage ? (
              <img
                src={`/api/advertiser/creatives/${c.id}/image?v=${c.updatedAt}`}
                alt=""
                className="h-16 w-16 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <div className="h-16 w-16 shrink-0 rounded-lg bg-[var(--bg-subtle)]" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{c.title}</p>
              <p className="line-clamp-2 text-xs text-[var(--fg-muted)]">{c.body}</p>
              <span
                className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] ${statusTone(c.status)}`}
              >
                {t.ads.statuses[c.status]}
              </span>
              {c.rejectReason && <p className="mt-1 text-xs text-red-700">{c.rejectReason}</p>}
              {c.status !== 'suspended' && c.status !== 'pending' && (
                <button
                  type="button"
                  className="mt-1 block text-xs text-brand-700 hover:underline"
                  onClick={() => setEditing(c)}
                >
                  {t.ads.editCreative}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <CreativeForm
          creative={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function CreativeForm({ creative, onClose }: { creative: Creative | null; onClose: () => void }) {
  const qc = useQueryClient();
  const catalog = useCatalog();
  const maxBytes = Number(catalog.data?.config.ad_image_max_bytes ?? 200 * 1024);
  const [f, setF] = useState<CreativeInput>({
    title: creative?.title ?? '',
    body: creative?.body ?? '',
    ctaType: creative?.ctaType ?? 'whatsapp',
    ctaValue: creative?.ctaValue ?? '',
    category: creative?.category ?? 'kuliner',
  });
  const [blob, setBlob] = useState<Blob | null>(null);
  const preview = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const save = useMutation({
    mutationFn: async (andSubmit: boolean) => {
      let c = await saveCreative(f, creative?.id);
      if (blob) c = await uploadCreativeImage(c.id, blob);
      if (andSubmit) c = await submitCreative(c.id);
      return c;
    },
    onSuccess: async (c) => {
      toast(
        c.status === 'pending'
          ? t.ads.submitted
          : c.status === 'rejected'
            ? (c.rejectReason ?? t.ads.statuses.rejected!)
            : t.common.saved,
        {
          tone: c.status === 'rejected' ? 'error' : 'info',
        },
      );
      await qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
    onError: (e) => toast(adError(e), { tone: 'error' }),
  });
  return (
    <Dialog
      open
      title={creative ? t.ads.editCreative : t.ads.newCreative}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={() => save.mutate(false)} disabled={save.isPending}>
            {t.ads.saveDraft}
          </Button>
          <Button
            onClick={() => save.mutate(true)}
            disabled={save.isPending || (!blob && !creative?.hasImage)}
          >
            {t.ads.submit}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <label className={label}>
          {t.ads.headline(AD_TITLE_MAX)}
          <input
            className={input}
            maxLength={AD_TITLE_MAX}
            value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </label>
        <label className={label}>
          {t.ads.body(AD_BODY_MAX)}
          <textarea
            className={`${input} h-20 py-2`}
            maxLength={AD_BODY_MAX}
            value={f.body}
            onChange={(e) => setF({ ...f, body: e.target.value })}
          />
          <span className="block text-right">
            {f.body.length}/{AD_BODY_MAX}
          </span>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className={label}>
            {t.ads.ctaType}
            <select
              className={input}
              value={f.ctaType}
              onChange={(e) => setF({ ...f, ctaType: e.target.value })}
            >
              {AD_CTA_TYPES.map((k) => (
                <option key={k} value={k}>
                  {t.ads.ctaTypes[k]}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t.ads.category}
            <select
              className={input}
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value })}
            >
              {AD_CATEGORIES.map((k) => (
                <option key={k} value={k}>
                  {t.ads.categories[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={label}>
          {t.ads.ctaTypes[f.ctaType]}
          <input
            className={input}
            placeholder={t.ads.ctaValue[f.ctaType]}
            value={f.ctaValue}
            onChange={(e) => setF({ ...f, ctaValue: e.target.value })}
          />
        </label>
        <div>
          <p className={label}>{t.ads.image}</p>
          <label className="mt-1 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[var(--border)] p-3">
            {preview || creative?.hasImage ? (
              <img
                src={
                  preview ??
                  `/api/advertiser/creatives/${creative!.id}/image?v=${creative!.updatedAt}`
                }
                alt=""
                className="h-16 w-16 rounded-lg object-cover"
              />
            ) : (
              <ImagePlus className="h-8 w-8 text-brand-600" />
            )}
            <span className="text-xs text-[var(--fg-muted)]">
              {t.ads.imageHint(Math.round(maxBytes / 1024))}
            </span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const out = await toAdWebp(file, maxBytes).catch(() => null);
                if (!out) return toast(t.ads.imageUnsupported, { tone: 'error' });
                setBlob(out);
              }}
            />
          </label>
        </div>
      </div>
    </Dialog>
  );
}

function AreaPicker({ value, onChange }: { value: Area | null; onChange: (a: Area) => void }) {
  const [q, setQ] = useState('');
  const res = useQuery({
    queryKey: ['ad-areas', q],
    queryFn: () => searchAreas(q),
    enabled: q.length >= 2,
  });
  return (
    <div>
      <label className={label}>
        {t.ads.area}
        <input
          className={input}
          placeholder={
            value ? `${value.name}${value.province ? `, ${value.province}` : ''}` : t.ads.areaSearch
          }
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {q.length >= 2 && (
        <ul className="mt-1 max-h-48 overflow-auto rounded-xl border border-[var(--border)] text-sm">
          <li>
            <button
              type="button"
              className="w-full px-3 py-2 text-left hover:bg-[var(--bg-subtle)]"
              onClick={() => (
                onChange({ code: 'ID', name: 'Indonesia', level: 'national', province: null }),
                setQ('')
              )}
            >
              {t.ads.national}
            </button>
          </li>
          {res.data?.areas.map((a) => (
            <li key={a.code}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-[var(--bg-subtle)]"
                onClick={() => {
                  onChange(a);
                  setQ('');
                }}
              >
                {a.name}
                {a.province && (
                  <span className="text-xs text-[var(--fg-muted)]"> · {a.province}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Book({ data, onDone }: { data: Dashboard; onDone: () => void }) {
  const qc = useQueryClient();
  const approved = data.creatives.filter((c) => c.status === 'approved');
  const [creativeId, setCreativeId] = useState(approved[0]?.id ?? '');
  const [area, setArea] = useState<Area | null>(null);
  const [placement, setPlacement] = useState<Placement>('explorer_sidebar');
  const [dates, setDates] = useState<string[]>([]);
  const [method, setMethod] = useState('saldo');
  const [qr, setQr] = useState<{ ids: string[]; img: string | null; url: string | null } | null>(
    null,
  );
  const billing = useQuery({
    queryKey: ['billing'],
    queryFn: () => api<BillingSummary>('/api/billing'),
  });
  const catalog = useCatalog();
  const avail = useQuery({
    queryKey: ['ad-avail', area?.code, placement],
    queryFn: () => availability(area!.code, placement),
    enabled: Boolean(area),
  });
  const price = avail.data?.priceIdr ?? 0;
  const tax = Number(catalog.data?.config.tax_rate_pct ?? 0);
  const total = price * dates.length;

  // While a QRIS payment is open, poll until those bookings are no longer "held"
  // (status comes from the webhook, never from the client).
  useQuery({
    queryKey: ['ad-payment', qr?.ids],
    queryFn: async () => {
      const d = await dashboard();
      const open = d.bookings.some((b) => qr!.ids.includes(b.id) && b.status === 'held');
      if (!open) {
        toast(t.ads.booked);
        qc.setQueryData(KEY, d);
        setQr(null);
        onDone();
      }
      return open;
    },
    enabled: Boolean(qr),
    refetchInterval: 3000,
  });

  const book = useMutation({
    mutationFn: async () => {
      const h = await holdBookings({ creativeId, areaCode: area!.code, placement, dates });
      try {
        return { ids: h.bookingIds, r: await checkout(h.bookingIds, method) };
      } catch (e) {
        await cancelHolds(h.bookingIds).catch(() => undefined);
        throw e;
      }
    },
    onSuccess: async ({ ids, r }) => {
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ['billing'] });
      setDates([]);
      if (r.paid) {
        toast(t.ads.booked);
        onDone();
      } else {
        const img = r.topup.qrString
          ? await QRCode.toDataURL(r.topup.qrString, { margin: 1, width: 240 })
          : null;
        setQr({ ids, img, url: r.topup.checkoutUrl });
      }
    },
    onError: async (e) => {
      toast(adError(e), { tone: 'error' });
      await qc.invalidateQueries({ queryKey: ['ad-avail'] });
    },
  });

  if (!approved.length)
    return (
      <section className={card}>
        <p className="text-sm text-[var(--fg-muted)]">{t.ads.noApproved}</p>
      </section>
    );
  const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00+07:00`).toLocaleDateString('id-ID', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'Asia/Jakarta',
    });

  return (
    <section className={`${card} space-y-4 text-sm`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          {t.ads.chooseCreative}
          <select
            className={input}
            value={creativeId}
            onChange={(e) => setCreativeId(e.target.value)}
          >
            {approved.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <AreaPicker value={area} onChange={(a) => (setArea(a), setDates([]))} />
      </div>
      <fieldset>
        <legend className={label}>{t.ads.placement}</legend>
        {(['explorer_sidebar', 'share_page'] as const).map((p) => (
          <label key={p} className="flex items-center gap-2 py-1">
            <input
              type="radio"
              name="placement"
              checked={placement === p}
              onChange={() => (setPlacement(p), setDates([]))}
            />
            {t.ads.placements[p]}
          </label>
        ))}
      </fieldset>
      {avail.data && (
        <>
          <p className="font-medium">
            {avail.data.area.name} · {t.ads.perDay(formatRupiah(price))}
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {avail.data.days.map((d) => {
              const on = dates.includes(d.date);
              return (
                <button
                  key={d.date}
                  type="button"
                  disabled={!d.remaining && !on}
                  aria-pressed={on}
                  onClick={() =>
                    setDates(on ? dates.filter((x) => x !== d.date) : [...dates, d.date])
                  }
                  className={`rounded-xl border p-2 text-left text-xs disabled:opacity-40 ${on ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-[var(--border)]'}`}
                >
                  <span className="block font-medium">{fmtDay(d.date)}</span>
                  {t.ads.slotsLeft(d.remaining)}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className={label}>
              {t.ads.payWith}
              <select className={input} value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="saldo">
                  {t.ads.paySaldo(formatRupiah(billing.data?.balanceIdr ?? 0))}
                </option>
                {billing.data?.paymentMethods.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="pb-2 font-medium">
              {t.ads.total(dates.length, formatRupiah(total + Math.round((total * tax) / 100)))}
            </p>
            <Button
              className="mb-0.5"
              disabled={!dates.length || !creativeId || book.isPending}
              onClick={() => book.mutate()}
            >
              {t.ads.book}
            </Button>
          </div>
          <p className="text-xs text-[var(--fg-muted)]">
            {t.ads.holdNote(Number(catalog.data?.config.ad_hold_minutes ?? 15))}
          </p>
        </>
      )}
      <Dialog open={Boolean(qr)} title={t.ads.book} onClose={() => setQr(null)}>
        <div className="space-y-3 text-center text-sm">
          <p>{t.ads.scanQr}</p>
          {qr?.img && <img src={qr.img} alt="QRIS" className="mx-auto h-60 w-60" />}
          {qr?.url && (
            <a
              href={qr.url}
              className="text-brand-700 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {qr.url}
            </a>
          )}
        </div>
      </Dialog>
    </section>
  );
}

function Stats({ data }: { data: Dashboard }) {
  if (!data.bookings.length)
    return (
      <section className={card}>
        <p className="text-sm text-[var(--fg-muted)]">{t.ads.statsEmpty}</p>
      </section>
    );
  return (
    <section className={`${card} overflow-x-auto`}>
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-xs text-[var(--fg-muted)]">
          <tr>
            <th className="py-2">{t.ads.date}</th>
            <th>{t.ads.creative}</th>
            <th>{t.ads.area}</th>
            <th>{t.ads.status}</th>
            <th className="text-right">{t.ads.impressions}</th>
            <th className="text-right">{t.ads.clicks}</th>
            <th className="text-right">{t.ads.ctr}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)]">
          {data.bookings.map((b) => (
            <tr key={b.id}>
              <td className="py-2">{b.date}</td>
              <td className="max-w-[10rem] truncate">{b.title}</td>
              <td>
                {b.areaName}
                <span className="block text-[11px] text-[var(--fg-muted)]">
                  {b.placement === 'share_page' ? 'share' : 'explorer'}
                </span>
              </td>
              <td>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${statusTone(b.status)}`}>
                  {t.ads.statuses[b.status]}
                </span>
              </td>
              <td className="text-right tabular-nums">{b.impressions.toLocaleString('id-ID')}</td>
              <td className="text-right tabular-nums">{b.clicks.toLocaleString('id-ID')}</td>
              <td className="text-right tabular-nums">{formatPercent(b.ctr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-[var(--fg-muted)]">
        <Link to="/paket" className="text-brand-700 hover:underline">
          {t.ads.invoicesHint}
        </Link>
      </p>
    </section>
  );
}
