// Policy pages (SPEC §14.5, ADR-045): Terms of Service, Privacy Policy and Ad Policy, in the UI's
// language. Marked as drafts until a lawyer has reviewed them.
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { formatDate } from '../../shared/format';
import { LEGAL, legalEntry, type LegalSlug } from '../legal';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { lang, t } from '../lib/i18n';
import { NotFound } from './NotFound';

export function Legal({ slug }: { slug: string }) {
  const entry = legalEntry(slug);
  const doc = entry?.[lang];
  useEffect(() => {
    if (doc) document.title = `${doc.title} · Zeiko`;
  }, [doc]);
  useEffect(() => {
    // Section links (#…) once the text is on the page.
    if (doc && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [doc]);
  if (!entry || !doc) return <NotFound />;
  return (
    <div className="mx-auto max-w-3xl p-4 pb-16 md:p-8">
      <Link to="/">
        <Logo />
      </Link>
      <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
        {t.legal.draft}
      </p>
      <h1 className="mt-4 text-2xl font-semibold">{doc.title}</h1>
      <p className="mt-1 text-xs text-[var(--fg-muted)]">
        {t.legal.effective(formatDate(Date.parse(`${entry.effective}T00:00:00+07:00`)))}
      </p>
      {t.legal.translationNote && (
        <p className="mt-2 text-xs text-[var(--fg-muted)]">{t.legal.translationNote}</p>
      )}
      <div className="mt-4">
        <Markdown source={doc.body} />
      </div>
      <nav
        aria-label={t.legal.navLabel}
        className="mt-12 flex flex-wrap gap-4 border-t border-[var(--border)] pt-4 text-xs text-[var(--fg-muted)]"
      >
        {(Object.keys(LEGAL) as LegalSlug[]).map((k) => (
          <Link key={k} to="/kebijakan/$slug" params={{ slug: k }} className="hover:underline">
            {LEGAL[k][lang].title}
          </Link>
        ))}
        <Link to="/lapor" className="hover:underline">
          {t.legal.report}
        </Link>
      </nav>
    </div>
  );
}
