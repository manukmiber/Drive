// Making a signature (ADR-050): draw it, type it, or take a photo of it on paper.
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/ui/Dialog';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import {
  INK,
  fromCanvas,
  photoStamp,
  rememberSignature,
  textStamp,
  type Ink,
  type StampImage,
} from './stamps';

type Mode = 'draw' | 'type' | 'photo';

export function SignaturePad({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (s: StampImage) => void;
}) {
  const [mode, setMode] = useState<Mode>('draw');
  const [ink, setInk] = useState<Ink>('black');
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<StampImage | null>(null);
  const [remember, setRemember] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open || mode !== 'draw') return;
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * 2);
    c.height = Math.round(r.height * 2);
    setDrawn(false);
  }, [open, mode]);

  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * e.currentTarget.width,
      y: ((e.clientY - r.top) / r.height) * e.currentTarget.height,
    };
  };
  const stroke = (e: PointerEvent<HTMLCanvasElement>) => {
    const ctx = e.currentTarget.getContext('2d')!;
    const p = at(e);
    const from = last.current ?? p;
    ctx.strokeStyle = INK[ink];
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    setDrawn(true);
  };
  const clear = () => {
    const c = canvas.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };

  async function done() {
    let s: StampImage | null = null;
    if (mode === 'draw' && canvas.current) s = fromCanvas(canvas.current);
    if (mode === 'type' && name.trim()) s = textStamp(name.trim(), ink, true);
    if (mode === 'photo') s = photo;
    if (!s) return;
    if (remember) rememberSignature(s);
    onDone(s);
    clear();
    setName('');
    setPhoto(null);
  }

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={cn(
        'flex-1 rounded-lg px-3 py-1.5 text-xs font-medium',
        mode === m ? 'bg-[var(--card)] shadow-sm' : 'text-[var(--fg-muted)]',
      )}
    >
      {label}
    </button>
  );
  const ready =
    (mode === 'draw' && drawn) || (mode === 'type' && name.trim()) || (mode === 'photo' && photo);
  return (
    <Dialog
      open={open}
      title={t.editor.newSignature}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => void done()} disabled={!ready}>
            {t.editor.useSignature}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-1 rounded-xl bg-[var(--bg-subtle)] p-1">
          {tab('draw', t.editor.draw)}
          {tab('type', t.editor.typeIt)}
          {tab('photo', t.editor.photoIt)}
        </div>
        {mode === 'draw' && (
          <div>
            <canvas
              ref={canvas}
              className="h-40 w-full touch-none rounded-xl border border-dashed border-[var(--border-strong)] bg-white"
              aria-label={t.editor.drawHere}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                last.current = null;
                stroke(e);
              }}
              onPointerMove={(e) => e.buttons && stroke(e)}
              onPointerUp={() => (last.current = null)}
            />
            <div className="mt-1 flex justify-between text-xs text-[var(--fg-muted)]">
              <span>{t.editor.drawHere}</span>
              <button
                type="button"
                onClick={clear}
                className="text-[var(--accent)] hover:underline"
              >
                {t.editor.clear}
              </button>
            </div>
          </div>
        )}
        {mode === 'type' && (
          <div className="space-y-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.editor.typeName}
              aria-label={t.editor.typeName}
              maxLength={60}
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 outline-none focus:border-brand-500"
            />
            <p
              className="flex h-20 items-center justify-center overflow-hidden rounded-xl bg-white px-3 text-3xl italic"
              style={{
                color: INK[ink],
                fontFamily:
                  '"Segoe Script", "Brush Script MT", "Snell Roundhand", "URW Chancery L", cursive',
              }}
            >
              {name || ' '}
            </p>
          </div>
        )}
        {mode === 'photo' && (
          <div className="space-y-2">
            <input
              type="file"
              accept="image/*"
              aria-label={t.editor.photoIt}
              className="block w-full text-xs"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void photoStamp(f, ink).then(setPhoto, () => setPhoto(null));
              }}
            />
            <p className="text-xs text-[var(--fg-muted)]">{t.editor.photoHint}</p>
            {photo && (
              <div className="flex h-24 items-center justify-center rounded-xl bg-white p-2">
                <img src={photo.url} alt="" className="max-h-full max-w-full" />
              </div>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-2">
            {t.editor.ink}
            {(Object.keys(INK) as Ink[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setInk(k)}
                aria-pressed={ink === k}
                aria-label={t.editor.inks[k]}
                className={cn(
                  'h-6 w-6 rounded-full border-2',
                  ink === k ? 'border-brand-500' : 'border-transparent',
                )}
                style={{ backgroundColor: INK[k] }}
              />
            ))}
          </span>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t.editor.remember}
          </label>
        </div>
      </div>
    </Dialog>
  );
}
