import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Gauge, Lock, Share2 } from 'lucide-react';
import { formatBytes, formatRupiah } from '../../shared/format';
import { t } from '../../shared/strings.id';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import type { Catalog } from '../lib/types';

const FEATURES = [
  {
    icon: Gauge,
    title: 'Tanpa batas kecepatan',
    body: 'Upload dan download secepat koneksimu. Tanpa antre, tanpa captcha.',
  },
  {
    icon: Share2,
    title: 'Sekali klik langsung unduh',
    body: 'Bagikan lewat WhatsApp, Telegram, email, atau QR.',
  },
  {
    icon: Lock,
    title: 'Privat',
    body: 'Tanpa tracker pihak ketiga. File kamu tidak dikirim ke layanan luar.',
  },
];

export function Landing() {
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/api/public/catalog'),
  });

  return (
    <div className="min-h-full bg-[var(--bg)]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Logo />
        <Link
          to="/masuk"
          className="rounded-full bg-brand-700 px-5 py-2 text-sm font-medium text-white hover:bg-brand-800"
        >
          Masuk
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-16">
        <section className="py-12 text-center sm:py-20">
          <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">{t.app.tagline}</h1>
          <p className="mx-auto mt-4 max-w-xl text-[var(--fg-muted)]">
            Penyimpanan awan untuk Indonesia mulai dari Rp1.000 per bulan. Bayar pakai QRIS atau
            Saldo Zeiko.
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5"
            >
              <f.icon className="h-6 w-6 text-brand-600" aria-hidden="true" />
              <h2 className="mt-3 font-semibold">{f.title}</h2>
              <p className="mt-1 text-sm text-[var(--fg-muted)]">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-14" aria-labelledby="harga">
          <h2 id="harga" className="text-center text-2xl font-bold">
            Pilih paket
          </h2>
          {catalog.isPending && (
            <p className="mt-6 text-center text-[var(--fg-muted)]">{t.common.loading}</p>
          )}
          {catalog.isError && <p className="mt-6 text-center text-red-600">{t.errors.generic}</p>}
          {catalog.data && (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {catalog.data.plans.map((p) => (
                <div
                  key={p.code}
                  className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5"
                >
                  <h3 className="font-semibold">{p.name}</h3>
                  <p className="mt-2 text-2xl font-bold">
                    {formatRupiah(p.priceIdr)}
                    <span className="text-sm font-normal text-[var(--fg-muted)]">/bulan</span>
                  </p>
                  <ul className="mt-4 space-y-2 text-sm">
                    <li className="flex gap-2">
                      <Check className="h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
                      {formatBytes(p.storageBytes)} penyimpanan
                    </li>
                    <li className="flex gap-2">
                      <Check className="h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
                      {p.compressQuota.toLocaleString('id-ID')} kompres/bulan
                    </li>
                    <li className="flex gap-2 text-[var(--fg-muted)]">
                      {formatRupiah(Math.round(p.priceIdr / (p.storageBytes / 2 ** 30)))}/GB
                    </li>
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-[var(--border)] py-6 text-center text-xs text-[var(--fg-muted)]">
        © {new Date().getFullYear()} {t.app.fullName}
      </footer>
    </div>
  );
}
