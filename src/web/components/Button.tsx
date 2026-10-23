import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const styles: Record<Variant, string> = {
  primary: 'z-primary disabled:opacity-60 disabled:filter-none',
  secondary:
    'border border-[var(--border-strong)] bg-[var(--card)] text-[var(--fg)] shadow-[var(--hl)] hover:bg-[var(--bg-subtle)] disabled:opacity-60',
  ghost: 'text-[var(--fg)] hover:bg-[var(--bg-subtle)]',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-60',
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
        'inline-flex h-10 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold whitespace-nowrap transition-colors active:scale-[0.98]',
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}
