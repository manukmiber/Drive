import type { DevRuntime } from '../../dev/env';
import { addBillingMonth } from '../../src/shared/time';
import type { Session } from './session';

/** Gives a user's personal pool an active plan; `limitBytes` overrides the plan quota. */
export async function grantPlan(
  rt: DevRuntime,
  userId: string,
  planCode = 'plus',
  limitBytes?: number,
): Promise<string> {
  const db = rt.d1.sqlite;
  const pool = db
    .prepare("SELECT id FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?")
    .get(userId) as { id: string };
  const plan = db.prepare('SELECT storage_bytes FROM plans WHERE code = ?').get(planCode) as {
    storage_bytes: number;
  };
  const now = Date.now();
  db.prepare(
    `INSERT INTO subscriptions (id, pool_id, payer_user_id, plan_code, status, period_start, period_end, anchor_day,
       status_changed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, 1, ?, ?, ?)`,
  ).run(`sub_${userId}`, pool.id, userId, planCode, now, addBillingMonth(now, 1), now, now, now);
  db.prepare('UPDATE storage_pools SET limit_bytes = ? WHERE id = ?').run(
    limitBytes ?? plan.storage_bytes,
    pool.id,
  );
  return pool.id;
}

export function pool(rt: DevRuntime, poolId: string) {
  return rt.d1.sqlite
    .prepare('SELECT limit_bytes, used_bytes, reserved_bytes FROM storage_pools WHERE id = ?')
    .get(poolId) as {
    limit_bytes: number;
    used_bytes: number;
    reserved_bytes: number;
  };
}

export async function rootOf(s: Session): Promise<string> {
  const me = (await (await s.req('GET', '/api/me')).json()) as {
    space: { personalRootId: string };
  };
  return me.space.personalRootId;
}

export interface NodeJson {
  id: string;
  name: string;
  status: string;
  size: number;
  kind: string;
  parentId: string;
}

export async function simpleUpload(
  s: Session,
  parentId: string,
  name: string,
  data: Uint8Array | string,
  extra: Record<string, string> = {},
): Promise<Response> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const q = new URLSearchParams({ parentId, name, size: String(bytes.length), ...extra });
  return s.req('PUT', `/api/uploads/simple?${q}`, undefined, {
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
  });
}

export async function uploadText(
  s: Session,
  parentId: string,
  name: string,
  text: string,
): Promise<NodeJson> {
  const res = await simpleUpload(s, parentId, name, text);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${await res.text()}`);
  return ((await res.json()) as { node: NodeJson }).node;
}

export async function putPart(
  s: Session,
  uploadId: string,
  n: number,
  bytes: Uint8Array,
): Promise<Response> {
  return s.req('PUT', `/api/uploads/${uploadId}/parts/${n}`, undefined, {
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
  });
}

export async function createFolder(s: Session, parentId: string, name: string): Promise<NodeJson> {
  const res = await s.req('POST', '/api/folders', { parentId, name });
  if (res.status !== 201) throw new Error(`folder failed ${res.status} ${await res.text()}`);
  return ((await res.json()) as { node: NodeJson }).node;
}

export async function downloadPath(s: Session, nodeId: string): Promise<string> {
  const res = await s.req('GET', `/api/files/${nodeId}/download`);
  if (res.status !== 200) throw new Error(`download url failed ${res.status} ${await res.text()}`);
  return ((await res.json()) as { url: string }).url;
}
