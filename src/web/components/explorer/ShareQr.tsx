// QR for a share link (SPEC §6.2): error correction H with the Zeiko mark in the middle (ADR-059),
// download as PNG or SVG, copy the image, and a full-screen view so another phone can scan it
// easily. Drawn in the browser from the same plan as the SVG.
import { Copy, Download, Maximize2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { qrSvg } from '../../../shared/qr';
import { qrCanvas } from '../../lib/qr';
import { t } from '../../lib/i18n';
import { Button } from '../Button';
import { toast } from '../ui/Toast';

const PNG_WIDTH = 720;

function save(href: string, name: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "QR Laporan Q3" → a name every system accepts. */
const fileBase = (title: string) => `QR ${title}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

export function ShareQr({ url, title }: { url: string; title: string }) {
  const [big, setBig] = useState(false);
  const canvas = useMemo(() => qrCanvas(url, PNG_WIDTH), [url]);
  const src = useMemo(() => canvas.toDataURL('image/png'), [canvas]);
  const pngBlob = () => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));

  const downloadPng = async () => {
    const b = await pngBlob();
    if (!b) return;
    const href = URL.createObjectURL(b);
    save(href, `${fileBase(title)}.png`);
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  };
  const downloadSvg = () => {
    const svg = qrSvg(url);
    const href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    save(href, `${fileBase(title)}.svg`);
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  };
  const copyImage = async () => {
    const b = await pngBlob();
    try {
      if (!b) throw new Error('no image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
      toast(t.share.qrCopied);
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    }
  };
  const canCopy = typeof ClipboardItem !== 'undefined' && Boolean(navigator.clipboard?.write);

  return (
    <div className="space-y-3">
      <div className="flex justify-center">
        <img src={src} alt={t.share.qr} className="h-60 w-60 rounded-xl bg-white p-2" />
      </div>
      <p className="text-center text-xs text-[var(--fg-muted)]">{t.share.qrHint}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="secondary" onClick={() => void downloadPng()}>
          <Download className="h-4 w-4" /> {t.share.qrDownloadPng}
        </Button>
        <Button variant="secondary" onClick={downloadSvg}>
          <Download className="h-4 w-4" /> {t.share.qrDownloadSvg}
        </Button>
        {canCopy && (
          <Button variant="ghost" onClick={() => void copyImage()}>
            <Copy className="h-4 w-4" /> {t.share.qrCopy}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setBig(true)}>
          <Maximize2 className="h-4 w-4" /> {t.share.qrFullscreen}
        </Button>
      </div>
      {big && <FullScreen src={src} title={title} onClose={() => setBig(false)} />}
    </div>
  );
}

/**
 * Its own modal <dialog>: the share dialog is already in the top layer, and only another modal
 * dialog opened after it can sit above it (a fixed overlay inside it could not).
 */
function FullScreen({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={t.share.qr}
      onClose={onClose}
      onClick={onClose}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-white p-6 backdrop:bg-white"
    >
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <img src={src} alt={t.share.qr} className="aspect-square w-[min(90vw,75dvh)]" />
        <p className="max-w-md text-center text-base font-medium text-gray-900">{title}</p>
      </div>
      <button
        type="button"
        autoFocus
        className="absolute top-4 right-4 rounded-full p-2 text-gray-900 hover:bg-gray-100"
        aria-label={t.common.close}
        onClick={onClose}
      >
        <X className="h-6 w-6" />
      </button>
    </dialog>
  );
}
