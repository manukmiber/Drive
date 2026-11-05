import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

// Zeiko buttons (ADR-101): 44px tall, 8px corners, 600 weight. Primary is ink (one per group of
// actions), secondary an outline, ghost only text until hovered, danger the error red.
const styles: Record<Variant, string> = {
  primary: 'z-primary',
  secondary:
    'border border-[var(--line-strong)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--hover)] active:bg-[var(--select)]',
  ghost: 'text-[var(--ink)] hover:bg-[var(--hover)] active:bg-[var(--select)]',
  danger: 'bg-red-600 text-white hover:bg-red-700 active:bg-red-700',
};

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-lg px-5 text-sm font-semibold whitespace-nowrap transition-colors disabled:opacity-50',
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}
