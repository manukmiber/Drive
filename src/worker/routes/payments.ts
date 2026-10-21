// Gateway webhooks (signature-verified, idempotent) and the mock checkout page used in dev/staging
// until a real gateway is chosen (SPEC §12.3, §16 #2). The mock page never exists in production.
import { Hono } from 'hono';
import { PAYMENT_STATUSES, type PaymentStatus } from '../../shared/enums';
import { formatRupiah } from '../../shared/format';
import { page } from '../lib/pages';
import { applyPaymentEvent } from '../services/billing';
import { escapeHtml } from '../services/email-templates';
import type { AppBindings } from '../types';

export const payments = new Hono<AppBindings>()
  .post('/api/payments/webhook/:provider', async (c) => {
    const ctx = c.get('ctx');
    const provider = ctx.adapters.payment;
    if (c.req.param('provider') !== provider.name) return c.json({ ok: false }, 404);
    const ev = await provider.verifyWebhook(c.req.raw);
    if (!ev) return c.json({ ok: false, error: 'bad signature' }, 401);
    const result = await applyPaymentEvent(ctx, provider.name, ev);
    return c.json({ ok: true, result });
  })
  .on(['GET', 'POST'], '/dev/pay/:ref', async (c) => {
    const ctx = c.get('ctx');
    if (ctx.env.APP_ENV === 'production' || ctx.adapters.payment.name !== 'mock')
      return c.text('Not found', 404);
    const ref = c.req.param('ref');
    const p = await c.env.DB.prepare(
      `SELECT amount_idr, status, method FROM payments WHERE provider = 'mock' AND provider_ref = ?1`,
    )
      .bind(ref)
      .first<{ amount_idr: number; status: string; method: string }>();
    if (!p) return page('Tidak ditemukan', '<h1>Pembayaran tidak ditemukan</h1>', { status: 404 });
    if (c.req.method === 'POST') {
      const form = await c.req.parseBody();
      const status = String(form.status) as PaymentStatus;
      if (!PAYMENT_STATUSES.includes(status)) return c.text('bad status', 400);
      await applyPaymentEvent(ctx, 'mock', {
        providerRef: ref,
        status,
        amountIdr: p.amount_idr,
        raw: { simulated: true, status },
      });
      return c.redirect('/paket?paid=1', 303);
    }
    const btn = (status: string, label: string, bg: string) =>
      `<form method="post"><input type="hidden" name="status" value="${status}"><button style="background:${bg}">${label}</button></form>`;
    return page(
      'Simulasi pembayaran',
      `<h1>Simulasi pembayaran</h1><p>Gateway pembayaran belum dipilih, jadi ini halaman uji. Tidak ada uang sungguhan.</p>
<p style="font-size:24px;font-weight:700;margin:8px 0">${escapeHtml(formatRupiah(p.amount_idr))}</p>
<p>Metode: ${escapeHtml(p.method.toUpperCase())} · Status: ${escapeHtml(p.status)}</p>
${p.status === 'pending' ? btn('paid', 'Bayar (berhasil)', '#16a34a') + btn('failed', 'Gagal', '#dc2626') + btn('expired', 'Kedaluwarsa', '#6b7280') : '<a class="btn" href="/paket">Kembali</a>'}`,
    );
  });
