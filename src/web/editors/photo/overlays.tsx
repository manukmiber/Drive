// What the photo editor draws over the photo while a tool is open (ADR-050, ADR-052): the crop box,
// the straightening grid, the middle of the vignette and the lens blur, the healing taps and the
// texts. Positions come in CSS pixels of the shown photo.
import { useRef, type PointerEvent, type ReactNode } from 'react';
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

export interface TextBox {
  id: string;
  /** Middle and size, CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The texts' boxes: tap one to choose it, drag it to move it, tap elsewhere to choose none. */
export function TextLayer({
  boxes,
  chosen,
  onChoose,
  onDrag,
}: {
  boxes: TextBox[];
  chosen: string | null;
  onChoose: (id: string | null) => void;
  /** Where the middle of the text goes, CSS pixels. */
  onDrag: (id: string, x: number, y: number) => void;
}) {
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const point = (e: PointerEvent) => {
    const r = layer.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  return (
    <div
      ref={layer}
      className="absolute inset-0 touch-none"
      onPointerDown={() => onChoose(null)}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const [x, y] = point(e);
        onDrag(d.id, x - d.dx, y - d.dy);
      }}
      onPointerUp={() => (drag.current = null)}
    >
      {boxes.map((b) => (
        <div
          key={b.id}
          role="button"
          tabIndex={-1}
          aria-label={t.editor.textHint}
          className={cn(
            'absolute cursor-move rounded',
            chosen === b.id
              ? 'outline-2 outline-white outline-dashed [box-shadow:0_0_0_3px_rgba(0,0,0,0.35)]'
              : 'outline-1 outline-white/40 outline-dashed',
          )}
          style={{ left: b.x - b.w / 2, top: b.y - b.h / 2, width: b.w, height: b.h }}
          onPointerDown={(e) => {
            e.stopPropagation();
            layer.current!.setPointerCapture(e.pointerId);
            const [x, y] = point(e);
            drag.current = { id: b.id, dx: x - b.x, dy: y - b.y };
            onChoose(b.id);
          }}
        />
      ))}
    </div>
  );
}
