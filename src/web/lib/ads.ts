// Ads API (SPEC §10, ADR-043). The viewer side never sends user IDs with ad events.
import { api } from './api';

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

export const getRotation = (placement: Placement, exclude: string[]) =>
  api<Rotation>(
    `/api/ads?${new URLSearchParams({ placement, ...(exclude.length ? { exclude: exclude.join(',') } : {}) })}`,
  );

export const dashboard = () => api<Dashboard>('/api/advertiser');
