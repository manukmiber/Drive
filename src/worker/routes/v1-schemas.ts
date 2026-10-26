// Request and response shapes of /api/v1 (ADR-062), for validation and the OpenAPI document. The
// response objects are strict: a field the service starts returning has to be written here too, or
// the contract test fails, so the published document never lags behind.
import { z } from 'zod';
import { FOLDER_COLORS } from '../../shared/folder-decor';
import { CORS_METHODS } from '../services/s3-cors';
import { TOKEN_SCOPES } from '../services/tokens';

export const ulidId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const ms = z.number().int().describe('Unix time in milliseconds');
const color = z.enum(Object.keys(FOLDER_COLORS) as [keyof typeof FOLDER_COLORS]);

export const Node = z.strictObject({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: z.enum(['file', 'folder']),
  name: z.string(),
  size: z.number().int(),
  mime: z.string().nullable(),
  status: z.enum(['uploading', 'scanning', 'ready', 'rejected']),
  scanStatus: z.string().nullable(),
  space: z.enum(['personal', 'family']),
  ownerId: z.string(),
  createdBy: z.string(),
  familyCanEdit: z.boolean(),
  starred: z.boolean(),
  hasThumb: z.boolean(),
  trashedAt: ms.nullable(),
  purgeAt: ms.nullable(),
  createdAt: ms,
  updatedAt: ms,
  clientModifiedAt: ms.nullable(),
  decor: z
    .strictObject({
      color: color.nullable(),
      icon: z.string().nullable(),
      coverId: z.string().nullable(),
    })
    .nullable(),
});

export const Crumb = z.strictObject({
  id: z.string(),
  name: z.string(),
  color: color.nullable(),
  icon: z.string().nullable(),
});

export const Share = z.strictObject({
  id: z.string(),
  url: z.string(),
  kind: z.enum(['file', 'bundle', 'folder']),
  title: z.string(),
  expiresAt: ms.nullable(),
  maxDownloads: z.number().int().nullable(),
  downloadCount: z.number().int(),
  hasPassword: z.boolean(),
  revokedAt: ms.nullable(),
  disabledReason: z.string().nullable(),
  lastDownloadAt: ms.nullable(),
  createdAt: ms,
  nodeIds: z.array(z.string()),
  showListing: z.boolean(),
});

export const UploadInit = z.strictObject({
  uploadId: z.string(),
  nodeId: z.string(),
  partSize: z.number().int(),
  totalParts: z.number().int(),
});

export const UploadStatus = z.strictObject({
  uploadId: z.string(),
  nodeId: z.string(),
  status: z.string(),
  size: z.number().int(),
  partSize: z.number().int(),
  totalParts: z.number().int(),
  uploadedParts: z.array(z.number().int()),
});

export const Account = z.strictObject({
  user: z.strictObject({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    locale: z.enum(['id', 'en']),
  }),
  space: z.strictObject({
    personalRootId: z.string(),
    familyRootId: z.string().nullable(),
  }),
  storage: z.strictObject({
    limitBytes: z.number().int(),
    usedBytes: z.number().int(),
    reservedBytes: z.number().int(),
  }),
  plan: z
    .strictObject({
      code: z.string(),
      name: z.string(),
      status: z.string(),
      periodEnd: ms,
      maxFileBytes: z.number().int(),
    })
    .nullable(),
});

export const Me = z.strictObject({
  user: z.strictObject({ id: z.string(), email: z.string(), name: z.string() }),
  token: z.strictObject({
    id: z.string(),
    name: z.string(),
    scopes: z.array(z.enum(TOKEN_SCOPES)),
    expiresAt: ms.nullable(),
  }),
});

export const CorsRule = z.object({
  id: z.string().max(255).optional(),
  allowedOrigins: z.array(z.string().max(1024)).min(1).max(100),
  allowedMethods: z.array(z.enum(CORS_METHODS)).min(1),
  allowedHeaders: z.array(z.string().max(1024)).max(100).default([]),
  exposeHeaders: z.array(z.string().max(1024)).max(100).default([]),
  maxAgeSeconds: z.number().int().min(0).max(31_536_000).optional(),
});

export const S3Bucket = z.strictObject({
  name: z.string(),
  public: z.boolean(),
  blocked: z.boolean(),
  createdAt: ms,
});

export const S3Key = z.strictObject({
  id: z.string(),
  label: z.string(),
  createdAt: ms,
  lastUsedAt: ms.nullable(),
});

export const S3Overview = z.strictObject({
  endpoint: z.string().nullable(),
  region: z.string(),
  account: z.strictObject({
    status: z.string(),
    billingState: z.string(),
    limitBytes: z.number().int(),
    usedBytes: z.number().int(),
  }),
  keys: z.array(S3Key),
  buckets: z.array(S3Bucket),
});
