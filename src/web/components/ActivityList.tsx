// D4 (ADR-083): who did what, newest first. Used by the Details panel and the Recent page.
import type { ActivityItem } from '../../shared/activity';
import { formatDateTime } from '../../shared/format';
import { t } from '../lib/i18n';
import { useMe } from '../lib/session';

export function ActivityList({ items, empty }: { items: ActivityItem[]; empty?: string }) {
  const me = useMe().data?.user.id;
  if (!items.length)
    return (
      <p className="py-6 text-center text-sm text-[var(--fg-muted)]">{empty ?? t.activity.empty}</p>
    );
  return (
    <ol className="divide-y divide-[var(--border)]">
      {items.map((e, i) => {
        const who = e.actorId === me ? t.activity.you : e.actorName || t.activity.member;
        return (
          <li key={`${e.at}-${e.nodeId}-${e.action}-${i}`} className="py-2.5">
            <p className="text-sm break-words">
              <span className="font-medium">{who}</span>{' '}
              {t.activity.did[e.action](e.name, e.from ?? '', e.to ?? '')}
            </p>
            <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
              {formatDateTime(e.at)}
              {e.space === 'family' && ` · ${t.activity.familyBadge}`}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
