import { Fragment } from 'react';
import { parts } from '../../lib/mentions';
import { t } from '../../lib/i18n';

/** A message's text: line breaks kept, mentions as names, web links clickable. Never HTML. */
export function MessageText({
  text,
  nameOf,
  me,
}: {
  text: string;
  nameOf: (id: string) => string | null;
  me: string | null;
}) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {parts(text).map((p, i) => {
        if (p.kind === 'text') return <Fragment key={i}>{p.text}</Fragment>;
        if (p.kind === 'link')
          return (
            <a
              key={i}
              href={p.href}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
              className="text-brand-700 underline underline-offset-2 break-all"
            >
              {p.text}
            </a>
          );
        const self = p.id === me;
        return (
          <span
            key={i}
            className={
              self
                ? 'rounded bg-amber-400/20 px-1 font-medium text-amber-700 dark:text-amber-300'
                : 'rounded bg-[var(--accent-soft)] px-1 font-medium text-brand-700'
            }
          >
            @{nameOf(p.id) ?? t.spaces.someone}
          </span>
        );
      })}
    </p>
  );
}
