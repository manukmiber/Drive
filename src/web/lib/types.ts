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

export interface Me {
  user: {
    id: string;
    email: string;
    name: string;
    role: 'user' | 'moderator' | 'admin';
    twoFactorEnabled: boolean;
    image: string | null;
    adCityCode: string | null;
  };
  hasPasskey: boolean;
  deleteRequestedAt: number | string | null;
  space: {
    poolId: string;
    personalRootId: string;
    familyId: string | null;
    familyRootId: string | null;
  };
  storage: { limitBytes: number; usedBytes: number; reservedBytes: number };
  subscription: { planCode: string; planName: string; status: string; periodEnd: number } | null;
  csrfToken: string;
}

export interface PublicAuth {
  google: boolean;
  turnstileSiteKey: string | null;
  devMailbox: boolean;
}

export interface BillingSummary {
  balanceIdr: number;
  managedByFamily: boolean;
  storage: { limitBytes: number; usedBytes: number; reservedBytes: number };
  subscription: {
    id: string;
    planCode: string;
    nextPlanCode: string | null;
    status: 'active' | 'grace' | 'readonly' | 'suspended';
    periodStart: number;
    periodEnd: number;
    cancelAtPeriodEnd: boolean;
    readonlyAt: number;
    suspendAt: number;
    deleteAt: number;
  } | null;
  addons: Array<{
    id: string;
    code: string;
    name: string;
    priceIdr: number;
    storageBytes: number;
    qty: number;
    cancelAtPeriodEnd: number;
  }>;
  pendingPayments: Array<{
    id: string;
    amountIdr: number;
    method: string;
    status: string;
    createdAt: number;
  }>;
  compressCredits: number;
  paymentMethods: Array<{ code: string; label: string; minIdr: number }>;
  minTopupIdr: number;
}

export interface Topup {
  paymentId: string;
  amountIdr: number;
  feeIdr: number;
  checkoutUrl: string | null;
  qrString: string | null;
  expiresAt: number;
}

export interface Invoice {
  id: string;
  number: string;
  lines: Array<{ label: string; amountIdr: number }>;
  subtotalIdr: number;
  taxIdr: number;
  taxRatePct: number;
  totalIdr: number;
  status: string;
  issuedAt: number;
  customer: { name: string; email: string };
}
