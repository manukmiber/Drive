// Ads API (SPEC §10, ADR-043). The viewer side never sends user IDs with ad events.
import { api, postJson, sendJson } from './api';

export type Placement = 'explorer_sidebar' | 'share_page';

export interface Ad {
  campaignId: string | null;
  creativeId: string | null;
  title: string;
  body: string;
  imageUrl: string | null;
  ctaLabel: string;
  clickUrl: string;
  label: string;
  token: string | null;
  area: string | null;
  internal: boolean;
}

export interface Rotation {
  ads: Ad[];
  rotateSeconds: number;
}

export interface AreaRef {
  code: string;
  name: string;
}

export interface Stat {
  impressions: number;
  clicks: number;
  ctr: number;
}

export interface MyCampaign extends Stat {
  id: string;
  creativeId: string;
  title: string;
  scope: 'cities' | 'national';
  areas: AreaRef[];
  startDate: string;
  endDate: string;
  days: number;
  pricePerDayIdr: number;
  totalIdr: number;
  payIdr: number;
  status: string;
  reason: string | null;
  byDay: Array<Stat & { date: string }>;
  byArea: Array<Stat & AreaRef>;
}

export interface Dashboard {
  advertiser: null | { businessName: string; kind: 'umkm' | 'mahasiswa' | 'lainnya' };
  campaigns: MyCampaign[];
}

export interface Creative {
  id: string;
  title: string;
  body: string;
  hasImage: boolean;
  ctaType: string;
  ctaValue: string;
  category: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'suspended';
  rejectReason: string | null;
  updatedAt: number;
}

export interface Area {
  code: string;
  name: string;
  level: string;
  province: string | null;
}

export const getRotation = (placement: Placement, exclude: string[]) =>
  api<Rotation>(
    `/api/ads?${new URLSearchParams({ placement, ...(exclude.length ? { exclude: exclude.join(',') } : {}) })}`,
  );

export const searchAreas = (q: string) =>
  api<{ areas: Area[] }>(`/api/ads/areas?${new URLSearchParams({ q })}`);

export const dashboard = () => api<Dashboard>('/api/advertiser');

// ── The operator's side (/api/admin/ads, ADR-043) ──

export interface OperatorAdvertiser {
  user: { id: string; email: string; name: string | null };
  advertiser: null | { businessName: string; kind: string; phone: string };
  creatives: Creative[];
}

export type CreativeInput = Pick<Creative, 'title' | 'body' | 'ctaType' | 'ctaValue' | 'category'>;

export const findAdvertiser = (email: string) =>
  api<OperatorAdvertiser>(`/api/admin/ads/advertiser?${new URLSearchParams({ email })}`);

export const saveAdvertiser = (b: {
  email: string;
  businessName: string;
  kind: string;
  phone: string;
}) => sendJson<OperatorAdvertiser>('PUT', '/api/admin/ads/advertiser', b);

export const saveCreative = (advertiserId: string, input: CreativeInput, id?: string) =>
  id
    ? sendJson<Creative>('PATCH', `/api/admin/ads/creatives/${id}`, { ...input, advertiserId })
    : postJson<Creative>('/api/admin/ads/creatives', { ...input, advertiserId });

export const uploadCreativeImage = (advertiserId: string, id: string, blob: Blob) =>
  api<Creative>(
    `/api/admin/ads/creatives/${id}/image?${new URLSearchParams({ advertiser: advertiserId })}`,
    { method: 'PUT', body: blob, headers: { 'content-type': 'image/webp' } },
  );

export const createCampaign = (b: {
  creativeId: string;
  scope: 'cities' | 'national';
  areaCodes: string[];
  startDate: string;
  days: number;
}) => postJson<{ id: string; status: string }>('/api/admin/ads/campaigns', b);

/**
 * Square-crops and encodes to WebP in the browser, lowering quality/size until it fits `maxBytes`
 * (SPEC §10.5). The server re-validates. Returns null when the browser can't encode WebP.
 */
export async function toAdWebp(file: File, maxBytes: number): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  for (const target of [1080, 800, 600, 400]) {
    const size = Math.min(target, side);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d')!.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    for (const q of [0.85, 0.75, 0.65, 0.5, 0.4]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') return null;
      if (blob.size <= maxBytes) return blob;
    }
  }
  return null;
}
