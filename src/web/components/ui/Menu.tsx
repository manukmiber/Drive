import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { cn } from '../../lib/cn';

export interface MenuItem {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** Positioned popup menu (context menu / ⋮ menu) with keyboard navigation. */
export function Menu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [x, y]);

  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const buttons = [
        ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
      ];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-48 rounded-xl border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
          className={cn(
            'flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-[var(--bg-subtle)] focus:bg-[var(--bg-subtle)] focus:outline-none disabled:opacity-40',
            it.danger && 'text-red-600',
          )}
        >
          {it.icon && <it.icon className="h-4 w-4" />}
          {it.label}
        </button>
      ))}
    </div>
  );
}
