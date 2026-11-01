// Settings → WebDAV (D9, ADR-089): the address, user name and password to type into FolderSync,
// rclone, Windows, macOS or the iOS Files app. Shown only where Drive answers WebDAV (ADR-049).
import { Check, Copy, HardDrive } from 'lucide-react';
import { useState } from 'react';
import { formatBytes } from '../../shared/format';
import { useCatalog } from '../lib/catalog';
import { t } from '../lib/i18n';
import { useMe } from '../lib/session';

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-2">
      <p className="text-xs text-[var(--fg-muted)]">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-[var(--bg-subtle)] px-3 py-2 font-mono text-sm">
          {value}
        </code>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1 rounded-lg px-3 text-sm text-brand-700 hover:bg-[var(--bg-subtle)] dark:text-brand-300"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            });
          }}
        >
          {done ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
          {done ? t.webdav.copied : t.webdav.copy}
        </button>
      </div>
    </div>
  );
}

function Steps({
  title,
  steps,
  code,
}: {
  title: string;
  steps: readonly string[];
  code?: string[];
}) {
  return (
    <details className="group rounded-xl border border-[var(--border)] px-4 py-2">
      <summary className="cursor-pointer select-none py-1 text-sm font-medium">{title}</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pb-2 pl-5 text-sm text-[var(--fg-muted)]">
        {steps.map((s, i) => (
          <li key={i}>
            {s}
            {code?.[i] && (
              <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--bg-subtle)] p-2 font-mono text-xs text-[var(--fg)]">
                {code[i]}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function WebDavSetup() {
  const catalog = useCatalog();
  const me = useMe();
  const url = catalog.data?.capabilities?.webdavUrl;
  if (!url || !me.data) return null;
  const address = `${url.replace(/\/+$/, '')}/`;
  const email = me.data.user.email;
  const max = catalog.data?.config.webdav_put_max_bytes;
  const remote = `rclone config create zeiko webdav url=${address} vendor=owncloud user=${email} pass=$(rclone obscure TOKEN)`;
  const copy = 'rclone copy ~/Pictures "zeiko:Drive Saya/Foto" --progress';
  return (
    <section className="z-card rounded-2xl p-5" aria-labelledby="webdav">
      <h2 id="webdav" className="flex items-center gap-2 font-medium">
        <HardDrive className="h-4 w-4" aria-hidden="true" /> {t.webdav.title}
      </h2>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.webdav.intro}</p>
      <CopyRow label={t.webdav.address} value={address} />
      <CopyRow label={t.webdav.user} value={email} />
      <p className="mt-2 text-xs text-[var(--fg-muted)]">{t.webdav.password}</p>
      <p className="mt-1 text-sm">{t.webdav.passwordHint}</p>
      <p className="mt-3 text-xs text-[var(--fg-muted)]">{t.webdav.folders}</p>
      {max ? (
        <p className="mt-1 text-xs text-[var(--fg-muted)]">{t.webdav.limit(formatBytes(max))}</p>
      ) : null}
      <h3 className="mt-4 text-sm font-medium">{t.webdav.howTo}</h3>
      <div className="mt-2 space-y-2">
        <Steps title={t.webdav.foldersync} steps={t.webdav.foldersyncSteps} />
        <Steps title={t.webdav.rclone} steps={t.webdav.rcloneSteps} code={[remote, copy]} />
        <Steps title={t.webdav.windows} steps={t.webdav.windowsSteps} />
        <Steps title={t.webdav.mac} steps={t.webdav.macSteps} />
        <Steps title={t.webdav.ios} steps={t.webdav.iosSteps} />
      </div>
    </section>
  );
}
