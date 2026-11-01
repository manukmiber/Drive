// A bucket's objects on the /s3 page (ADR-055): one folder level at a time, upload (one request per
// file, a few at once by the device's own setting; files bigger than a part go up in parts with
// pause, resume and cancel, S4/ADR-075), new folder, download, temporary link, delete. Downloads and
// links are ordinary presigned URLs.
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  History,
  Link2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { formatBytes, formatDateTime } from '../../shared/format';
import { Button } from '../components/Button';
import { Dialog, PromptDialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { downloads } from '../download/useDownloads';
import { api, ApiError, postJson } from '../lib/api';
import { useCatalog } from '../lib/catalog';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import { transfer } from '../lib/transfer';
import { S3MultipartUpload, type S3UploadState } from '../lib/s3-upload';
import { putWithProgress } from '../upload/xhr';

interface Page {
  prefix: string;
  prefixes: string[];
  objects: Array<{ key: string; size: number; etag: string; modifiedAt: number }>;
  nextCursor: string | null;
}

interface Sending {
  id: string;
  name: string;
  size: number;
  loaded: number;
  error: string | null;
  /** Big files only (S4): the upload in parts, and where it stands. */
  job?: S3MultipartUpload;
  state?: S3UploadState;
}

const LINK_CHOICES = [3600, 86400, 604800];

const base = (bucket: string) => `/api/s3/buckets/${encodeURIComponent(bucket)}`;
const tail = (key: string, prefix: string) => key.slice(prefix.length).replace(/\/$/, '');

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const reason = (e.data as { reason?: string } | undefined)?.reason;
    if (reason === 's3_no_key') return t.s3.needKey;
    if (reason === 's3_readonly') return t.s3.uploadsPaused;
    if (e.code === 'QUOTA_FULL') return t.errors.quotaFull;
    return e.message || t.errors.generic;
  }
  return t.errors.generic;
}

async function presign(bucket: string, key: string, seconds: number, versionId?: string) {
  return postJson<{ url: string; expiresAt: number; keyId: string }>(
    `${base(bucket)}/objects/link`,
    {
      key,
      expiresInSeconds: seconds,
      download: true,
      ...(versionId ? { versionId } : {}),
    },
  );
}

export type Versioning = '' | 'Enabled' | 'Suspended';

interface WebVersion {
  versionId: string;
  isLatest: boolean;
  deleteMarker: boolean;
  size: number;
  modifiedAt: number;
  lock: { mode: string | null; until: number | null; legalHold: boolean } | null;
}

/** ADR-092: one object's versions, newest first: download, restore, delete for good. */
function VersionsDialog({
  bucket,
  objectKey,
  hasKey,
  canWrite,
  onClose,
  onChanged,
}: {
  bucket: string;
  objectKey: string;
  hasKey: boolean;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const q = useQuery({
    queryKey: ['s3-versions', bucket, objectKey],
    queryFn: () =>
      api<{ versions: WebVersion[] }>(
        `${base(bucket)}/versions?${new URLSearchParams({ key: objectKey })}`,
      ),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const name = objectKey.slice(objectKey.lastIndexOf('/') + 1) || objectKey;
  async function act(versionId: string, what: 'restore' | 'delete' | 'download') {
    setBusy(versionId);
    try {
      if (what === 'download') {
        const { url } = await presign(bucket, objectKey, 600, versionId);
        const a = document.createElement('a');
        a.href = url;
        a.rel = 'noopener';
        a.click();
      } else {
        await postJson(`${base(bucket)}/versions/${what}`, { key: objectKey, versionId });
        toast(what === 'restore' ? t.s3.restored : t.s3.versionDeleted);
        await q.refetch();
        onChanged();
      }
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }
  const list = q.data?.versions ?? [];
  return (
    <Dialog open title={t.s3.versionsTitle(name)} onClose={onClose}>
      {q.isPending ? (
        <p className="text-sm text-[var(--fg-muted)]">{t.common.loading}</p>
      ) : q.isError ? (
        <p role="alert" className="text-sm text-red-600">
          {errorText(q.error)}
        </p>
      ) : list.length < 2 && !list.some((v) => v.deleteMarker) ? (
        <p className="text-sm text-[var(--fg-muted)]">{t.s3.versionsEmpty}</p>
      ) : null}
      <ul className="mt-1 max-h-[55vh] divide-y divide-[var(--border)] overflow-y-auto text-sm">
        {list.map((v) => (
          <li key={v.versionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                {v.deleteMarker ? (
                  <Trash2 className="h-4 w-4 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
                ) : (
                  <History className="h-4 w-4 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
                )}
                <span className="tabular-nums">{formatDateTime(v.modifiedAt)}</span>
                {v.isLatest && (
                  <span className="rounded-full bg-brand-50 px-2 text-xs text-brand-800 dark:bg-brand-800/40 dark:text-brand-100">
                    {t.s3.versionLatest}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block text-xs text-[var(--fg-muted)]">
                {v.deleteMarker ? t.s3.versionMarker : formatBytes(v.size)}
                {v.lock?.legalHold && ` · ${t.s3.versionLegalHold}`}
                {v.lock?.until && v.lock.until > q.dataUpdatedAt
                  ? ` · ${t.s3.versionLockedUntil(formatDateTime(v.lock.until))}`
                  : ''}
              </span>
            </span>
            {!v.deleteMarker && (
              <button
                type="button"
                className="rounded-full p-2 hover:bg-[var(--bg-subtle)] disabled:opacity-40"
                disabled={!hasKey || busy !== null}
                onClick={() => void act(v.versionId, 'download')}
                aria-label={t.s3.versionDownload}
                title={hasKey ? t.s3.versionDownload : t.s3.needKey}
              >
                <Download className="h-4 w-4" />
              </button>
            )}
            {!v.isLatest && !v.deleteMarker && (
              <Button
                variant="secondary"
                className="h-8 px-3 text-xs"
                disabled={!canWrite || busy !== null}
                onClick={() => void act(v.versionId, 'restore')}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t.s3.restore}
              </Button>
            )}
            {v.isLatest && v.deleteMarker && (
              <Button
                variant="secondary"
                className="h-8 px-3 text-xs"
                disabled={!canWrite || busy !== null}
                onClick={() => void act(v.versionId, 'restore')}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t.s3.restore}
              </Button>
            )}
            {confirm === v.versionId ? (
              <span className="flex w-full items-center justify-end gap-2 text-xs">
                <span className="text-red-600">{t.s3.versionDeleteConfirm}</span>
                <Button variant="ghost" className="h-8 px-2" onClick={() => setConfirm(null)}>
                  {t.common.cancel}
                </Button>
                <Button
                  variant="danger"
                  className="h-8 px-2"
                  disabled={busy !== null}
                  onClick={() => void act(v.versionId, 'delete')}
                >
                  {t.s3.versionDelete}
                </Button>
              </span>
            ) : (
              <button
                type="button"
                className="rounded-full p-2 text-red-600 hover:bg-[var(--bg-subtle)] disabled:opacity-40"
                disabled={busy !== null}
                onClick={() => setConfirm(v.versionId)}
                aria-label={t.s3.versionDelete}
                title={t.s3.versionDelete}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function S3Browser({
  bucket,
  canWrite,
  hasKey,
  versioning,
  onVersioning,
  onClose,
}: {
  bucket: string;
  canWrite: boolean;
  hasKey: boolean;
  /** ADR-092: the bucket's versioning, and a way to change it. */
  versioning: Versioning;
  onVersioning: (status: 'Enabled' | 'Suspended') => Promise<void>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const config = useCatalog().data?.config;
  const maxUpload = Number(config?.s3_web_upload_max_bytes ?? 95 * 1024 * 1024);
  const partBytes = Number(config?.s3_web_part_bytes ?? 32 * 1024 * 1024);
  const maxMultipart = Number(config?.s3_web_multipart_max_bytes ?? 50 * 1024 ** 3);
  const [prefix, setPrefix] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<Sending[]>([]);
  const [naming, setNaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const deleted = useQuery({
    queryKey: ['s3-deleted', bucket, prefix],
    enabled: showDeleted && versioning !== '',
    queryFn: () =>
      api<{ items: Array<{ key: string; deletedAt: number; markerId: string }> }>(
        `${base(bucket)}/deleted?${new URLSearchParams({ prefix })}`,
      ),
  });
  async function restoreDeleted(key: string, markerId: string) {
    try {
      await postJson(`${base(bucket)}/versions/restore`, { key, versionId: markerId });
      toast(t.s3.restored);
      await Promise.all([refresh(), deleted.refetch()]);
    } catch (e) {
      toast(errorText(e));
    }
  }
  const key = ['s3-objects', bucket, prefix];
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api<Page>(
        `${base(bucket)}/objects?${new URLSearchParams({ prefix, ...(pageParam ? { cursor: pageParam } : {}) })}`,
      ),
    getNextPageParam: (last) => last.nextCursor,
  });
  const folders = q.data?.pages.flatMap((p) => p.prefixes) ?? [];
  const objects = q.data?.pages.flatMap((p) => p.objects) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['s3-objects', bucket] });
  const go = (p: string) => {
    setPrefix(p);
    setSelected(new Set());
  };
  const toggle = (k: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const crumbs = prefix
    .split('/')
    .filter(Boolean)
    .map((part, i, all) => ({ name: part, prefix: `${all.slice(0, i + 1).join('/')}/` }));

  const patch = (id: string, p: Partial<Sending>) =>
    setSending((s) => s.map((r) => (r.id === id ? { ...r, ...p } : r)));

  /** A file bigger than one part: in parts, until done, paused, failed or cancelled. */
  function inParts(file: File, row: Sending): Promise<S3UploadState> {
    return new Promise((resolve) => {
      const job = new S3MultipartUpload(base(bucket), prefix + file.name, file, {
        progress: (loaded) => patch(row.id, { loaded }),
        state: (state, error) => {
          patch(row.id, { state, error: state === 'failed' ? errorText(error) : null });
          if (state !== 'running') resolve(state);
        },
      });
      patch(row.id, { job });
      void job.start();
    });
  }

  async function upload(files: File[]) {
    const items = files.map((f) => ({
      file: f,
      row: {
        id: crypto.randomUUID(),
        name: f.name,
        size: f.size,
        loaded: 0,
        error: f.size > maxMultipart ? t.s3.uploadTooBig(formatBytes(maxMultipart)) : null,
      } as Sending,
    }));
    setSending((s) => [...items.map((i) => i.row), ...s]);
    const queue = items.filter((i) => !i.row.error);
    let ok = 0;
    // As many at once as the device's own upload setting (ADR-053).
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const { file, row } = it;
        if (file.size > partBytes || file.size > maxUpload) {
          // Paused or failed ones wait for the person; the next file goes on.
          if ((await inParts(file, row)) === 'done') {
            ok++;
            setSending((s) => s.filter((r) => r.id !== row.id));
          }
          continue;
        }
        const h = putWithProgress(
          `${base(bucket)}/objects?${new URLSearchParams({ key: prefix + file.name })}`,
          file,
          (loaded) => patch(row.id, { loaded }),
          file.type ? { 'x-object-content-type': file.type } : {},
        );
        try {
          await h.promise;
          ok++;
          setSending((s) => s.filter((r) => r.id !== row.id));
        } catch (e) {
          patch(row.id, { error: errorText(e) });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(transfer.get().uploadFiles, queue.length) }, worker),
    );
    if (ok) toast(t.s3.uploaded(ok));
    void refresh();
  }

  /** Resume after a pause or a failure; the list refreshes when it is done. */
  async function carryOn(row: Sending) {
    const job = row.job;
    if (!job) return;
    // start() comes back when this run stops: done, paused again, failed, or cancelled.
    await job.start();
    if (job.state === 'done') {
      setSending((s) => s.filter((r) => r.id !== row.id));
      toast(t.s3.uploaded(1));
      void refresh();
    }
  }

  async function cancel(row: Sending) {
    await row.job?.cancel();
    setSending((s) => s.filter((r) => r.id !== row.id));
    toast(t.s3.uploadCancelled);
  }

  async function newFolder(name: string) {
    setNaming(false);
    const clean = name.trim().replace(/\/+/g, '-');
    if (!clean) return;
    const h = putWithProgress(
      `${base(bucket)}/objects?${new URLSearchParams({ key: `${prefix}${clean}/` })}`,
      new Blob([]),
      () => undefined,
    );
    try {
      await h.promise;
      go(`${prefix}${clean}/`);
      void refresh();
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  }

  async function downloadSelected() {
    const chosen = objects.filter((o) => selected.has(o.key));
    try {
      const links = await Promise.all(chosen.map((o) => presign(bucket, o.key, 3600)));
      // Another site's links: the browser's own downloads take them, a few at a time.
      downloads().add(
        chosen.map((o, i) => ({
          name: tail(o.key, prefix),
          path: o.key,
          size: o.size,
          url: links[i]!.url,
          refresh: async () => (await presign(bucket, o.key, 3600)).url,
        })),
        null,
      );
      setSelected(new Set());
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  }

  async function removeSelected() {
    setConfirmDelete(false);
    try {
      const r = await postJson<{ deleted: number }>(`${base(bucket)}/objects/delete`, {
        keys: [...selected],
      });
      toast(t.s3.objectsDeleted(r.deleted));
      setSelected(new Set());
      void refresh();
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  }

  const allKeys = objects.map((o) => o.key);
  const allOn = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const iconButton = 'rounded-full p-2 hover:bg-[var(--bg-subtle)] disabled:opacity-40';

  return (
    <section className="z-card rounded-2xl p-5" aria-labelledby="s3-browser">
      <div className="flex items-center gap-2">
        <h2 id="s3-browser" className="flex-1 truncate font-medium">
          {t.s3.browseTitle(bucket)}
        </h2>
        <button
          type="button"
          className={iconButton}
          onClick={() => void refresh()}
          aria-label={t.s3.refresh}
          title={t.s3.refresh}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={iconButton}
          onClick={onClose}
          aria-label={t.common.close}
          title={t.common.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <nav aria-label={t.a11y.location} className="mt-2 flex flex-wrap items-center gap-1 text-sm">
        <button type="button" className="font-medium text-brand-700" onClick={() => go('')}>
          {bucket}
        </button>
        {crumbs.map((c) => (
          <span key={c.prefix} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-[var(--fg-muted)]" aria-hidden="true" />
            <button type="button" className="text-brand-700" onClick={() => go(c.prefix)}>
              {c.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          className="h-9 px-3"
          disabled={!canWrite}
          onClick={() => fileInput.current?.click()}
        >
          <Upload className="h-4 w-4" aria-hidden="true" /> {t.s3.upload}
        </Button>
        <Button
          variant="secondary"
          className="h-9 px-3"
          disabled={!canWrite}
          onClick={() => setNaming(true)}
        >
          <FolderPlus className="h-4 w-4" aria-hidden="true" /> {t.s3.newFolder}
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void upload(files);
          }}
        />
        {selected.size > 0 && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-brand-50 px-2 py-1 text-sm text-brand-800 dark:bg-brand-800/40 dark:text-brand-100">
            <span className="px-1">{t.s3.selectedN(selected.size)}</span>
            <button
              type="button"
              className={iconButton}
              disabled={!hasKey}
              onClick={() => void downloadSelected()}
              aria-label={t.s3.downloadSelected}
              title={hasKey ? t.s3.downloadSelected : t.s3.needKey}
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={iconButton}
              disabled={!hasKey || selected.size !== 1}
              onClick={() => setLinkFor([...selected][0]!)}
              aria-label={t.s3.copyObjectLink}
              title={hasKey ? t.s3.copyObjectLink : t.s3.needKey}
            >
              <Link2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={cn(iconButton, 'text-red-600')}
              onClick={() => setConfirmDelete(true)}
              aria-label={t.s3.deleteSelected}
              title={t.s3.deleteSelected}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </span>
        )}
      </div>
      {!hasKey && <p className="mt-2 text-xs text-[var(--fg-muted)]">{t.s3.needKey}</p>}
      {!canWrite && <p className="mt-2 text-xs text-amber-700">{t.s3.uploadsPaused}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--bg-subtle)] px-3 py-2 text-sm">
        <History className="h-4 w-4 shrink-0 text-[var(--fg-muted)]" aria-hidden="true" />
        <span className="font-medium">
          {versioning === 'Enabled'
            ? t.s3.versioningOn
            : versioning === 'Suspended'
              ? t.s3.versioningPaused
              : t.s3.versioning}
        </span>
        {versioning === 'Enabled' ? (
          <Button
            variant="ghost"
            className="h-8 px-2 text-xs"
            disabled={!canWrite}
            onClick={() => void onVersioning('Suspended')}
          >
            {t.s3.versioningSuspend}
          </Button>
        ) : (
          <Button
            variant="secondary"
            className="h-8 px-3 text-xs"
            disabled={!canWrite}
            onClick={() => void onVersioning('Enabled')}
          >
            {t.s3.versioningEnable}
          </Button>
        )}
        {versioning !== '' && (
          <label className="ml-auto flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
            />
            {t.s3.showDeleted}
          </label>
        )}
        <span className="basis-full text-xs text-[var(--fg-muted)]">{t.s3.versioningHint}</span>
      </div>

      {sending.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {sending.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              {r.error ? (
                <span className="min-w-0 truncate text-red-600" title={r.error}>
                  {t.s3.uploadFailed}: {r.error}
                </span>
              ) : (
                <span className="tabular-nums text-[var(--fg-muted)]">
                  {r.state === 'paused' && `${t.s3.uploadPaused} · `}
                  {r.size ? Math.round((r.loaded / r.size) * 100) : 100}%
                </span>
              )}
              {r.job && r.state === 'running' && (
                <button
                  type="button"
                  className="rounded-full p-1 hover:bg-[var(--bg-subtle)]"
                  aria-label={t.s3.uploadPause}
                  title={t.s3.uploadPause}
                  onClick={() => r.job!.pause()}
                >
                  <Pause className="h-3.5 w-3.5" />
                </button>
              )}
              {r.job && (r.state === 'paused' || r.state === 'failed') && (
                <button
                  type="button"
                  className="rounded-full p-1 hover:bg-[var(--bg-subtle)]"
                  aria-label={r.state === 'paused' ? t.s3.uploadResume : t.s3.uploadRetry}
                  title={r.state === 'paused' ? t.s3.uploadResume : t.s3.uploadRetry}
                  onClick={() => void carryOn(r)}
                >
                  {r.state === 'paused' ? (
                    <Play className="h-3.5 w-3.5" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              {r.job ? (
                <button
                  type="button"
                  className="rounded-full p-1 hover:bg-[var(--bg-subtle)]"
                  aria-label={t.s3.uploadCancel}
                  title={t.s3.uploadCancel}
                  onClick={() => void cancel(r)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                r.error && (
                  <button
                    type="button"
                    aria-label={t.common.close}
                    onClick={() => setSending((s) => s.filter((x) => x.id !== r.id))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--fg-muted)]">
            <tr>
              <th className="w-8 py-2">
                <input
                  type="checkbox"
                  aria-label={t.s3.selectAll}
                  checked={allOn}
                  onChange={() => setSelected(allOn ? new Set() : new Set(allKeys))}
                />
              </th>
              <th className="py-2 font-normal">{t.s3.colName}</th>
              <th className="py-2 text-right font-normal">{t.s3.colSize}</th>
              <th className="hidden py-2 pl-4 font-normal sm:table-cell">{t.s3.colModified}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {folders.map((p) => (
              <tr key={p}>
                <td />
                <td className="py-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left font-medium"
                    onClick={() => go(p)}
                  >
                    <Folder className="h-4 w-4 shrink-0 text-brand-700" aria-hidden="true" />
                    <span className="break-all">{tail(p, prefix)}</span>
                  </button>
                </td>
                <td />
                <td className="hidden sm:table-cell" />
              </tr>
            ))}
            {objects.map((o) => (
              <tr key={o.key} className={cn(selected.has(o.key) && 'bg-[var(--bg-subtle)]')}>
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={tail(o.key, prefix)}
                    checked={selected.has(o.key)}
                    onChange={() => toggle(o.key)}
                  />
                </td>
                <td className="py-2">
                  <span className="flex items-center gap-2">
                    <FileIcon
                      className="h-4 w-4 shrink-0 text-[var(--fg-muted)]"
                      aria-hidden="true"
                    />
                    <span className="break-all">{tail(o.key, prefix)}</span>
                    {versioning !== '' && (
                      <button
                        type="button"
                        className="ml-auto rounded-full p-1 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
                        onClick={() => setVersionsFor(o.key)}
                        aria-label={`${t.s3.versionsButton}: ${tail(o.key, prefix)}`}
                        title={t.s3.versionsButton}
                      >
                        <History className="h-4 w-4" />
                      </button>
                    )}
                  </span>
                </td>
                <td className="py-2 text-right whitespace-nowrap tabular-nums">
                  {formatBytes(o.size)}
                </td>
                <td className="hidden py-2 pl-4 whitespace-nowrap text-[var(--fg-muted)] sm:table-cell">
                  {formatDateTime(o.modifiedAt)}
                </td>
              </tr>
            ))}
            {showDeleted &&
              (deleted.data?.items ?? []).map((d) => (
                <tr key={`deleted:${d.key}`} className="text-[var(--fg-muted)]">
                  <td />
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="break-all line-through">{tail(d.key, prefix)}</span>
                      <span className="rounded-full bg-[var(--bg-subtle)] px-2 text-xs">
                        {t.s3.deletedLabel}
                      </span>
                      <span className="ml-auto flex items-center gap-1">
                        <button
                          type="button"
                          className="rounded-full p-1 hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
                          onClick={() => setVersionsFor(d.key)}
                          aria-label={`${t.s3.versionsButton}: ${tail(d.key, prefix)}`}
                          title={t.s3.versionsButton}
                        >
                          <History className="h-4 w-4" />
                        </button>
                        <Button
                          variant="secondary"
                          className="h-7 px-2 text-xs"
                          disabled={!canWrite}
                          onClick={() => void restoreDeleted(d.key, d.markerId)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t.s3.restore}
                        </Button>
                      </span>
                    </span>
                  </td>
                  <td />
                  <td className="hidden py-2 pl-4 whitespace-nowrap sm:table-cell">
                    {formatDateTime(d.deletedAt)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {q.isPending && <p className="py-4 text-sm text-[var(--fg-muted)]">{t.common.loading}</p>}
        {q.isError && (
          <p role="alert" className="py-4 text-sm text-red-600">
            {errorText(q.error)}
          </p>
        )}
        {q.isSuccess && !folders.length && !objects.length && (
          <p className="py-4 text-sm text-[var(--fg-muted)]">{t.s3.emptyFolder}</p>
        )}
        {q.hasNextPage && (
          <Button
            variant="ghost"
            className="mt-2"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {t.s3.loadMore}
          </Button>
        )}
      </div>

      <PromptDialog
        open={naming}
        title={t.s3.newFolder}
        initial=""
        confirmLabel={t.common.save}
        onCancel={() => setNaming(false)}
        onSubmit={(name) => void newFolder(name)}
      />
      <Dialog
        open={confirmDelete}
        title={t.s3.deleteObjectsTitle(selected.size)}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t.common.cancel}
            </Button>
            <Button variant="danger" onClick={() => void removeSelected()}>
              {t.s3.deleteSelected}
            </Button>
          </>
        }
      >
        <p>{t.s3.deleteObjectsBody}</p>
      </Dialog>
      {linkFor && (
        <LinkDialog bucket={bucket} objectKey={linkFor} onClose={() => setLinkFor(null)} />
      )}
      {versionsFor && (
        <VersionsDialog
          bucket={bucket}
          objectKey={versionsFor}
          hasKey={hasKey}
          canWrite={canWrite}
          onClose={() => setVersionsFor(null)}
          onChanged={() => {
            void refresh();
            void deleted.refetch();
          }}
        />
      )}
    </section>
  );
}

function LinkDialog({
  bucket,
  objectKey,
  onClose,
}: {
  bucket: string;
  objectKey: string;
  onClose: () => void;
}) {
  const [seconds, setSeconds] = useState(LINK_CHOICES[1]!);
  const [made, setMade] = useState<{ url: string; keyId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function make() {
    setBusy(true);
    try {
      const r = await presign(bucket, objectKey, seconds);
      setMade(r);
      await navigator.clipboard.writeText(r.url).then(
        () => toast(t.s3.linkCopied),
        () => undefined,
      );
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={t.s3.linkTitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.close}
          </Button>
          <Button disabled={busy} onClick={() => void make()}>
            {t.s3.makeLink}
          </Button>
        </>
      }
    >
      <p className="break-all font-medium">{objectKey}</p>
      <p className="mt-1 text-[var(--fg-muted)]">{t.s3.linkBody}</p>
      <label className="mt-3 block text-xs text-[var(--fg-muted)]">
        {t.s3.linkExpiry}
        <select
          value={seconds}
          onChange={(e) => {
            setSeconds(Number(e.target.value));
            setMade(null);
          }}
          className="mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-transparent px-2 text-sm text-[var(--fg)]"
        >
          {LINK_CHOICES.map((s) => (
            <option key={s} value={s}>
              {t.s3.linkExpiryOptions[s]}
            </option>
          ))}
        </select>
      </label>
      {made && (
        <div className="mt-3 space-y-1">
          <input
            readOnly
            value={made.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t.a11y.link}
            className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 text-xs"
          />
          <p className="text-xs text-[var(--fg-muted)]">{t.s3.linkSignedWith(made.keyId)}</p>
        </div>
      )}
    </Dialog>
  );
}
