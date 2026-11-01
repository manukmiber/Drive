// D6 (ADR-090): the search filters as controls, for people who don't know the syntax. Every change
// is written back into the search box's text (toQuery), so the box and the panel always agree.
import { SlidersHorizontal, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { DriveTypeFilter } from '../../shared/drive-tree';
import {
  datePeriod,
  highlightRanges,
  parseSearch,
  toQuery,
  type ParsedSearch,
} from '../../shared/search-query';
import { cn } from '../lib/cn';
import { t } from '../lib/i18n';
import { Button } from './Button';
import { Dialog } from './ui/Dialog';

const TYPES: DriveTypeFilter[] = [
  'folder',
  'image',
  'video',
  'audio',
  'document',
  'pdf',
  'archive',
];
const WIB = 7 * 3600_000;
const MB = 1024 * 1024;

/** The name with the query's words marked. */
export function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <mark key={i} className="rounded-sm bg-amber-200/70 text-inherit dark:bg-amber-500/30">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

export function highlightName(name: string, p: ParsedSearch): ReactNode {
  return <Highlighted text={name} ranges={highlightRanges(name, p)} />;
}

function day(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms + WIB).toISOString().slice(0, 10);
}

const input =
  'h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-sm outline-none focus:border-brand-500';

/** The filter button, with how many filters are on, and its sheet/dialog. */
export function SearchFilters({ q, onChange }: { q: string; onChange: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ParsedSearch>(() => parseSearch(q));
  const p = parseSearch(q);
  const count =
    p.types.length +
    p.exts.length +
    (p.after !== null || p.before !== null ? 1 : 0) +
    (p.minSize !== null || p.maxSize !== null ? 1 : 0) +
    (p.inFolder ? 1 : 0) +
    (p.space ? 1 : 0) +
    (p.starred ? 1 : 0) +
    (p.shared ? 1 : 0) +
    (p.match === 'word' ? 1 : 0);
  const set = (patch: Partial<ParsedSearch>) => setDraft((d) => ({ ...d, ...patch }));
  const apply = () => {
    onChange(toQuery(draft));
    setOpen(false);
  };
  const s = t.searchFilters;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setDraft(parseSearch(q));
          setOpen(true);
        }}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs',
          count
            ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-800/40 dark:text-brand-100'
            : 'border-[var(--border)] hover:bg-[var(--bg-subtle)]',
        )}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
        {count ? s.buttonCount(count) : s.button}
      </button>
      <Dialog
        open={open}
        title={s.title}
        onClose={() => setOpen(false)}
        footer={
          <div className="flex w-full justify-between gap-2">
            <Button
              variant="ghost"
              onClick={() =>
                setDraft({ ...parseSearch(''), groups: draft.groups, exclude: draft.exclude })
              }
            >
              <X className="h-4 w-4" aria-hidden="true" /> {s.clear}
            </Button>
            <Button onClick={apply}>{s.apply}</Button>
          </div>
        }
      >
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <fieldset>
            <legend className="text-sm font-medium">{s.type}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {TYPES.map((ty) => {
                const on = draft.types.includes(ty);
                return (
                  <button
                    key={ty}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        types: on ? draft.types.filter((x) => x !== ty) : [...draft.types, ty],
                      })
                    }
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs',
                      on
                        ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-800/40 dark:text-brand-100'
                        : 'border-[var(--border)]',
                    )}
                  >
                    {t.files.filterTypes[ty]}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="block text-sm">
            {s.ext}
            <input
              className={cn(input, 'mt-1')}
              value={draft.exts.join(' ')}
              placeholder="pdf docx"
              onChange={(e) =>
                set({
                  exts: e.target.value
                    .toLowerCase()
                    .split(/[\s,]+/)
                    .map((x) => x.replace(/^\./, ''))
                    .filter((x) => /^[a-z0-9]{1,10}$/.test(x)),
                })
              }
            />
          </label>
          <fieldset>
            <legend className="text-sm font-medium">{s.date}</legend>
            <select
              className={cn(input, 'mt-2')}
              value={draft.dateField}
              onChange={(e) => set({ dateField: e.target.value as ParsedSearch['dateField'] })}
            >
              <option value="modified">{s.dateModified}</option>
              <option value="created">{s.dateCreated}</option>
              <option value="taken">{s.dateTaken}</option>
            </select>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-[var(--fg-muted)]">
                {s.from}
                <input
                  type="date"
                  className={cn(input, 'mt-1')}
                  value={day(draft.after)}
                  onChange={(e) =>
                    set({
                      after: e.target.value ? (datePeriod(e.target.value)?.start ?? null) : null,
                    })
                  }
                />
              </label>
              <label className="text-xs text-[var(--fg-muted)]">
                {s.until}
                <input
                  type="date"
                  className={cn(input, 'mt-1')}
                  value={day(draft.before === null ? null : draft.before - 86_400_000)}
                  onChange={(e) =>
                    set({
                      before: e.target.value ? (datePeriod(e.target.value)?.end ?? null) : null,
                    })
                  }
                />
              </label>
            </div>
          </fieldset>
          <fieldset>
            <legend className="text-sm font-medium">{s.size}</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-xs text-[var(--fg-muted)]">
                {s.minMb}
                <input
                  type="number"
                  min={0}
                  inputMode="decimal"
                  className={cn(input, 'mt-1')}
                  value={draft.minSize === null ? '' : Math.round((draft.minSize / MB) * 10) / 10}
                  onChange={(e) =>
                    set({
                      minSize: e.target.value ? Math.round(Number(e.target.value) * MB) : null,
                    })
                  }
                />
              </label>
              <label className="text-xs text-[var(--fg-muted)]">
                {s.maxMb}
                <input
                  type="number"
                  min={0}
                  inputMode="decimal"
                  className={cn(input, 'mt-1')}
                  value={draft.maxSize === null ? '' : Math.round((draft.maxSize / MB) * 10) / 10}
                  onChange={(e) =>
                    set({
                      maxSize: e.target.value ? Math.round(Number(e.target.value) * MB) : null,
                    })
                  }
                />
              </label>
            </div>
          </fieldset>
          <label className="block text-sm">
            {s.inFolder}
            <input
              className={cn(input, 'mt-1')}
              value={draft.inFolder ?? ''}
              placeholder={s.inFolderHint}
              onChange={(e) => set({ inFolder: e.target.value.trim() || null })}
            />
          </label>
          <label className="block text-sm">
            {s.space}
            <select
              className={cn(input, 'mt-1')}
              value={draft.space ?? ''}
              onChange={(e) => set({ space: (e.target.value || null) as ParsedSearch['space'] })}
            >
              <option value="">{s.spaceAll}</option>
              <option value="personal">{s.spacePersonal}</option>
              <option value="family">{s.spaceFamily}</option>
            </select>
          </label>
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.starred}
                onChange={(e) => set({ starred: e.target.checked })}
              />
              {s.starred}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.shared}
                onChange={(e) => set({ shared: e.target.checked })}
              />
              {s.shared}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.match === 'word'}
                onChange={(e) => set({ match: e.target.checked ? 'word' : 'prefix' })}
              />
              {s.wholeWords}
            </label>
          </div>
          <label className="block text-sm">
            {s.sort}
            <select
              className={cn(input, 'mt-1')}
              value={draft.sort}
              onChange={(e) => set({ sort: e.target.value as ParsedSearch['sort'] })}
            >
              <option value="relevance">{s.sortRelevance}</option>
              <option value="date">{s.sortDate}</option>
            </select>
          </label>
          <p className="text-xs text-[var(--fg-muted)]">{s.syntaxHint}</p>
        </div>
      </Dialog>
    </>
  );
}
