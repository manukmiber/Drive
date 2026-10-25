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
  /** Only what works here (ADR-049); the app hides the rest. */
  capabilities?: {
    asyncArchives: boolean;
    emailShare: boolean;
    s3: boolean;
    s3ThreeCopies: boolean;
    s3UrlZeiko: boolean;
    s3UrlCustom: boolean;
  };
  config: {
    upload_part_concurrency: number;
    upload_max_parallel_files: number;
    share_default_expiry_days: number;
    standalone_compress_max_bytes: number;
    editor_image_max_bytes: number;
    editor_video_max_bytes: number;
    editor_pdf_max_bytes: number;
    editor_text_max_bytes: number;
    editor_doc_max_bytes: number;
    editor_sheet_max_bytes: number;
    editor_zip_max_bytes: number;
    editor_zip_extract_max_bytes: number;
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
    /** From the Zeiko Account (ADR-041). */
    adCity: string | null;
    adPostalCode: string | null;
    adAreaName: string | null;
    /** The Zeiko Account this user signs in as (null for one made before Zeiko Accounts). */
    zeikoId: string | null;
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
  /** The Zeiko Accounts door (its /v1 calls), or null when not set up. */
  doorUrl: string | null;
  /** The website: sign-in, sign-up and payment pages. */
  siteUrl: string | null;
  chatUrl: string;
  turnstileSiteKey: string | null;
  dev: boolean;
}

export interface BillingSummary {
  /** Rupiah left over from earlier payments, taken off the next one (ADR-041). */
  creditIdr: number;
  /** What "Renew" asks now; null without a plan of one's own. */
  renewIdr: number | null;
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
  canPay: boolean;
}

/** What can be bought (ADR-041); `renew` is the next month of one's plan. */
export type CheckoutItem =
  | { kind: 'plan' | 'addon' | 'compress'; code: string }
  | { kind: 'renew' }
  | { kind: 's3_plan'; gb: number; replicas: 1 | 3 }
  | { kind: 's3_renew' }
  | {
      kind: 's3_url';
      url: { type: 'zeiko'; name: string } | { type: 'custom'; hostname: string };
    };

export interface Topup {
  paymentId: string;
  amountIdr: number;
  feeIdr: number;
  checkoutUrl: string | null;
  qrString: string | null;
  expiresAt: number;
}

export type CheckoutResult =
  | { status: 'done'; done: { kind: string } }
  | { status: 'payment'; payment: Topup; creditUsedIdr: number };
