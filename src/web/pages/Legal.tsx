// Policy pages — drafts until reviewed by a lawyer (SPEC §14.5).
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { LEGAL } from '../../shared/legal.id';
import { Logo } from '../components/Logo';
import { NotFound } from './NotFound';

export function Legal({ slug }: { slug: string }) {
  const doc = LEGAL[slug];
  useEffect(() => {
    if (doc) document.title = `${doc.title} · Zeiko`;
  }, [doc]);
  if (!doc) return <NotFound />;
  return (
    <div className="mx-auto max-w-2xl p-4 md:p-8">
      <Link to="/">
        <Logo />
      </Link>
      <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
        DRAF, perlu review hukum
      </p>
      <h1 className="mt-4 text-2xl font-semibold">{doc.title}</h1>
      <p className="text-xs text-[var(--fg-muted)]">Terakhir diperbarui {doc.updated}</p>
      {doc.sections.map((s) => (
        <section key={s.h} className="mt-6">
          <h2 className="font-medium">{s.h}</h2>
          {s.p.map((p) => (
            <p key={p.slice(0, 40)} className="mt-2 text-sm leading-relaxed text-[var(--fg-muted)]">
              {p}
            </p>
          ))}
        </section>
      ))}
      <nav className="mt-10 flex flex-wrap gap-4 text-xs text-[var(--fg-muted)]">
        {Object.entries(LEGAL).map(([k, d]) => (
          <Link key={k} to="/kebijakan/$slug" params={{ slug: k }} className="hover:underline">
            {d.title}
          </Link>
        ))}
        <Link to="/lapor" className="hover:underline">
          Lapor penyalahgunaan
        </Link>
      </nav>
    </div>
  );
}
