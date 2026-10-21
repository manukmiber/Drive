import { t } from '../../shared/strings.id';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight ${className}`}>
      <svg viewBox="0 0 64 64" className="h-7 w-7" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="#4338ca" />
        <path d="M18 20h28v6L28 40h18v6H18v-6l18-14H18z" fill="#fff" />
      </svg>
      <span className="text-lg">{t.app.name}</span>
    </span>
  );
}
