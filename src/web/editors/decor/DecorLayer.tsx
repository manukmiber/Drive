// Moving text, stickers and shapes over a picture (ADR-067): tap to choose, drag to move, the round
// handle at the corner to resize and turn (it snaps to right angles), the ✕ to remove. Positions
// come in CSS pixels of the shown picture; the host turns them back into its own.
import { RotateCw, X } from 'lucide-react';
import { useRef, type PointerEvent } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import type { Box } from './draw';
import { snapAngle } from './items';

export interface LayerBox extends Box {
  id: string;
  /** The item's own size and turn, for the handle's maths. */
  size: number;
  rotation: number;
}

type Gesture =
  | { kind: 'move'; id: string; dx: number; dy: number }
  | {
      kind: 'turn';
      id: string;
      cx: number;
      cy: number;
      dist: number;
      angle: number;
      size: number;
      rotation: number;
    };

export function DecorLayer({
  boxes,
  chosen,
  onChoose,
  onMove,
  onTransform,
  onRemove,
  onEdit,
  passThrough = false,
}: {
  boxes: LayerBox[];
  chosen: string | null;
  onChoose: (id: string | null) => void;
  /** Where the middle goes, CSS pixels. */
  onMove: (id: string, x: number, y: number) => void;
  /** New size and turn from the handle. */
  onTransform: (id: string, size: number, rotation: number) => void;
  onRemove: (id: string) => void;
  /** A double tap on a text: edit its words. */
  onEdit?: (id: string) => void;
  /** Taps on empty space go to what is under the layer (the collage's photos). */
  passThrough?: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const g = useRef<Gesture | null>(null);
  const point = (e: PointerEvent) => {
    const r = layer.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  const move = (e: PointerEvent) => {
    const d = g.current;
    if (!d) return;
    const [x, y] = point(e);
    if (d.kind === 'move') onMove(d.id, x - d.dx, y - d.dy);
    else {
      const dist = Math.hypot(x - d.cx, y - d.cy);
      const angle = (Math.atan2(y - d.cy, x - d.cx) * 180) / Math.PI;
      onTransform(
        d.id,
        Math.max(0.01, Math.min(3, d.size * (dist / Math.max(1, d.dist)))),
        snapAngle(d.rotation + angle - d.angle),
      );
    }
  };
  return (
    <div
      ref={layer}
      className={cn('absolute inset-0 touch-none', passThrough && 'pointer-events-none')}
      onPointerDown={() => onChoose(null)}
      onPointerMove={move}
      onPointerUp={() => (g.current = null)}
      onPointerCancel={() => (g.current = null)}
    >
      {boxes.map((b) => {
        const on = chosen === b.id;
        return (
          <div
            key={b.id}
            className="pointer-events-auto absolute"
            style={{
              left: b.x - b.w / 2,
              top: b.y - b.h / 2,
              width: b.w,
              height: b.h,
              transform: `rotate(${b.angle}deg)`,
            }}
          >
            <div
              role="button"
              tabIndex={-1}
              aria-label={t.overlay.hint}
              className={cn(
                'absolute inset-0 cursor-move rounded',
                on
                  ? 'outline-2 outline-white outline-dashed [box-shadow:0_0_0_3px_rgba(0,0,0,0.35)]'
                  : 'outline-1 outline-white/40 outline-dashed',
              )}
              onPointerDown={(e) => {
                e.stopPropagation();
                layer.current!.setPointerCapture(e.pointerId);
                const [x, y] = point(e);
                g.current = { kind: 'move', id: b.id, dx: x - b.x, dy: y - b.y };
                onChoose(b.id);
              }}
              onDoubleClick={() => onEdit?.(b.id)}
            />
            {on && (
              <>
                <button
                  type="button"
                  aria-label={t.overlay.remove}
                  title={t.overlay.remove}
                  className="absolute -top-3.5 -left-3.5 flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-red-600 text-white shadow"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemove(b.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <span
                  role="presentation"
                  title={t.overlay.turnHint}
                  className="absolute -right-3.5 -bottom-3.5 flex h-7 w-7 cursor-nwse-resize touch-none items-center justify-center rounded-full border-2 border-white bg-brand-600 text-white shadow"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    layer.current!.setPointerCapture(e.pointerId);
                    const [x, y] = point(e);
                    g.current = {
                      kind: 'turn',
                      id: b.id,
                      cx: b.x,
                      cy: b.y,
                      dist: Math.hypot(x - b.x, y - b.y),
                      angle: (Math.atan2(y - b.y, x - b.x) * 180) / Math.PI,
                      size: b.size,
                      rotation: b.rotation,
                    };
                  }}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
