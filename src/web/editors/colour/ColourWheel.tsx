// A colour wheel (ADR-067): drag the dot towards a colour, further out is stronger; the slider
// under it makes that range lighter or darker. Double-tap resets it.
import { useRef, type PointerEvent } from 'react';
import { t } from '../../lib/i18n';
import type { Wheel } from '../photo/adjust';

export function ColourWheel({
  label,
  value,
  onChange,
  size = 92,
}: {
  label: string;
  value: Wheel;
  onChange: (w: Wheel) => void;
  size?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const r = size / 2;
  const a = (value.hue * Math.PI) / 180;
  const k = value.amount / 100;
  const set = (e: PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const dx = e.clientX - box.left - r;
    const dy = e.clientY - box.top - r;
    const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const amount = Math.min(100, (Math.hypot(dx, dy) / (r - 6)) * 100);
    onChange({ ...value, hue: Math.round(hue), amount: Math.round(amount < 3 ? 0 : amount) });
  };
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        ref={ref}
        role="slider"
        tabIndex={0}
        aria-label={t.editor.wheelLabel(label)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value.amount}
        aria-valuetext={`${value.hue}° ${value.amount}%`}
        className="relative shrink-0 cursor-crosshair touch-none rounded-full shadow-inner"
        style={{
          width: size,
          height: size,
          background:
            'radial-gradient(circle, rgb(140,140,140) 0%, rgba(140,140,140,0) 72%), conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          set(e);
        }}
        onPointerMove={(e) => e.buttons && set(e)}
        onDoubleClick={() => onChange({ hue: 0, amount: 0, lum: 0 })}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 2;
          if (e.key === 'ArrowLeft') onChange({ ...value, hue: (value.hue + 360 - step) % 360 });
          if (e.key === 'ArrowRight') onChange({ ...value, hue: (value.hue + step) % 360 });
          if (e.key === 'ArrowUp')
            onChange({ ...value, amount: Math.min(100, value.amount + step) });
          if (e.key === 'ArrowDown')
            onChange({ ...value, amount: Math.max(0, value.amount - step) });
        }}
      >
        <span className="pointer-events-none absolute inset-[45%] rounded-full bg-white/40" />
        <span
          className="pointer-events-none absolute h-3.5 w-3.5 rounded-full border-2 border-white bg-black/30 shadow"
          style={{
            left: r + Math.sin(a) * k * (r - 6) - 7,
            top: r - Math.cos(a) * k * (r - 6) - 7,
          }}
        />
      </div>
      <span className="text-xs font-medium">{label}</span>
      <input
        type="range"
        min={-100}
        max={100}
        value={value.lum}
        aria-label={`${label} · ${t.editor.wheelLum}`}
        onChange={(e) => onChange({ ...value, lum: Number(e.target.value) })}
        onDoubleClick={() => onChange({ ...value, lum: 0 })}
        className="h-5 accent-brand-600"
        style={{ width: size }}
      />
    </div>
  );
}
