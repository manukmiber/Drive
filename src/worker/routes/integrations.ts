// Inbound webhooks + public helper pages: Telegram bot updates, email unsubscribe (SPEC §6.4, §6.5).
import { Hono } from 'hono';
import { sha256Hex, timingSafeEqual } from '../lib/crypto';
import { page } from '../lib/pages';
import { handleTelegramUpdate, verifyUnsubscribeToken } from '../services/share-send';
import { escapeHtml } from '../services/email-templates';
import type { AppBindings } from '../types';

export const integrations = new Hono<AppBindings>()
  .post('/api/integrations/telegram', async (c) => {
    const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
    const got = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!secret || !timingSafeEqual(got, secret)) return c.text('forbidden', 403);
    await handleTelegramUpdate(c.get('ctx'), await c.req.json());
    return c.json({ ok: true });
  })
  .on(['GET', 'POST'], '/berhenti/:token', async (c) => {
    const email = await verifyUnsubscribeToken(c.get('ctx'), c.req.param('token'));
    if (!email) return page('Link tidak valid', '<h1>Link tidak valid</h1>', { status: 400 });
    if (c.req.method === 'POST' || c.req.query('ok') === '1') {
      await c.env.DB.prepare(
        `INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?1, 'unsubscribe', ?2) ON CONFLICT DO NOTHING`,
      )
        .bind(await sha256Hex(`email|${email}`), c.get('ctx').now())
        .run();
      if (c.req.method === 'POST' && !c.req.header('content-type')?.includes('form'))
        return c.body(null, 204); // one-click
      return page(
        'Berhenti berlangganan',
        `<h1>Beres.</h1><p>${escapeHtml(email)} tidak akan menerima email berbagi file dari Zeiko lagi.</p>`,
      );
    }
    return page(
      'Berhenti berlangganan',
      `<h1>Berhenti menerima email?</h1><p>${escapeHtml(email)} tidak akan menerima email berbagi file dari pengguna Zeiko.</p>
<form method="post"><button type="submit">Ya, berhenti</button></form>`,
    );
  });
