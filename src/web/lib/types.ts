// Response shapes used by the web app (kept close to the Worker routes).
export interface Plan {
  code: string;
  name: string;
  kind: 'personal' | 'family';
  priceIdr: number;
  storageBytes: number;
  compressQuota: number;
  maxMembers: number;
  showAds: boolean;
}

export interface Addon {
  code: string;
  name: string;
  priceIdr: number;
  storageBytes: number;
}

export interface CompressPack {
  code: string;
  name: string;
  priceIdr: number;
  credits: number;
  ttlDays: number;
}

export interface Catalog {
  plans: Plan[];
  addons: Addon[];
  compressPacks: CompressPack[];
  config: {
    upload_part_concurrency: number;
    upload_max_parallel_files: number;
    share_default_expiry_days: number;
    features: Record<string, boolean>;
  } & Record<string, unknown>;
}
