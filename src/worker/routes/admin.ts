// Admin API (Fase 11 fills this in). Every route requires staff role + second factor.
import { Hono } from 'hono';
import { requireStaff } from '../middleware/auth';
import type { AppBindings } from '../types';

export const admin = new Hono<AppBindings>()
  .use('*', requireStaff(['admin', 'moderator']))
  .get('/whoami', (c) => c.json({ user: c.get('user') }));
