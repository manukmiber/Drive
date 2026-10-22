// "Bagikan" (SPEC §6): one click makes a link and copies it; settings and send options below.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Mail, MessageCircle, QrCode, Send, Share2 } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { formatDateTime } from '../../../shared/format';
import { t } from '../../lib/i18n';
import {
  createShare,
  emailShare,
  listShares,
  logShareSend,
  regenerateShare,
  revokeShare,
  updateShare,
  type NodeDto,
  type ShareDto,
} from '../../lib/files';
import { Button } from '../Button';
import { Turnstile, useTurnstileSiteKey } from '../Turnstile';
import { Dialog } from '../ui/Dialog';
import { toast } from '../ui/Toast';
import { errorText } from './useNodeActions';

const EXPIRY = [1, 24, 168, 720, 0];

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function hoursLeft(s: ShareDto): number {
  if (!s.expiresAt) return 0;
  const h = Math.round((s.expiresAt - s.createdAt) / 3600_000);
  return EXPIRY.reduce((best, x) => (x && Math.abs(x - h) < Math.abs(best - h) ? x : best), 720);
}

export function ShareDialog({ nodes, onClose }: { nodes: NodeDto[]; onClose: () => void }) {
  const qc = useQueryClient();
  const single = nodes.length === 1 ? nodes[0]! : null;
  const title = single ? single.name : `${nodes.length} item`;
  const existing = useQuery({
    queryKey: ['shares', single?.id],
    queryFn: () => listShares(single!.id),
    enabled: Boolean(single),
  });
  const [own, setShare] = useState<ShareDto | null>(null);
  const [openedAt] = useState(() => Date.now());
  const active =
    existing.data?.items.find(
      (s) => !s.revokedAt && !s.disabledReason && (!s.expiresAt || s.expiresAt > openedAt),
    ) ?? null;
  const share = own ?? active;
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'email' | 'qr' | 'settings'>('none');
  const [emails, setEmails] = useState('');
  const [captcha, setCaptcha] = useState<string | null>(null);
  const needsCaptcha = Boolean(useTurnstileSiteKey());
  const [message, setMessage] = useState('');
  const [expiryInput, setExpiry] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [maxDlInput, setMaxDl] = useState<string | null>(null);
  const expiry = expiryInput ?? (share ? hoursLeft(share) : 720);
  const maxDl = maxDlInput ?? (share?.maxDownloads ? String(share.maxDownloads) : '');
  const started = useRef(false);

  const create = useMutation({
    mutationFn: () => createShare({ nodeIds: nodes.map((n) => n.id) }),
    onSuccess: async ({ share: s }) => {
      setShare(s);
      if (await copy(s.url)) {
        setCopied(true);
        toast(t.share.linkCopied);
      }
      void qc.invalidateQueries({ queryKey: ['shares'] });
    },
    onError: (e) => toast(errorText(e), { tone: 'error' }),
  });

  // Reuse an active link for single items; otherwise create one right away.
  useEffect(() => {
    if (started.current) return;
    if (single && existing.isPending) return;
    started.current = true;
    if (!active) create.mutate();
  }, [single, existing.isPending, active, create]);

  useEffect(() => {
    if (panel === 'qr' && share)
      void QRCode.toDataURL(share.url, { margin: 1, width: 240 }).then(setQr);
  }, [panel, share]);

  const save = async () => {
    if (!share) return;
    try {
      const { share: s } = await updateShare(share.id, {
        expiresInHours: expiry || null,
        maxDownloads: maxDl ? Number(maxDl) : null,
        ...(password ? { password } : {}),
      });
      setShare(s);
      setPassword('');
      toast(t.share.saved);
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  };

  const send = async (channel: 'whatsapp' | 'telegram' | 'webshare') => {
    if (!share) return;
    const text = t.share.shareMessage(share.title, share.url);
    void logShareSend(share.id, channel).catch(() => undefined);
    if (channel === 'whatsapp')
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    else if (channel === 'telegram')
      window.open(
        `https://t.me/share/url?url=${encodeURIComponent(share.url)}&text=${encodeURIComponent(`"${share.title}" lewat Zeiko`)}`,
        '_blank',
        'noopener',
      );
    else if (navigator.share)
      await navigator.share({ title: share.title, text, url: share.url }).catch(() => undefined);
  };

  const sendEmail = async () => {
    if (!share) return;
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    try {
      const r = await emailShare(share.id, list, message || null, captcha);
      toast(t.share.emailSent(r.queued));
      setEmails('');
      setMessage('');
      setPanel('none');
    } catch (e) {
      toast(errorText(e), { tone: 'error' });
    }
  };

  const chip = (label: string, icon: typeof Mail, onClick: () => void, active = false) => {
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-xs hover:bg-[var(--bg-subtle)] ${active ? 'bg-[var(--bg-subtle)]' : ''}`}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-700 dark:bg-brand-800/40 dark:text-brand-100">
          <Icon className="h-5 w-5" />
        </span>
        {label}
      </button>
    );
  };

  return (
    <Dialog open title={t.share.dialogTitle(title)} onClose={onClose}>
      {!share ? (
        <p className="py-6 text-center text-sm text-[var(--fg-muted)]">{t.share.creating}</p>
      ) : (
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
            <Link2 className="h-4 w-4 shrink-0" /> {t.share.anyoneWithLink}
          </p>
          <div className="flex gap-2">
            <input
              readOnly
              value={share.url}
              onFocus={(e) => e.currentTarget.select()}
              className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--bg-subtle)] px-3 text-sm"
              aria-label={t.a11y.link}
            />
            <Button
              onClick={async () => {
                if (await copy(share.url)) {
                  setCopied(true);
                  toast(t.share.linkCopied);
                }
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{' '}
              {t.share.copyLink}
            </Button>
          </div>
          <p className="text-xs text-[var(--fg-muted)]">
            {share.expiresAt
              ? t.share.expiresOn(formatDateTime(share.expiresAt))
              : t.share.noExpiry}{' '}
            · {t.share.downloads(share.downloadCount)}
            {share.hasPassword && ' · 🔒'}
          </p>

          <div>
            <p className="mb-1 text-xs font-medium text-[var(--fg-muted)]">{t.share.sendVia}</p>
            <div className="grid grid-cols-5 gap-1">
              {chip(t.share.whatsapp, MessageCircle, () => void send('whatsapp'))}
              {chip(t.share.telegram, Send, () => void send('telegram'))}
              {chip(
                t.share.email,
                Mail,
                () => setPanel(panel === 'email' ? 'none' : 'email'),
                panel === 'email',
              )}
              {chip(
                t.share.qr,
                QrCode,
                () => setPanel(panel === 'qr' ? 'none' : 'qr'),
                panel === 'qr',
              )}
              {chip(t.share.more, Share2, () => void send('webshare'))}
            </div>
          </div>

          {panel === 'email' && (
            <div className="space-y-2">
              <input
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder={t.share.emailTo}
                type="text"
                inputMode="email"
                className="h-11 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm"
              />
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t.share.message}
                maxLength={500}
                rows={3}
                className="w-full rounded-xl border border-[var(--border)] bg-transparent p-3 text-sm"
              />
              <Turnstile onToken={setCaptcha} />
              <Button
                onClick={() => void sendEmail()}
                disabled={!emails.trim() || (needsCaptcha && !captcha)}
              >
                {t.share.send}
              </Button>
            </div>
          )}
          {panel === 'qr' && (
            <div className="flex justify-center">
              {qr && (
                <img src={qr} alt={t.share.qr} className="h-60 w-60 rounded-xl bg-white p-2" />
              )}
            </div>
          )}

          <details
            className="rounded-xl border border-[var(--border)] p-3"
            open={panel === 'settings'}
          >
            <summary className="cursor-pointer text-sm font-medium">{t.share.linkSettings}</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-[var(--fg-muted)]">
                {t.share.expiry}
                <select
                  value={expiry}
                  onChange={(e) => setExpiry(Number(e.target.value))}
                  className="mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-transparent px-2 text-sm text-[var(--fg)]"
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
                  onChange={(e) => setMaxDl(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  className="mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--fg)]"
                />
              </label>
              <label className="text-xs text-[var(--fg-muted)] sm:col-span-2">
                {t.share.password}
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="new-password"
                  minLength={4}
                  className="mt-1 h-10 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm text-[var(--fg)]"
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void save()}>
                {t.share.save}
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  const { share: s } = await regenerateShare(share.id);
                  setShare(s);
                  toast(t.share.regenerated);
                }}
              >
                {t.share.regenerate}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  await revokeShare(share.id);
                  toast(t.share.revoked);
                  void qc.invalidateQueries({ queryKey: ['shares'] });
                  onClose();
                }}
              >
                {t.share.revoke}
              </Button>
            </div>
          </details>
        </div>
      )}
    </Dialog>
  );
}
