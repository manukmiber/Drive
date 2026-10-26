// Global transfer panel, bottom-right (Google Drive style, SPEC §5.2): uploads and, since ADR-053,
// the download queue, with overall progress, pause/resume/cancel for everything, and the
// "how many at once" settings one tap away.
import { Link } from '@tanstack/react-router';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  MoreVertical,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  WifiOff,
  X,
  XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { formatBytes } from '../../shared/format';
import { downloads, useDownloads } from '../download/useDownloads';
import type { DownloadTask } from '../download/manager';
import { t } from '../lib/i18n';
import { cn } from '../lib/cn';
import { uploads, useUploads } from '../upload/useUploads';
import type { UploadTask } from '../upload/manager';
import { Button } from './Button';
import { FileIcon } from './FileIcon';
import { TransferSettingsForm } from './TransferSettings';
import { Dialog } from './ui/Dialog';
import { Menu } from './ui/Menu';

function duration(s: number): string {
  if (s < 60) return t.transfer.sec(s);
  if (s < 3600) return t.transfer.min(Math.round(s / 60));
  return t.transfer.hour(Math.floor(s / 3600), Math.round((s % 3600) / 60));
}

function eta(left: number, speed: number): string | null {
  if (speed <= 0 || left <= 0) return null;
  return duration(Math.round(left / speed));
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="rounded-full p-1.5 hover:bg-[var(--bg-subtle)]"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--border)]">
      <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

function UploadRow({ task }: { task: UploadTask }) {
  const m = uploads();
  const pct = task.size ? Math.round((task.loaded / task.size) * 100) : 100;
  const running = task.status === 'uploading' || task.status === 'offline';
  let sub: string;
  switch (task.status) {
    case 'uploading': {
      const e = eta(task.size - task.loaded, task.speed);
      sub = `${formatBytes(task.loaded)} / ${formatBytes(task.size)} · ${t.upload.speed(formatBytes(task.speed))}${e ? ` · ${t.upload.eta(e)}` : ''}`;
      break;
    }
    case 'offline':
      sub = `${t.upload.offline} · ${pct}%`;
      break;
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
        {(running || task.status === 'paused') && <Bar pct={pct} />}
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
        {task.status === 'offline' && (
          <WifiOff className="h-4 w-4 text-[var(--fg-muted)]" aria-hidden="true" />
        )}
        {task.status === 'error' && <XCircle className="h-5 w-5 text-red-600" aria-hidden="true" />}
        {running && (
          <IconButton label={t.upload.pause} onClick={() => m.pause(task.id)}>
            <Pause className="h-4 w-4" />
          </IconButton>
        )}
        {task.status === 'paused' && (
          <IconButton label={t.upload.resume} onClick={() => m.resume(task.id)}>
            <Play className="h-4 w-4" />
          </IconButton>
        )}
        {task.status === 'error' && task.errorCode !== 'QUOTA_FULL' && (
          <IconButton label={t.common.retry} onClick={() => m.resume(task.id)}>
            <RotateCcw className="h-4 w-4" />
          </IconButton>
        )}
        {['queued', 'uploading', 'offline', 'paused', 'error', 'resumable', 'conflict'].includes(
          task.status,
        ) && (
          <IconButton label={t.upload.cancel} onClick={() => m.cancel(task.id)}>
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </div>
    </li>
  );
}

function DownloadRow({ task }: { task: DownloadTask }) {
  const m = downloads();
  const pct = task.size ? Math.round((task.loaded / task.size) * 100) : 100;
  const running = task.status === 'downloading' || task.status === 'offline';
  let sub: string;
  switch (task.status) {
    case 'downloading': {
      const e = eta(task.size - task.loaded, task.speed);
      sub = `${formatBytes(task.loaded)} / ${formatBytes(task.size)} · ${t.upload.speed(formatBytes(task.speed))}${e ? ` · ${t.upload.eta(e)}` : ''}`;
      break;
    }
    case 'offline':
      sub = `${t.transfer.offline} · ${pct}%`;
      break;
    case 'queued':
      sub = t.upload.queued;
      break;
    case 'paused':
      sub = `${t.upload.paused} · ${pct}%`;
      break;
    case 'saving':
      sub = t.transfer.saving;
      break;
    case 'done':
      sub =
        task.target === 'folder'
          ? t.transfer.savedToFolder
          : task.target === 'device'
            ? t.transfer.savedToDevice
            : t.transfer.handedToBrowser;
      break;
    case 'error':
      sub = `${t.transfer.failed}: ${(task.errorCode && t.transfer.errorText[task.errorCode]) ?? task.error ?? ''}`;
      break;
    case 'canceled':
      sub = t.upload.canceled;
      break;
  }
  const folder = task.path.includes('/') ? task.path.slice(0, task.path.lastIndexOf('/')) : null;
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <FileIcon node={{ kind: 'file', mime: null, name: task.name }} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={task.path}>
          {task.name}
          {folder && <span className="ml-1 text-xs text-[var(--fg-muted)]">· {folder}</span>}
        </p>
        <p
          className={`truncate text-xs ${task.status === 'error' ? 'text-red-600' : 'text-[var(--fg-muted)]'}`}
        >
          {sub}
        </p>
        {(running || task.status === 'paused') && <Bar pct={pct} />}
      </div>
      <div className="flex shrink-0 items-center">
        {task.status === 'done' && (
          <CheckCircle2 className="h-5 w-5 text-green-600" aria-label={sub} />
        )}
        {task.status === 'offline' && (
          <WifiOff className="h-4 w-4 text-[var(--fg-muted)]" aria-hidden="true" />
        )}
        {task.status === 'error' && <XCircle className="h-5 w-5 text-red-600" aria-hidden="true" />}
        {(running || task.status === 'queued') && (
          <IconButton label={t.upload.pause} onClick={() => m.pause(task.id)}>
            <Pause className="h-4 w-4" />
          </IconButton>
        )}
        {task.status === 'paused' && (
          <IconButton label={t.upload.resume} onClick={() => m.resume(task.id)}>
            <Play className="h-4 w-4" />
          </IconButton>
        )}
        {task.status === 'error' && (
          <IconButton label={t.common.retry} onClick={() => m.resume(task.id)}>
            <RotateCcw className="h-4 w-4" />
          </IconButton>
        )}
        {['queued', 'downloading', 'offline', 'paused', 'error'].includes(task.status) && (
          <IconButton label={t.upload.cancel} onClick={() => m.cancel(task.id)}>
            <X className="h-4 w-4" />
          </IconButton>
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

export function TransferSettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      title={t.transfer.settingsTitle}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t.common.close}</Button>}
    >
      <p className="mb-4 text-[var(--fg-muted)]">{t.transfer.settingsBody}</p>
      <TransferSettingsForm />
    </Dialog>
  );
}

const UP_ACTIVE = [
  'queued',
  'uploading',
  'offline',
  'completing',
  'paused',
  'resumable',
  'conflict',
];
const DOWN_ACTIVE = ['queued', 'downloading', 'offline', 'saving', 'paused'];

/** Bytes done, bytes in all, summed speed: for the header's overall bar. */
function totals(
  items: ReadonlyArray<{ status: string; loaded: number; size: number; speed: number }>,
) {
  let loaded = 0;
  let size = 0;
  let speed = 0;
  for (const i of items) {
    if (i.status === 'canceled' || i.status === 'skipped') continue;
    loaded += Math.min(i.loaded, i.size);
    size += i.size;
    speed += i.speed;
  }
  return { loaded, size, speed, pct: size ? Math.round((loaded / size) * 100) : 100 };
}

export function UploadPanel() {
  const ups = useUploads();
  const downs = useDownloads();
  const [collapsed, setCollapsed] = useState(false);
  const [tabPick, setTab] = useState<'up' | 'down' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [settings, setSettings] = useState(false);
  if (!ups.length && !downs.length)
    return settings ? <TransferSettingsDialog onClose={() => setSettings(false)} /> : null;

  const upActive = ups.filter((x) => UP_ACTIVE.includes(x.status));
  const downActive = downs.filter((x) => DOWN_ACTIVE.includes(x.status));
  // The tab the person picked, else whichever has work going on.
  const tab: 'up' | 'down' =
    tabPick === 'up' && ups.length
      ? 'up'
      : tabPick === 'down' && downs.length
        ? 'down'
        : !ups.length || (downActive.length && !upActive.length)
          ? 'down'
          : 'up';
  const list = tab === 'up' ? ups : downs;
  const active = tab === 'up' ? upActive : downActive;
  const done = list.filter((x) => x.status === 'done').length;
  const sum = totals(list);
  const conflict = ups.find((x) => x.status === 'conflict');
  const running = active.some((x) => !['paused', 'resumable', 'conflict'].includes(x.status));
  const queue = tab === 'up' ? uploads() : downloads();
  const title = active.length
    ? tab === 'up'
      ? t.upload.panelTitle(active.length)
      : t.transfer.downloadingTitle(active.length)
    : tab === 'up'
      ? t.upload.allDone(done)
      : t.transfer.downloadsDone(done);

  return (
    <>
      <section
        aria-label={t.a11y.upload}
        className="fixed right-2 bottom-20 z-40 w-[min(96vw,24rem)] overflow-hidden z-card rounded-2xl shadow-xl md:right-6 md:bottom-6"
      >
        <header className="bg-[var(--bg-subtle)] px-4 pt-3 pb-2">
          <div className="flex items-center gap-1">
            <h2 className="flex-1 truncate text-sm font-medium">{title}</h2>
            {!active.length && (
              <button
                type="button"
                className="px-1 text-xs text-brand-700"
                onClick={() => queue.clearFinished()}
              >
                {t.upload.clearDone}
              </button>
            )}
            <button
              type="button"
              className="rounded-full p-1 hover:bg-[var(--border)]"
              aria-label={t.transfer.actions}
              title={t.transfer.actions}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left - 160, y: r.bottom + 4 });
              }}
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded-full p-1 hover:bg-[var(--border)]"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? t.transfer.expand : t.transfer.collapse}
              aria-expanded={!collapsed}
            >
              {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>
          {active.length > 0 && (
            <>
              <p className="mt-1 text-xs tabular-nums text-[var(--fg-muted)]">
                {t.transfer.total(formatBytes(sum.loaded), formatBytes(sum.size))}
                {sum.speed > 0 && ` · ${t.upload.speed(formatBytes(sum.speed))}`}
                {(() => {
                  const e = eta(sum.size - sum.loaded, sum.speed);
                  return e ? ` · ${t.upload.eta(e)}` : '';
                })()}
              </p>
              <Bar pct={sum.pct} />
            </>
          )}
          {ups.length > 0 && downs.length > 0 && (
            <div role="tablist" className="mt-2 flex gap-1">
              {(['up', 'down'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  onClick={() => setTab(k)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs',
                    tab === k ? 'bg-brand-600 text-white' : 'hover:bg-[var(--border)]',
                  )}
                >
                  {k === 'up'
                    ? t.transfer.tabUpload(upActive.length || ups.length)
                    : t.transfer.tabDownload(downActive.length || downs.length)}
                </button>
              ))}
            </div>
          )}
        </header>
        {!collapsed && (
          <ul className="max-h-72 divide-y divide-[var(--border)] overflow-auto">
            {tab === 'up'
              ? ups.map((task) => <UploadRow key={task.id} task={task} />)
              : downs.map((task) => <DownloadRow key={task.id} task={task} />)}
          </ul>
        )}
      </section>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t.transfer.pauseAll,
              icon: Pause,
              disabled: !running,
              onSelect: () => queue.pauseAll(),
            },
            {
              label: t.transfer.resumeAll,
              icon: Play,
              disabled: !list.some((x) => x.status === 'paused' || x.status === 'error'),
              onSelect: () => queue.resumeAll(),
            },
            {
              label: t.transfer.cancelAll,
              icon: X,
              danger: true,
              disabled: !active.length && !list.some((x) => x.status === 'error'),
              onSelect: () => queue.cancelAll(),
            },
            { label: t.transfer.settings, icon: Settings2, onSelect: () => setSettings(true) },
          ]}
        />
      )}
      {settings && <TransferSettingsDialog onClose={() => setSettings(false)} />}
      {conflict && <ConflictPrompt key={conflict.id} task={conflict} />}
    </>
  );
}
