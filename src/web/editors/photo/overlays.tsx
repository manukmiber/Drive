// What the photo editor draws over the photo while a tool is open (ADR-050, ADR-052, ADR-067): the
// crop box, the straightening grid, the middle of the vignette and the lens blur, the healing taps,
// drawing, and the covered boxes (text and stickers use decor/DecorLayer). Positions come in CSS
// pixels of the shown photo.
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import type { LensBlur, Vignette } from './effects';
import { clampRect, dragCorner, type Corner, type Rect } from './geometry';

/** The crop rectangle over the photo: drag inside to move it, drag a corner to resize it. */
export function CropBox({
  rect,
  ratio,
  pw,
  ph,
  onChange,
}: {
  rect: Rect;
  ratio: number | null;
  pw: number;
  ph: number;
  onChange: (r: Rect) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | Corner; x: number; y: number; start: Rect } | null>(null);

  function grab(e: PointerEvent, mode: 'move' | Corner) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: rect };
  }
  const move = (e: PointerEvent) => {
    const d = drag.current;
    const box = ref.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.x) / box.width;
    const dy = (e.clientY - d.y) / box.height;
    onChange(
      d.mode === 'move'
        ? clampRect({ ...d.start, x: d.start.x + dx, y: d.start.y + dy })
        : dragCorner(d.start, d.mode, dx, dy, ratio, pw, ph),
    );
  };
  const corners: Corner[] = ['nw', 'ne', 'sw', 'se'];
  return (
    <div
      ref={ref}
      className="absolute inset-0 touch-none overflow-hidden"
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
    >
      <div
        className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
        }}
        onPointerDown={(e) => grab(e, 'move')}
      >
        <Thirds />
        {corners.map((c) => (
          <span
            key={c}
            role="presentation"
            onPointerDown={(e) => grab(e, c)}
            className={cn(
              // Inside the corners: the stage clips anything outside the photo.
              'absolute h-6 w-6 touch-none rounded-full border-2 border-white bg-brand-600 shadow',
              c === 'nw' && 'top-0.5 left-0.5 cursor-nwse-resize',
              c === 'ne' && 'top-0.5 right-0.5 cursor-nesw-resize',
              c === 'sw' && 'bottom-0.5 left-0.5 cursor-nesw-resize',
              c === 'se' && 'right-0.5 bottom-0.5 cursor-nwse-resize',
            )}
          />
        ))}
      </div>
    </div>
  );
}

function Thirds({ n = 3 }: { n?: number }) {
  return (
    <div
      className="pointer-events-none absolute inset-0 grid"
      style={{
        gridTemplateColumns: `repeat(${n}, 1fr)`,
        gridTemplateRows: `repeat(${n}, 1fr)`,
      }}
    >
      {Array.from({ length: n * n }, (_, i) => (
        <div key={i} className="border border-white/25" />
      ))}
    </div>
  );
}

/** A fine grid for straightening. */
export function StraightenGrid() {
  return <Thirds n={6} />;
}

/** An area over the photo where dragging moves a point (fractions of the shown photo). */
function DragArea({
  onMove,
  children,
}: {
  onMove: (u: number, v: number) => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const on = useRef(false);
  const at = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    onMove(
      Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    );
  };
  return (
    <div
      ref={box}
      className="absolute inset-0 touch-none overflow-hidden"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        on.current = true;
        at(e);
      }}
      onPointerMove={(e) => on.current && at(e)}
      onPointerUp={() => (on.current = false)}
    >
      {children}
    </div>
  );
}

const RING =
  'pointer-events-none absolute rounded-full border-2 border-dashed border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.3)]';

/** The vignette's untouched middle; drag anywhere to move it. */
export function VignetteGuide({
  v,
  w,
  h,
  onMove,
}: {
  v: Vignette;
  w: number;
  h: number;
  onMove: (x: number, y: number) => void;
}) {
  const r = (0.15 + (v.size / 100) * 0.7) * (Math.hypot(w, h) / 2);
  return (
    <DragArea onMove={onMove}>
      <span
        className={RING}
        style={{ left: v.x * w - r, top: v.y * h - r, width: r * 2, height: r * 2 }}
      />
      <Handle x={v.x * w} y={v.y * h} />
    </DragArea>
  );
}

/** The lens blur's sharp part (inner line) and where it is fully blurred (outer line). */
export function LensGuide({
  lens,
  w,
  h,
  onMove,
}: {
  lens: LensBlur;
  w: number;
  h: number;
  onMove: (x: number, y: number) => void;
}) {
  const short = Math.min(w, h);
  const inner = ((0.05 + (lens.size / 100) * 0.6) / 2) * short;
  const outer = inner + (0.02 + (lens.fade / 100) * 0.6) * short;
  const cx = lens.x * w;
  const cy = lens.y * h;
  return (
    <DragArea onMove={onMove}>
      {lens.shape === 'radial'
        ? [inner, outer].map((r, i) => (
            <span
              key={i}
              className={cn(RING, i && 'opacity-50')}
              style={{ left: cx - r, top: cy - r, width: r * 2, height: r * 2 }}
            />
          ))
        : [inner, outer].map((r, i) => (
            <span
              key={i}
              className={cn(
                'pointer-events-none absolute border-y-2 border-dashed border-white/80',
                i && 'opacity-50',
              )}
              style={{
                left: cx - w * 1.5,
                top: cy - r,
                width: w * 3,
                height: r * 2,
                transform: `rotate(${lens.angle}deg)`,
              }}
            />
          ))}
      <Handle x={cx} y={cy} />
    </DragArea>
  );
}

function Handle({ x, y }: { x: number; y: number }) {
  return (
    <span
      className="pointer-events-none absolute h-7 w-7 rounded-full border-2 border-white bg-brand-600/80 shadow"
      style={{ left: x - 14, top: y - 14 }}
    />
  );
}

/** Taps for the healing tool; the spots healed so far are ringed. */
export function HealLayer({
  spots,
  onTap,
}: {
  /** In CSS pixels. */
  spots: Array<{ x: number; y: number; r: number }>;
  onTap: (x: number, y: number) => void;
}) {
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none overflow-hidden"
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onTap(e.clientX - r.left, e.clientY - r.top);
      }}
      aria-label={t.editor.healHint}
    >
      {spots.map((s, i) => (
        <span
          key={i}
          className="pointer-events-none absolute rounded-full border border-white/70"
          style={{ left: s.x - s.r, top: s.y - s.r, width: s.r * 2, height: s.r * 2 }}
        />
      ))}
    </div>
  );
}

/**
 * Drawing (ADR-067): a finger or the mouse draws a line, shown here while it is drawn and handed
 * over (CSS pixels) when it ends; the canvas draws the ones already made.
 */
export function DrawLayer({
  color,
  width,
  neon,
  onStroke,
}: {
  color: string;
  /** CSS pixels. */
  width: number;
  neon: boolean;
  onStroke: (points: number[]) => void;
}) {
  const [points, setPoints] = useState<number[] | null>(null);
  const at = (e: PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const path = points
    ? points.reduce(
        (d, v, i) => (i % 2 ? `${d},${v.toFixed(1)}` : `${d}${i ? ' L' : 'M'}${v.toFixed(1)}`),
        '',
      )
    : '';
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none overflow-hidden"
      aria-label={t.editor.drawHint}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setPoints(at(e));
      }}
      onPointerMove={(e) => {
        if (!points) return;
        const [x, y] = at(e) as [number, number];
        const lx = points[points.length - 2]!;
        const ly = points[points.length - 1]!;
        if (Math.hypot(x - lx, y - ly) >= 2) setPoints([...points, x, y]);
      }}
      onPointerUp={() => {
        if (points) onStroke(points);
        setPoints(null);
      }}
      onPointerCancel={() => setPoints(null)}
    >
      {points && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <path
            d={path}
            fill="none"
            stroke={neon ? '#ffffff' : color}
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={neon ? { filter: `drop-shadow(0 0 ${width}px ${color})` } : undefined}
          />
        </svg>
      )}
    </div>
  );
}

/** Covering parts of the photo (ADR-067): drag a box; the ones made are outlined. */
export function RedactLayer({
  boxes,
  onBox,
}: {
  /** CSS pixels. */
  boxes: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  onBox: (x0: number, y0: number, x1: number, y1: number) => void;
}) {
  const [drag, setDrag] = useState<[number, number, number, number] | null>(null);
  const at = (e: PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const rect = (b: { x: number; y: number; w: number; h: number }, key: string, live = false) => (
    <span
      key={key}
      className={cn(
        'pointer-events-none absolute border-2',
        live ? 'border-white bg-white/20' : 'border-dashed border-white/80',
      )}
      style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
    />
  );
  return (
    <div
      className="absolute inset-0 cursor-crosshair touch-none overflow-hidden"
      aria-label={t.editor.redactHint}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const [x, y] = at(e);
        setDrag([x, y, x, y]);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const [x, y] = at(e);
        setDrag([drag[0], drag[1], x, y]);
      }}
      onPointerUp={() => {
        if (drag && Math.abs(drag[2] - drag[0]) > 6 && Math.abs(drag[3] - drag[1]) > 6)
          onBox(...drag);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {boxes.map((b) => rect(b, b.id))}
      {drag &&
        rect(
          {
            x: Math.min(drag[0], drag[2]),
            y: Math.min(drag[1], drag[3]),
            w: Math.abs(drag[2] - drag[0]),
            h: Math.abs(drag[3] - drag[1]),
          },
          'live',
          true,
        )}
    </div>
  );
}
