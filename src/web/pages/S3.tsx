// Zeiko S3 (ADR-044): the endpoint, this account's storage, its access keys and buckets. The
// operator turns Zeiko S3 on and sets its storage (the relay); objects themselves are handled through
// the S3 API with any S3 tool.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Copy, Database, Globe, KeyRound, Lock, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { OPERATOR_EMAIL } from '../../shared/constants';
import { formatBytes, formatDate } from '../../shared/format';
import { Button } from '../components/Button';
import { Dialog, PromptDialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { api, ApiError, postJson, sendJson } from '../lib/api';
import { t } from '../lib/i18n';

interface S3Key {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface S3Bucket {
  name: string;
  public: boolean;
  blocked: boolean;
  createdAt: number;
}

interface S3Overview {
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  region: string;
  account: {
    status: 'active' | 'suspended';
    limitBytes: number;
    usedBytes: number;
    reservedBytes: number;
  } | null;
  keys: S3Key[];
  buckets: S3Bucket[];
}

const card = 'z-card rounded-2xl p-5';
const QUERY = ['s3'];

function copy(text: string) {
  void navigator.clipboard.writeText(text).then(() => toast(t.s3.copied));
}

/** A value with a copy button; `wrap` shows all of it (a secret shown once must be readable whole). */
function CopyField({
  label,
  value,
  wrap = false,
}: {
  label: string;
  value: string;
  wrap?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-[var(--fg-muted)]">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 rounded-lg bg-[var(--bg-subtle)] px-3 py-2 text-sm ${wrap ? 'break-all' : 'truncate'}`}
        >
          {value}
        </code>
        <Button
          variant="secondary"
          className="h-9 px-3"
          onClick={() => copy(value)}
          aria-label={`${t.s3.copy} ${label}`}
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  icon,
  action,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={card} aria-labelledby={id}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={id} className="flex items-center gap-2 font-medium">
          {icon}
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = e.data?.reason;
    if (reason === 'BucketAlreadyExists' || reason === 'BucketAlreadyOwnedByYou')
      return t.s3.nameTaken;
    if (reason === 'BucketNotEmpty') return t.s3.notEmpty;
    if (reason === 'InvalidBucketName') return t.s3.invalidName;
    if (e.code === 'CONFLICT' && typeof e.data?.max === 'number')
      return t.s3.tooManyKeys(e.data.max);
  }
  return t.errors.generic;
}

export function S3() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: QUERY, queryFn: () => api<S3Overview>('/api/s3') });
  const [naming, setNaming] = useState(false);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY });

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      await refresh();
      return true;
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createKey(label: string) {
    setNaming(false);
    await run(async () => {
      const r = await postJson<{ key: { id: string; secret: string } }>('/api/s3/keys', { label });
      setCreated({ id: r.key.id, secret: r.key.secret });
    });
  }

  async function createBucket(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const ok = await run(() =>
      postJson('/api/s3/buckets', {
        name: String(data.get('name') ?? '').trim(),
        public: data.get('public') === 'on',
      }),
    );
    if (ok) form.reset();
  }

  const header = (
    <>
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <Database className="h-5 w-5" aria-hidden="true" />
        {t.s3.title}
      </h1>
      <p className="text-sm text-[var(--fg-muted)]">{t.s3.intro}</p>
    </>
  );

  if (q.isPending) return <p className="p-6 text-[var(--fg-muted)]">{t.common.loading}</p>;
  if (q.isError || !q.data)
    return (
      <div className="p-6">
        <p role="alert" className="text-sm text-red-600">
          {t.errors.generic}
        </p>
      </div>
    );
  const d = q.data;
  const terms = (
    <p className="text-xs text-[var(--fg-muted)]">
      {t.s3.termsBefore}
      <Link to="/kebijakan/$slug" params={{ slug: 'syarat' }} className="underline">
        {t.s3.terms}
      </Link>
      {t.s3.termsAnd}
      <Link to="/kebijakan/$slug" params={{ slug: 'privasi' }} className="underline">
        {t.s3.privacy}
      </Link>
      .
    </p>
  );

  if (!d.configured || !d.enabled || !d.account || !d.endpoint)
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        {header}
        <div className={card}>
          <p className="text-sm">
            {d.configured ? t.s3.notEnabled(OPERATOR_EMAIL) : t.s3.notAvailable}
          </p>
          {d.configured && (
            <a
              href={`mailto:${OPERATOR_EMAIL}?subject=Zeiko%20S3`}
              className="mt-3 inline-flex h-9 items-center rounded-full border border-[var(--border)] px-4 text-sm font-medium hover:bg-[var(--bg-subtle)]"
            >
              {OPERATOR_EMAIL}
            </a>
          )}
        </div>
        {terms}
      </div>
    );

  const acc = d.account;
  const suspended = acc.status !== 'active';
  const pct = acc.limitBytes
    ? Math.min(100, ((acc.usedBytes + acc.reservedBytes) / acc.limitBytes) * 100)
    : 100;
  const endpoint = d.endpoint;
  const exampleKey = d.keys[0]?.id ?? 'ZK…';

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      {header}
      {suspended && (
        <p
          role="alert"
          className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {t.s3.suspended(OPERATOR_EMAIL)}
        </p>
      )}

      <Section
        id="s3-conn"
        title={t.s3.connection}
        icon={<Globe className="h-4 w-4" aria-hidden="true" />}
      >
        <div className="grid gap-3 md:grid-cols-[1fr_10rem]">
          <CopyField label={t.s3.endpoint} value={endpoint} />
          <CopyField label={t.s3.region} value={d.region} />
        </div>
        <p className="mt-2 text-xs text-[var(--fg-muted)]">{t.s3.pathStyle}</p>
        <div className="mt-4">
          <p className="text-sm text-[var(--fg-muted)]">{t.s3.storage}</p>
          <div
            className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--bg-subtle)]"
            role="presentation"
          >
            <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-sm">
            {t.s3.storageOf(formatBytes(acc.usedBytes), formatBytes(acc.limitBytes))}
          </p>
        </div>
      </Section>

      <Section
        id="s3-keys"
        title={t.s3.keys}
        icon={<KeyRound className="h-4 w-4" aria-hidden="true" />}
        action={
          <Button
            variant="secondary"
            className="h-9 px-3"
            disabled={busy || suspended}
            onClick={() => setNaming(true)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> {t.s3.newKey}
          </Button>
        }
      >
        <p className="text-sm text-[var(--fg-muted)]">{t.s3.keysHint}</p>
        {d.keys.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--fg-muted)]">{t.s3.noKeys}</p>
        ) : (
          <ul className="mt-3 divide-y divide-[var(--border)]">
            {d.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <code className="text-sm">{k.id}</code>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {[
                      k.label,
                      t.s3.created(formatDate(k.createdAt)),
                      k.lastUsedAt ? t.s3.lastUsed(formatDate(k.lastUsedAt)) : t.s3.neverUsed,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  className="h-9 px-3 text-red-600"
                  disabled={busy}
                  onClick={() => setRevoking(k.id)}
                >
                  {t.s3.revoke}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="s3-buckets"
        title={t.s3.buckets}
        icon={<Database className="h-4 w-4" aria-hidden="true" />}
      >
        {d.buckets.length === 0 ? (
          <p className="text-sm text-[var(--fg-muted)]">{t.s3.noBuckets}</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {d.buckets.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-[12rem] flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {b.public ? (
                      <Globe className="h-4 w-4 shrink-0 text-brand-700" aria-hidden="true" />
                    ) : (
                      <Lock
                        className="h-4 w-4 shrink-0 text-[var(--fg-muted)]"
                        aria-hidden="true"
                      />
                    )}
                    {b.name}
                    <span className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
                      {b.blocked ? t.s3.blocked : b.public ? t.s3.public : t.s3.private}
                    </span>
                  </p>
                  {b.public && (
                    <p className="mt-0.5 truncate text-xs text-[var(--fg-muted)]">
                      {t.s3.publicUrl}: {endpoint}/{b.name}/…
                    </p>
                  )}
                </div>
                {!b.blocked && (
                  <Button
                    variant="secondary"
                    className="h-9 px-3"
                    disabled={busy || suspended}
                    onClick={() =>
                      void run(() =>
                        sendJson('PATCH', `/api/s3/buckets/${encodeURIComponent(b.name)}`, {
                          public: !b.public,
                        }),
                      )
                    }
                  >
                    {b.public ? t.s3.makePrivate : t.s3.makePublic}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="h-9 px-3"
                  disabled={busy || suspended}
                  onClick={() => setDeleting(b.name)}
                  aria-label={`${t.s3.deleteBucket} ${b.name}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          onSubmit={(e) => void createBucket(e)}
          className="mt-4 space-y-2 border-t border-[var(--border)] pt-4"
        >
          <label className="block text-sm font-medium" htmlFor="s3-bucket-name">
            {t.s3.bucketName}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="s3-bucket-name"
              name="name"
              required
              minLength={3}
              maxLength={63}
              pattern="[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]"
              autoCapitalize="none"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-brand-500"
              aria-describedby="s3-bucket-hint"
            />
            <Button type="submit" disabled={busy || suspended}>
              {t.s3.newBucket}
            </Button>
          </div>
          <p id="s3-bucket-hint" className="text-xs text-[var(--fg-muted)]">
            {t.s3.bucketNameHint}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="public" className="mt-1" />
            <span>
              {t.s3.publicBucket}
              <span className="block text-xs text-[var(--fg-muted)]">{t.s3.publicHint}</span>
            </span>
          </label>
        </form>
      </Section>

      <Section
        id="s3-howto"
        title={t.s3.howTo}
        icon={<Database className="h-4 w-4" aria-hidden="true" />}
      >
        <p className="text-xs font-medium text-[var(--fg-muted)]">aws-cli</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-[var(--bg-subtle)] p-3 text-xs">
          {`aws configure set aws_access_key_id ${exampleKey}
aws configure set aws_secret_access_key <secret>
aws configure set region ${d.region}
aws s3 ls --endpoint-url ${endpoint}`}
        </pre>
        <p className="mt-3 text-xs font-medium text-[var(--fg-muted)]">rclone</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-[var(--bg-subtle)] p-3 text-xs">
          {`[zeiko]
type = s3
provider = Other
access_key_id = ${exampleKey}
secret_access_key = <secret>
endpoint = ${endpoint}
region = ${d.region}
force_path_style = true`}
        </pre>
        <p className="mt-3 text-sm text-[var(--fg-muted)]">{t.s3.limits}</p>
      </Section>

      {terms}

      <PromptDialog
        open={naming}
        title={t.s3.keyLabel}
        initial=""
        confirmLabel={t.s3.newKey}
        onCancel={() => setNaming(false)}
        onSubmit={(label) => void createKey(label)}
      />
      <Dialog open={created !== null} title={t.s3.keyCreatedTitle} onClose={() => setCreated(null)}>
        {created && (
          <div className="space-y-3">
            <p className="text-amber-800">{t.s3.keyCreatedBody}</p>
            <CopyField label={t.s3.accessKeyId} value={created.id} wrap />
            <CopyField label={t.s3.secretKey} value={created.secret} wrap />
          </div>
        )}
      </Dialog>
      <Dialog
        open={revoking !== null}
        title={t.s3.revokeTitle}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = revoking!;
                setRevoking(null);
                void run(
                  () => sendJson('DELETE', `/api/s3/keys/${encodeURIComponent(id)}`),
                  t.s3.revoked,
                );
              }}
            >
              {t.s3.revoke}
            </Button>
          </>
        }
      >
        {revoking && <p>{t.s3.revokeBody(revoking)}</p>}
      </Dialog>
      <Dialog
        open={deleting !== null}
        title={t.s3.deleteTitle}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const name = deleting!;
                setDeleting(null);
                void run(
                  () => sendJson('DELETE', `/api/s3/buckets/${encodeURIComponent(name)}`),
                  t.s3.deleted,
                );
              }}
            >
              {t.s3.deleteBucket}
            </Button>
          </>
        }
      >
        {deleting && <p>{t.s3.deleteBody(deleting)}</p>}
      </Dialog>
    </div>
  );
}
