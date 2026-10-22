import { useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useState } from 'react';
import { authClient } from '../lib/auth-client';
import { meQueryKey } from '../lib/session';
import { Button } from './Button';
import { t } from '../lib/i18n';

const input =
  'h-10 w-32 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-center tracking-[0.3em] outline-none focus:border-brand-500';

export function TotpSetup({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const [qr, setQr] = useState<string | null>(null);
  const [backup, setBackup] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function start() {
    setMsg(null);
    const res = await authClient.twoFactor.enable({});
    if (res.error || !res.data || res.data.method !== 'totp') {
      setMsg(t.settings.totpFailed);
      return;
    }
    setQr(
      await QRCode.toDataURL(res.data.totpURI, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 192,
      }),
    );
    setBackup(res.data.backupCodes);
  }

  async function verify() {
    const res = await authClient.twoFactor.verifyTotp({ code });
    if (res.error) {
      setMsg(t.settings.totpWrong);
      return;
    }
    setQr(null);
    setMsg(t.settings.totpOn);
    await qc.invalidateQueries({ queryKey: meQueryKey });
  }

  async function disable() {
    await authClient.twoFactor.disable({});
    await qc.invalidateQueries({ queryKey: meQueryKey });
  }

  if (enabled) {
    return (
      <div className="mt-4 flex items-center justify-between text-sm">
        <span>{t.settings.totpActive}</span>
        <Button variant="ghost" onClick={disable}>
          {t.settings.totpDisable}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 text-sm">
      {!qr ? (
        <Button variant="secondary" onClick={start}>
          {t.settings.totpEnable}
        </Button>
      ) : (
        <div className="space-y-3">
          <p>{t.settings.totpScan}</p>
          <img src={qr} alt="QR TOTP" className="h-48 w-48 rounded-lg bg-white p-2" />
          <details>
            <summary className="cursor-pointer text-brand-700">{t.settings.backupCodes}</summary>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">
              {backup.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </details>
          <div className="flex gap-2">
            <input
              className={input}
              inputMode="numeric"
              maxLength={6}
              aria-label={t.a11y.totpCode}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <Button onClick={verify} disabled={code.length !== 6}>
              {t.settings.verify}
            </Button>
          </div>
        </div>
      )}
      {msg && <p className="mt-2 text-[var(--fg-muted)]">{msg}</p>}
    </div>
  );
}
