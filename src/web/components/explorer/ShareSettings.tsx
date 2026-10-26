// One link's settings (SPEC §6.1, ADR-054): title, expiry, download limit, password (set or
// remove), "show the files first" for folders and bundles, a new link, revoke. Used by the share
// dialog and by Dibagikan.
import { useState } from 'react';
import { t } from '../../lib/i18n';
import { regenerateShare, revokeShare, updateShare, type ShareDto } from '../../lib/files';
import { Button } from '../Button';
import { toast } from '../ui/Toast';
import { errorText } from './useNodeActions';

export const EXPIRY = [1, 24, 168, 720, 0];

/** The expiry choice closest to what the link was given. */
export function expiryChoice(s: ShareDto): number {
  if (!s.expiresAt) return 0;
  const h = Math.round((s.expiresAt - s.createdAt) / 3600_000);
  return EXPIRY.reduce((best, x) => (x && Math.abs(x - h) < Math.abs(best - h) ? x : best), 720);
}

const field =
  'mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--fg)]';

export function ShareSettings({
  share,
  onChange,
  onRevoked,
}: {
  share: ShareDto;
  onChange: (s: ShareDto) => void;
  onRevoked: () => void;
}) {
  const [title, setTitle] = useState(share.title);
  const [expiry, setExpiry] = useState(() => expiryChoice(share));
  const [maxDl, setMaxDl] = useState(share.maxDownloads ? String(share.maxDownloads) : '');
  const [password, setPassword] = useState('');
  const [listing, setListing] = useState(share.showListing);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<{ share: ShareDto }>, done: string) {
    setBusy(true);
    try {
      const { share: s } = await fn();
      onChange(s);
      toast(done);
      return s;
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
      return null;
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(
      () =>
        updateShare(share.id, {
          title: title.trim() || share.title,
          expiresInHours: expiry || null,
          maxDownloads: maxDl ? Number(maxDl) : null,
          ...(password ? { password } : {}),
          ...(share.kind !== 'file' ? { showListing: listing } : {}),
        }),
      t.share.saved,
    ).then((s) => s && setPassword(''));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[var(--fg-muted)] sm:col-span-2">
          {t.share.titleLabel}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className={field}
          />
        </label>
        <label className="text-xs text-[var(--fg-muted)]">
          {t.share.expiry}
          <select
            value={expiry}
            onChange={(e) => setExpiry(Number(e.target.value))}
            className={`${field} px-2`}
          >
            {EXPIRY.map((h) => (
              <option key={h} value={h}>
                {t.share.expiryOptions[h]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-[var(--fg-muted)]">
          {t.share.maxDownloads}
          <input
            value={maxDl}
            onChange={(e) => setMaxDl(e.target.value.replace(/\D/g, '').slice(0, 7))}
            inputMode="numeric"
            className={field}
          />
        </label>
        <label className="text-xs text-[var(--fg-muted)] sm:col-span-2">
          {share.hasPassword ? t.share.newPassword : t.share.password}
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            minLength={4}
            maxLength={128}
            className={field}
          />
        </label>
        {share.hasPassword && (
          <p className="flex items-center justify-between gap-2 text-xs sm:col-span-2">
            <span className="text-[var(--fg-muted)]">🔒 {t.share.passwordProtected}</span>
            <button
              type="button"
              disabled={busy}
              className="font-medium text-red-600"
              onClick={() =>
                void run(() => updateShare(share.id, { password: null }), t.share.passwordRemoved)
              }
            >
              {t.share.removePassword}
            </button>
          </p>
        )}
        {share.kind !== 'file' && (
          <label className="flex items-start gap-3 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={listing}
              onChange={(e) => setListing(e.target.checked)}
            />
            <span>
              {t.share.showListing}
              <span className="block text-xs text-[var(--fg-muted)]">
                {t.share.showListingHint}
              </span>
            </span>
          </label>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy || (password.length > 0 && password.length < 4)}
          onClick={() => void save()}
        >
          {t.share.save}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void run(() => regenerateShare(share.id), t.share.regenerated)}
        >
          {t.share.regenerate}
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            try {
              await revokeShare(share.id);
              toast(t.share.revoked);
              onRevoked();
            } catch (e) {
              toast(errorText(e), { tone: 'error' });
            }
          }}
        >
          {t.share.revoke}
        </Button>
      </div>
    </div>
  );
}
