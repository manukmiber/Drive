// One list of /api/v1 endpoints (ADR-062): each route is registered on Hono from its entry, and the
// OpenAPI 3.1 document is generated from the same entries (zod 4's toJSONSchema), so the two cannot
// drift apart. A route added to the router by hand fails the coverage test.
import { z, type ZodObject, type ZodType } from 'zod';
import type { TokenScope } from '../services/tokens';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface Endpoint {
  method: Method;
  /** OpenAPI style: /nodes/{id}. */
  path: string;
  /** Scope the token needs; null = any working token. */
  scope: TokenScope | null;
  tag: string;
  summary: string;
  params?: ZodObject;
  query?: ZodObject;
  /** JSON body; `binary` instead for raw bytes (an upload part). */
  body?: ZodType;
  binary?: boolean;
  /** Response bodies by status; null = no body (204). */
  responses: Record<number, ZodType | null>;
  /** Takes an Idempotency-Key header (POSTs that make something). */
  idempotent?: boolean;
  /** Served without a token (the OpenAPI document, OAuth's token endpoint). */
  public?: boolean;
  /** The body may be application/x-www-form-urlencoded as well as JSON (OAuth, RFC 6749). */
  form?: boolean;
}

/** /nodes/{id} → /nodes/:id */
export const honoPath = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

const ERROR = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
});

const json = (schema: ZodType, io: 'input' | 'output') => {
  const s = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
};

function parameters(ep: Endpoint) {
  const out: unknown[] = [];
  for (const [where, obj] of [
    ['path', ep.params],
    ['query', ep.query],
  ] as const) {
    if (!obj) continue;
    const schema = json(obj, 'input') as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    for (const [name, s] of Object.entries(schema.properties ?? {}))
      out.push({
        name,
        in: where,
        required: where === 'path' || (schema.required ?? []).includes(name),
        schema: s,
      });
  }
  if (ep.idempotent)
    out.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description:
        'Repeat the same request with the same key (within 24 hours) to get the first answer back instead of making a second one.',
      schema: { type: 'string', maxLength: 255 },
    });
  return out;
}

export function openApiDocument(endpoints: readonly Endpoint[], serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ep of endpoints) {
    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(ep.responses))
      responses[status] = schema
        ? {
            description: Number(status) < 300 ? 'OK' : 'Error',
            content: { 'application/json': { schema: json(schema, 'output') } },
          }
        : { description: 'No content' };
    if (!ep.public) {
      responses['401'] = {
        description: 'Missing, wrong, expired or revoked token',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
      if (ep.scope)
        responses['403'] = {
          description: `The token lacks the ${ep.scope} scope, or no access to the item`,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        };
      responses['429'] = { description: 'Too many requests for this token (see Retry-After)' };
    }
    (paths[ep.path] ??= {})[ep.method] = {
      operationId: `${ep.method}${ep.path.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ?? '').toUpperCase())}`,
      tags: [ep.tag],
      summary: ep.summary,
      ...(ep.public ? { security: [] } : {}),
      ...(ep.scope ? { 'x-scope': ep.scope } : {}),
      parameters: parameters(ep),
      ...(ep.body
        ? {
            requestBody: {
              required: true,
              content: {
                ...(ep.form
                  ? { 'application/x-www-form-urlencoded': { schema: json(ep.body, 'input') } }
                  : {}),
                'application/json': { schema: json(ep.body, 'input') },
              },
            },
          }
        : ep.binary
          ? {
              requestBody: {
                required: true,
                content: {
                  'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
                },
              },
            }
          : {}),
      responses,
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Zeiko Drive API',
      version: '1',
      description:
        'Zeiko Drive and Zeiko S3 management for scripts and apps. Sign in with an access token from Settings → Tokens & apps: `Authorization: Bearer zkd_…`. Each operation names the scope it needs (`x-scope`). Errors are `{ "error": { "code", "message", "data" } }`. New fields may appear in responses; anything that would break a client goes to /api/v2.',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'zkd_…' } },
      schemas: { Error: json(ERROR, 'output') },
    },
    paths,
  };
}
