// Public helper pages: email unsubscribe (SPEC §6.5).
import { Hono } from 'hono';
import { sha256Hex } from '../lib/crypto';
import { page } from '../lib/pages';
import { verifyUnsubscribeToken } from '../services/share-send';
import { escapeHtml } from '../services/email-templates';
import type { AppBindings } from '../types';

export const integrations = new Hono<AppBindings>().on(
  ['GET', 'POST'],
  '/berhenti/:token',
  async (c) => {
    const email = await verifyUnsubscribeToken(c.get('ctx'), c.req.param('token'));
    if (!email) return page('Link tidak valid', '<h1>Link tidak valid</h1>', { status: 400 });
    if (c.req.method === 'POST' || c.req.query('ok') === '1') {
      // Kept by the relay (ADR-064). If it is not answering right now, the notify queue keeps
      // trying: the person is told it is done either way.
      const emailHash = await sha256Hex(`email|${email}`);
      try {
        await c.get('ctx').adapters.notices.suppress(emailHash, 'unsubscribe');
      } catch {
        await c.env.NOTIFY_QUEUE.send({ type: 'suppress', emailHash });
      }
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
  },
);
