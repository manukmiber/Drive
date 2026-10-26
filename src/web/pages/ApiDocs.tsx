// /developer: a light reference of the public API (ADR-062), drawn from /api/v1/openapi.json by
// the app itself (no documentation scripts from a CDN: the CSP would not allow them anyway).
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BookOpen, Download } from 'lucide-react';
import { API_RATE_PER_MINUTE } from '../../shared/constants';
import { t } from '../lib/i18n';

interface Param {
  name: string;
  in: string;
  required: boolean;
  schema?: { type?: unknown };
}
interface Operation {
  tags: string[];
  summary: string;
  'x-scope'?: string;
  parameters: Param[];
  requestBody?: {
    content: Record<
      string,
      { schema?: { properties?: Record<string, unknown>; required?: string[] } }
    >;
  };
}
interface Doc {
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation>>;
}

const METHOD_STYLE: Record<string, string> = {
  get: 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200',
  post: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  put: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  patch: 'bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200',
  delete: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
};

function typeOf(s: unknown): string {
  const v = (s as { type?: unknown } | undefined)?.type;
  return Array.isArray(v) ? v.join(' | ') : typeof v === 'string' ? v : 'value';
}

function OperationRow({ method, path, op }: { method: string; path: string; op: Operation }) {
  const body = Object.values(op.requestBody?.content ?? {})[0]?.schema;
  const binary = Boolean(op.requestBody?.content['application/octet-stream']);
  const params = op.parameters.filter((p) => p.in !== 'header');
  const idem = op.parameters.some((p) => p.name === 'Idempotency-Key');
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase ${METHOD_STYLE[method] ?? ''}`}
        >
          {method}
        </span>
        <code className="min-w-0 break-all text-sm">{path}</code>
        {idem && (
          <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
            Idempotency-Key
          </span>
        )}
      </div>
      <p className="mt-1 text-sm">{op.summary}</p>
      <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
        {t.apiDocs.scope}: <code>{op['x-scope'] ?? t.apiDocs.anyToken}</code>
      </p>
      {(params.length > 0 || body || binary) && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {params.map((p) => (
            <div key={`${p.in}-${p.name}`} className="contents">
              <dt className="font-mono">{p.name}</dt>
              <dd className="text-[var(--fg-muted)]">
                {p.in} · {typeOf(p.schema)}
                {p.required ? ` · ${t.apiDocs.required}` : ''}
              </dd>
            </div>
          ))}
          {binary && (
            <div className="contents">
              <dt className="font-mono">{t.apiDocs.body}</dt>
              <dd className="text-[var(--fg-muted)]">application/octet-stream</dd>
            </div>
          )}
          {Object.entries(body?.properties ?? {}).map(([name, s]) => (
            <div key={`body-${name}`} className="contents">
              <dt className="font-mono">{name}</dt>
              <dd className="text-[var(--fg-muted)]">
                {t.apiDocs.body} · {typeOf(s)}
                {(body?.required ?? []).includes(name) ? ` · ${t.apiDocs.required}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

export function ApiDocs() {
  const q = useQuery({
    queryKey: ['openapi'],
    queryFn: async () => {
      const res = await fetch('/api/v1/openapi.json');
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as Doc;
    },
    staleTime: 10 * 60_000,
  });
  const doc = q.data;
  const groups = new Map<string, Array<{ method: string; path: string; op: Operation }>>();
  for (const [path, ops] of Object.entries(doc?.paths ?? {}))
    for (const [method, op] of Object.entries(ops)) {
      const tag = op.tags[0] ?? 'API';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push({ method, path, op });
    }
  const base = doc?.servers[0]?.url ?? '/api/v1';
  const card = 'z-card rounded-2xl p-5';
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <BookOpen className="h-5 w-5" aria-hidden="true" /> {t.apiDocs.title}
      </h1>
      <section className={card}>
        <p className="text-sm">{t.apiDocs.intro}</p>
        <dl className="mt-3 space-y-2 text-sm">
          <div>
            <dt className="text-xs text-[var(--fg-muted)]">{t.apiDocs.base}</dt>
            <dd>
              <code className="break-all">{base}</code>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--fg-muted)]">{t.apiDocs.auth}</dt>
            <dd>
              <code className="break-all">Authorization: Bearer zkd_…</code>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--fg-muted)]">{t.apiDocs.limits}</dt>
            <dd className="text-[var(--fg-muted)]">{t.apiDocs.limitsBody(API_RATE_PER_MINUTE)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--fg-muted)]">{t.apiDocs.idempotency}</dt>
            <dd className="text-[var(--fg-muted)]">{t.apiDocs.idempotencyBody}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href="/api/v1/openapi.json"
            download="zeiko-drive-openapi.json"
            className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--border)] px-4 text-sm hover:bg-[var(--bg-subtle)]"
          >
            <Download className="h-4 w-4" aria-hidden="true" /> {t.apiDocs.download}
          </a>
          <Link
            to="/pengaturan"
            className="inline-flex h-10 items-center rounded-full border border-[var(--border)] px-4 text-sm hover:bg-[var(--bg-subtle)]"
          >
            {t.apiDocs.manageTokens}
          </Link>
        </div>
      </section>
      {!doc ? (
        <p className="text-sm text-[var(--fg-muted)]">
          {q.isError ? t.errors.generic : t.apiDocs.loading}
        </p>
      ) : (
        <>
          <p className="text-xs text-[var(--fg-muted)]">{t.apiDocs.english}</p>
          {[...groups].map(([tag, ops]) => (
            <section key={tag} className={card} aria-label={tag}>
              <h2 className="font-medium">{tag}</h2>
              <ul className="mt-1 divide-y divide-[var(--border)]">
                {ops.map((o) => (
                  <OperationRow key={`${o.method} ${o.path}`} {...o} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
