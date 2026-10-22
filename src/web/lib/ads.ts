// Ads API (SPEC §10). The viewer side never sends user IDs with ad events.
import { api, postJson, sendJson } from './api';

export type Placement = 'explorer_sidebar' | 'share_page';

export interface Ad {
  bookingId: string | null;
  creativeId: string | null;
  title: string;
  body: string;
  imageUrl: string | null;
  ctaLabel: string;
  clickUrl: string;
  label: string;
  token: string | null;
  internal: boolean;
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

export interface Booking {
  id: string;
  creativeId: string;
  title: string;
  areaCode: string;
  areaName: string;
  placement: Placement;
  date: string;
  priceIdr: number;
  status: string;
  holdExpiresAt: number | null;
  impressions: number;
  clicks: number;
  ctr: number;
}

export interface Dashboard {
  advertiser: null | {
    businessName: string;
    kind: 'umkm' | 'mahasiswa' | 'lainnya';
    phone: string;
    studentVerified: boolean;
    studentEmail: string | null;
  };
  creatives: Creative[];
  bookings: Booking[];
}

export interface Area {
  code: string;
  name: string;
  level: string;
  province: string | null;
}

export interface Availability {
  area: { code: string; name: string; level: string };
  placement: Placement;
  priceIdr: number;
  days: Array<{ date: string; remaining: number; total: number }>;
}

export const getAd = (placement: Placement, exclude: string[]) =>
  api<{ ad: Ad | null }>(
    `/api/ads?${new URLSearchParams({ placement, ...(exclude.length ? { exclude: exclude.join(',') } : {}) })}`,
  );

export const searchAreas = (q: string) =>
  api<{ areas: Area[] }>(`/api/ads/areas?${new URLSearchParams({ q })}`);

export const dashboard = () => api<Dashboard>('/api/advertiser');
export const saveAdvertiser = (b: {
  businessName: string;
  kind: string;
  phone: string;
  turnstileToken?: string | null;
}) => sendJson<Dashboard>('PUT', '/api/advertiser', b);

export type CreativeInput = Pick<Creative, 'title' | 'body' | 'ctaType' | 'ctaValue' | 'category'>;
export const saveCreative = (input: CreativeInput, id?: string) =>
  id
    ? sendJson<Creative>('PATCH', `/api/advertiser/creatives/${id}`, input)
    : postJson<Creative>('/api/advertiser/creatives', input);

export const uploadCreativeImage = (id: string, blob: Blob) =>
  api<Creative>(`/api/advertiser/creatives/${id}/image`, {
    method: 'PUT',
    body: blob,
    headers: { 'content-type': 'image/webp' },
  });

export const submitCreative = (id: string) =>
  postJson<Creative>(`/api/advertiser/creatives/${id}/submit`, {});

export const availability = (area: string, placement: Placement) =>
  api<Availability>(`/api/advertiser/availability?${new URLSearchParams({ area, placement })}`);

export const holdBookings = (b: {
  creativeId: string;
  areaCode: string;
  placement: Placement;
  dates: string[];
}) =>
  postJson<{ bookingIds: string[]; totalIdr: number; holdExpiresAt: number }>(
    '/api/advertiser/bookings',
    b,
  );

export const checkout = (bookingIds: string[], method: string) =>
  postJson<
    | { paid: true; invoiceId: string }
    | {
        paid: false;
        topup: {
          paymentId: string;
          amountIdr: number;
          qrString: string | null;
          checkoutUrl: string | null;
        };
      }
  >('/api/advertiser/bookings/checkout', { bookingIds, method });

export const cancelHolds = (bookingIds: string[]) =>
  postJson<void>('/api/advertiser/bookings/cancel', { bookingIds });

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
