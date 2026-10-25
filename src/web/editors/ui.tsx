// Pieces every editor shares (ADR-050): the full-screen frame, loading the files, the busy cover,
// and the save dialog (to Drive as a new file or in place of the original, or to this device).
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { formatBytes } from '../../shared/format';
import { Button } from '../components/Button';
import { Dialog } from '../components/ui/Dialog';
import { toast } from '../components/ui/Toast';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import type { Catalog } from '../lib/types';
import {
  TooLargeError,
  downloadBlob,
  extOf,
  fromFile,
  loadNode,
  maxBytes,
  saveFolder,
  saveToDrive,
  type EditRequest,
  type Source,
  type Tool,
} from './files';

export function useConfig() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<Catalog>('/api/public/catalog'),
    staleTime: 10 * 60_000,
  }).data?.config;
}

export function errorMessage(e: unknown): string {
  if (e instanceof TooLargeError) return t.editor.tooLarge(formatBytes(e.max));
  return t.editor.cannotOpen;
}

/** Loads every file of the request (Drive files one after another), with overall progress. */
export function useSources(req: EditRequest, tool: Tool) {
  const config = useConfig();
  const [state, setState] = useState<{
    sources: Source[] | null;
    progress: number;
    error: string | null;
  }>({ sources: null, progress: 0, error: null });
  const max = maxBytes(config, tool);
  const ready = Boolean(config);
  useEffect(() => {
    if (!ready) return;
    const ac = new AbortController();
    (async () => {
      const out: Source[] = [];
      const total = req.nodes.length || 1;
      for (let i = 0; i < req.nodes.length; i++) {
        const node = req.nodes[i]!;
        const blob = await loadNode(
          node,
          max,
          (p) => setState((s) => ({ ...s, progress: (i + p) / total })),
          ac.signal,
        );
        out.push({ name: node.name, blob, node });
      }
      for (const f of req.files) out.push(fromFile(f, max));
      if (!ac.signal.aborted) setState({ sources: out, progress: 1, error: null });
    })().catch((e: unknown) => {
      if (!ac.signal.aborted) setState({ sources: null, progress: 0, error: errorMessage(e) });
    });
    return () => ac.abort();
  }, [req, max, ready]);
  return state;
}

export function EditorFrame({
  title,
  onClose,
  actions,
  children,
  dirty = false,
}: {
  title: string;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
  /** Ask before closing. */
  dirty?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const close = () => (dirty ? setAsking(true) : onClose());
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest('dialog')) return;
      if (dirty) setAsking(true);
      else onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [dirty, onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--card)] px-2 py-2 sm:px-3">
        <button
          type="button"
          onClick={close}
          className="rounded-full p-2 hover:bg-[var(--bg-subtle)]"
          aria-label={t.common.close}
        >
          <X className="h-5 w-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold sm:text-base">{title}</h1>
        <div className="flex items-center gap-1.5">{actions}</div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      <Dialog
        open={asking}
        title={t.editor.closeTitle}
        onClose={() => setAsking(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t.editor.keepEditing}
            </Button>
            <Button variant="danger" onClick={onClose}>
              {t.editor.discard}
            </Button>
          </>
        }
      >
        <p>{t.editor.closeBody}</p>
      </Dialog>
    </div>
  );
}

/** Covers the editor while a file loads or a result is being made. */
export function Busy({
  label,
  progress,
  onCancel,
}: {
  label: string;
  progress?: number | null;
  onCancel?: () => void;
}) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[var(--bg)]/85 p-6 text-center backdrop-blur-sm">
      <p className="text-sm font-medium" aria-live="polite">
        {label}
      </p>
      {progress != null && (
        <div
          className="h-2 w-64 max-w-full overflow-hidden rounded-full bg-[var(--border)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <div
            className="h-full bg-brand-600 transition-[width]"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      )}
      {onCancel && (
        <Button variant="ghost" onClick={onCancel}>
          {t.common.cancel}
        </Button>
      )}
    </div>
  );
}

export function Failed({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="max-w-sm text-sm">{message}</p>
      <Button variant="secondary" onClick={onClose}>
        {t.common.close}
      </Button>
    </div>
  );
}

/** A small labelled toolbar button (icon above, words below on phones). */
export function ToolButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'flex min-w-16 shrink-0 flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[11px] leading-tight text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)] disabled:opacity-40 sm:text-xs',
        active && 'bg-[var(--accent-soft)] text-[var(--accent)]',
      )}
    >
      <Icon className="h-5 w-5" />
      <span className="line-clamp-2 max-w-[5.5rem] text-center">{label}</span>
    </button>
  );
}

export interface Result {
  blob: Blob;
  name: string;
}

/**
 * Saving: one result can get a new name, or replace the original when it keeps its type; several
 * results (parts) are saved or downloaded together.
 */
export function SaveDialog({
  results,
  source,
  onClose,
  onSaved,
  replaceable = true,
}: {
  results: Result[] | null;
  /** The file the results came from (for "replace" and the folder). */
  source: Source | null;
  onClose: () => void;
  /** After the result went to Drive or this device (closing the editor needs no question then). */
  onSaved?: () => void;
  /** False when the result is more than the source (joined files, pages taken out). */
  replaceable?: boolean;
}) {
  const one = results?.length === 1 ? results[0]! : null;
  const [name, setName] = useState('');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const canReplace = Boolean(
    replaceable && one && source?.node && extOf(one.name) === extOf(source.name),
  );
  // New results start from their own name (state from the previous render, not an effect).
  const [shown, setShown] = useState(results);
  if (results !== shown) {
    setShown(results);
    setName(one?.name ?? '');
    setReplace(false);
  }

  async function toDrive() {
    if (!results) return;
    setBusy(true);
    try {
      const { parentId, same } = await saveFolder(source?.node ?? null);
      if (one) {
        const asReplace = replace && canReplace && same;
        saveToDrive(
          one.blob,
          asReplace ? source!.name : name.trim() || one.name,
          parentId,
          asReplace,
        );
      } else for (const r of results) saveToDrive(r.blob, r.name, parentId, false);
      toast(
        !same && source?.node
          ? t.editor.savingToMyDrive(results.length)
          : t.editor.saving(results.length),
      );
      onSaved?.();
      onClose();
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function toDevice() {
    if (!results) return;
    if (one) downloadBlob(one.blob, name.trim() || one.name);
    else results.forEach((r, i) => setTimeout(() => downloadBlob(r.blob, r.name), i * 400));
    onSaved?.();
  }

  // Before → after only compares like with like: one file made from one file.
  const before = replaceable ? (source?.blob.size ?? 0) : 0;
  const after = results?.reduce((s, r) => s + r.blob.size, 0) ?? 0;
  return (
    <Dialog
      open={Boolean(results)}
      title={t.editor.saveTitle}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={toDevice} disabled={busy}>
            {t.editor.downloadOnly}
          </Button>
          <Button onClick={() => void toDrive()} disabled={busy}>
            {t.editor.saveToDrive}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {one ? (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-[var(--fg-muted)]">{t.editor.fileName}</span>
              <input
                value={replace && canReplace ? source!.name : name}
                disabled={replace && canReplace}
                onChange={(e) => setName(e.target.value)}
                maxLength={255}
                className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 outline-none focus:border-brand-500 disabled:opacity-60"
              />
            </label>
            {canReplace && (
              <fieldset className="space-y-1.5">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!replace} onChange={() => setReplace(false)} />
                  {t.editor.saveNew}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={replace} onChange={() => setReplace(true)} />
                  {t.editor.saveReplace}
                </label>
                {replace && (
                  <p className="text-xs text-[var(--fg-muted)]">{t.editor.replaceNote}</p>
                )}
              </fieldset>
            )}
          </>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-auto text-xs">
            {results?.map((r) => (
              <li key={r.name} className="flex justify-between gap-3">
                <span className="truncate">{r.name}</span>
                <span className="shrink-0 text-[var(--fg-muted)]">{formatBytes(r.blob.size)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-[var(--fg-muted)]">
          {before ? t.editor.sizes(formatBytes(before), formatBytes(after)) : formatBytes(after)}
        </p>
      </div>
    </Dialog>
  );
}
