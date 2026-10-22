// Global upload panel, bottom-right (Google Drive style, SPEC §5.2).
import { Link } from '@tanstack/react-router';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../../shared/format';
import { t } from '../lib/i18n';
import { uploads, useUploads } from '../upload/useUploads';
import type { UploadTask } from '../upload/manager';
import { Button } from './Button';
import { FileIcon } from './FileIcon';
import { Dialog } from './ui/Dialog';

function eta(task: UploadTask): string | null {
  if (task.speed <= 0) return null;
  const s = Math.round((task.size - task.loaded) / task.speed);
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  return `${Math.floor(s / 3600)} j ${Math.round((s % 3600) / 60)} mnt`;
}

function Row({ task }: { task: UploadTask }) {
  const m = uploads();
  const pct = task.size ? Math.round((task.loaded / task.size) * 100) : 100;
  const running = task.status === 'uploading';
  let sub: string;
  switch (task.status) {
    case 'uploading': {
      const e = eta(task);
      sub = `${formatBytes(task.loaded)} / ${formatBytes(task.size)} · ${t.upload.speed(formatBytes(task.speed))}${e ? ` · ${t.upload.eta(e)}` : ''}`;
      break;
    }
    case 'queued':
      sub = t.upload.queued;
      break;
    case 'paused':
      sub = `${t.upload.paused} · ${pct}%`;
      break;
    case 'completing':
      sub = t.upload.completing;
      break;
    case 'done':
      sub = formatBytes(task.size);
      break;
    case 'error':
      sub =
        task.errorCode === 'QUOTA_FULL'
          ? t.errors.quotaFull
          : task.errorCode === 'FILE_TOO_LARGE'
            ? t.errors.fileTooLarge
            : `${t.upload.failed}: ${task.error ?? ''}`;
      break;
    case 'canceled':
      sub = t.upload.canceled;
      break;
    case 'skipped':
      sub = t.upload.skipped;
      break;
    default:
      sub = '';
  }
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <FileIcon node={{ kind: 'file', mime: task.file.type, name: task.name }} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{task.name}</p>
        <p
          className={`truncate text-xs ${task.status === 'error' ? 'text-red-600' : 'text-[var(--fg-muted)]'}`}
        >
          {sub}
        </p>
        {task.errorCode === 'QUOTA_FULL' && (
          <Link to="/paket" className="text-xs font-medium text-brand-700">
            {t.upload.quotaFullAction}
          </Link>
        )}
        {(running || task.status === 'paused') && (
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--border)]">
            <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}
        {task.status === 'resumable' && (
          <div className="mt-1 flex gap-2 text-xs">
            <span className="text-[var(--fg-muted)]">{t.upload.resumeOffer(task.name)}</span>
            <button
              type="button"
              className="font-medium text-brand-700"
              onClick={() => m.resumeChoice(task.id, true)}
            >
              {t.upload.resumeYes}
            </button>
            <button
              type="button"
              className="text-[var(--fg-muted)]"
              onClick={() => m.resumeChoice(task.id, false)}
            >
              {t.upload.resumeNo}
            </button>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {task.status === 'done' && (
          <CheckCircle2 className="h-5 w-5 text-green-600" aria-label={t.upload.done} />
        )}
        {task.status === 'error' && <XCircle className="h-5 w-5 text-red-600" aria-hidden="true" />}
        {running && (
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-[var(--bg-subtle)]"
            onClick={() => m.pause(task.id)}
            aria-label={t.upload.pause}
          >
            <Pause className="h-4 w-4" />
          </button>
        )}
        {task.status === 'paused' && (
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-[var(--bg-subtle)]"
            onClick={() => m.resume(task.id)}
            aria-label={t.upload.resume}
          >
            <Play className="h-4 w-4" />
          </button>
        )}
        {task.status === 'error' && task.errorCode !== 'QUOTA_FULL' && (
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-[var(--bg-subtle)]"
            onClick={() => m.resume(task.id)}
            aria-label={t.common.retry}
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
        {['queued', 'uploading', 'paused', 'error', 'resumable', 'conflict'].includes(
          task.status,
        ) && (
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-[var(--bg-subtle)]"
            onClick={() => m.cancel(task.id)}
            aria-label={t.upload.cancel}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function ConflictPrompt({ task }: { task: UploadTask }) {
  const m = uploads();
  const [all, setAll] = useState(false);
  const pick = (c: 'replace' | 'rename' | 'skip') => m.resolveConflict(task.id, c, all);
  return (
    <Dialog
      open
      title={t.upload.conflictTitle}
      onClose={() => pick('skip')}
      footer={
        <>
          <Button variant="ghost" onClick={() => pick('skip')}>
            {t.upload.conflictSkip}
          </Button>
          <Button variant="secondary" onClick={() => pick('rename')}>
            {t.upload.conflictKeepBoth}
          </Button>
          <Button onClick={() => pick('replace')}>{t.upload.conflictReplace}</Button>
        </>
      }
    >
      <p>{t.upload.conflictBody(task.name)}</p>
      <label className="mt-3 flex items-center gap-2">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        {t.upload.conflictApplyAll}
      </label>
    </Dialog>
  );
}

export function UploadPanel() {
  const tasks = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (!tasks.length) return null;
  const active = tasks.filter((x) =>
    ['queued', 'uploading', 'completing', 'paused', 'resumable', 'conflict'].includes(x.status),
  );
  const done = tasks.filter((x) => x.status === 'done').length;
  const conflict = tasks.find((x) => x.status === 'conflict');
  return (
    <>
      <section
        aria-label={t.a11y.upload}
        className="fixed right-2 bottom-20 z-40 w-[min(96vw,24rem)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-xl md:right-6 md:bottom-6"
      >
        <header className="flex items-center gap-2 bg-[var(--bg-subtle)] px-4 py-3">
          <h2 className="flex-1 text-sm font-medium">
            {active.length ? t.upload.panelTitle(active.length) : t.upload.allDone(done)}
          </h2>
          {!active.length && (
            <button
              type="button"
              className="text-xs text-brand-700"
              onClick={() => uploads().clearFinished()}
            >
              {t.upload.clearDone}
            </button>
          )}
          <button
            type="button"
            className="rounded-full p-1 hover:bg-[var(--border)]"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Buka panel' : 'Ciutkan panel'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </header>
        {!collapsed && (
          <ul className="max-h-72 divide-y divide-[var(--border)] overflow-auto">
            {tasks.map((task) => (
              <Row key={task.id} task={task} />
            ))}
          </ul>
        )}
      </section>
      {conflict && <ConflictPrompt key={conflict.id} task={conflict} />}
    </>
  );
}
