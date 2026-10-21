import { Link } from '@tanstack/react-router';
import { t } from '../../shared/strings.id';

export function NotFound() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-5xl font-bold text-brand-700">404</p>
      <p className="text-[var(--fg-muted)]">{t.errors.notFound}</p>
      <Link to="/" className="text-brand-700 underline">
        {t.common.back}
      </Link>
    </div>
  );
}
