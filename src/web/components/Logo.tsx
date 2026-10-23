import { useId } from 'react';
import { t } from '../lib/i18n';

export function Logo({
  className = '',
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  // One gradient per drawing: a gradient defined inside a hidden copy (the sidebar on a phone)
  // paints nothing, so the copies must not share it.
  const fill = `zk-logo-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <span className={`inline-flex items-center gap-2.5 font-semibold tracking-tight ${className}`}>
      <svg
        viewBox="0 0 64 64"
        className="h-8 w-8 shrink-0 drop-shadow-[0_6px_14px_rgba(79,70,229,0.35)]"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366f1" />
            <stop offset="1" stopColor="#3730a3" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill={`url(#${fill})`} />
        <rect
          x="1"
          y="1"
          width="62"
          height="62"
          rx="15"
          fill="none"
          stroke="#fff"
          strokeOpacity=".18"
        />
        <path d="M18 20h28v6L28 40h18v6H18v-6l18-14H18z" fill="#fff" />
      </svg>
      <span className={compact ? 'sr-only' : 'text-[17px]'}>{t.app.name}</span>
    </span>
  );
}
