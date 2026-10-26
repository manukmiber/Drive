// The curve tool's graph (ADR-052): the curve over the photo's brightness histogram. Tap to add a
// point, drag to move it, double-tap (or drag it off the graph) to remove it; the ends move up and
// down only.
import { useMemo, useRef, type PointerEvent } from 'react';
import { t } from '../../lib/i18n';
import { curveLut, type CurvePoint } from './adjust';

const INK: Record<string, string> = {
  rgb: 'var(--fg)',
  r: '#ef4444',
  g: '#22c55e',
  b: '#3b82f6',
};

export function CurveEditor({
  points,
  channel,
  histogram,
  onChange,
  onCommit,
}: {
  points: readonly CurvePoint[];
  channel: string;
  histogram: Uint32Array | null;
  onChange: (p: CurvePoint[]) => void;
  onCommit: (p: CurvePoint[]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number; list: CurvePoint[] } | null>(null);
  // The pointer is captured, so a double-tap is told by hand: the same point twice, quickly.
  const lastTap = useRef<{ x: number; time: number } | null>(null);
  const path = useMemo(() => {
    const lut = curveLut(points);
    let d = '';
    for (let v = 0; v < 256; v += 3)
      d += `${v ? 'L' : 'M'}${(v / 255) * 100},${100 - (lut[v]! / 255) * 100}`;
    return d + `L100,${100 - (lut[255]! / 255) * 100}`;
  }, [points]);
  const bars = useMemo(() => {
    if (!histogram) return '';
    const max = Math.max(1, ...histogram);
    let d = 'M0,100';
    for (let v = 0; v < 256; v += 2) d += `L${(v / 255) * 100},${100 - (histogram[v]! / max) * 95}`;
    return d + 'L100,100Z';
  }, [histogram]);

  const at = (e: PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height] as const;
  };

  function down(e: PointerEvent<SVGSVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    const r = svg.current!.getBoundingClientRect();
    // Within 18 screen pixels of a point picks it up; elsewhere a new point is put on the curve.
    const near = points.findIndex(
      ([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 18,
    );
    if (near >= 0) {
      const tap = lastTap.current;
      const p = points[near]!;
      if (tap && tap.x === p[0] && e.timeStamp - tap.time < 400) {
        lastTap.current = null;
        return remove(near);
      }
      lastTap.current = { x: p[0], time: e.timeStamp };
      drag.current = { index: near, list: [...points] };
      return;
    }
    if (x <= 0.02 || x >= 0.98) return;
    const list = [...points, [x, Math.max(0, Math.min(1, y))] as CurvePoint].sort(
      (a, b) => a[0] - b[0],
    );
    drag.current = { index: list.findIndex((p) => p[0] === x), list };
    onChange(list);
  }

  function move(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const [x, y] = at(e);
    const last = d.list.length - 1;
    const list = [...d.list];
    const lo = d.index === 0 ? 0 : list[d.index - 1]![0] + 0.02;
    const hi = d.index === last ? 1 : list[d.index + 1]![0] - 0.02;
    const nx = d.index === 0 ? 0 : d.index === last ? 1 : Math.max(lo, Math.min(hi, x));
    list[d.index] = [nx, Math.max(0, Math.min(1, y))];
    d.list = list;
    // Dragged well off the graph: it goes (not the ends).
    const off = d.index > 0 && d.index < last && (y < -0.12 || y > 1.12);
    onChange(off ? list.filter((_, i) => i !== d.index) : list);
  }

  function up(e: PointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const [, y] = at(e);
    const last = d.list.length - 1;
    const off = d.index > 0 && d.index < last && (y < -0.12 || y > 1.12);
    onCommit(off ? d.list.filter((_, i) => i !== d.index) : d.list);
  }

  function remove(i: number) {
    if (i === 0 || i === points.length - 1) return;
    onCommit(points.filter((_, j) => j !== i));
  }

  return (
    <svg
      ref={svg}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="block aspect-square w-40 shrink-0 touch-none rounded-lg border border-[var(--border)] bg-[var(--bg)] sm:w-52"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      role="img"
      aria-label={t.editor.toolNames.curves}
    >
      {bars && <path d={bars} fill="var(--fg-muted)" opacity={0.18} />}
      {[25, 50, 75].map((g) => (
        <g key={g} stroke="var(--border)" strokeWidth={0.5} vectorEffect="non-scaling-stroke">
          <line x1={g} y1={0} x2={g} y2={100} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={g} x2={100} y2={g} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      <line
        x1={0}
        y1={100}
        x2={100}
        y2={0}
        stroke="var(--fg-muted)"
        strokeDasharray="2 2"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        opacity={0.5}
      />
      <path
        d={path}
        fill="none"
        stroke={INK[channel] ?? INK.rgb}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      {points.map(([x, y], i) => (
        <ellipse
          key={i}
          cx={x * 100}
          cy={100 - y * 100}
          rx={2.6}
          ry={2.6}
          fill="var(--card)"
          stroke={INK[channel] ?? INK.rgb}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}
