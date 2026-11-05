// The message box: Enter sends, Shift+Enter is a new line, `@` lists people to mention. The box
// shows `@Name`; what goes to the room is `<@id>` (lib/mentions.ts).
import { SendHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';
import { mentionQuery, toWire, type MentionPick } from '../../lib/mentions';
import { initial } from '../../lib/spaces';

export interface Person {
  id: string;
  name: string;
}

const MAX_SUGGESTIONS = 6;

export function Composer({
  placeholder,
  people,
  maxChars,
  disabled,
  initialText = '',
  initialPicks = [],
  editing = false,
  autoFocus = false,
  onSend,
  onTyping,
  onCancel,
}: {
  placeholder: string;
  /** Who can be mentioned (never the person themself). */
  people: Person[];
  maxChars: number;
  disabled?: boolean;
  initialText?: string;
  initialPicks?: MentionPick[];
  editing?: boolean;
  autoFocus?: boolean;
  onSend: (wire: string) => void;
  onTyping?: () => void;
  onCancel?: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [picks, setPicks] = useState<MentionPick[]>(initialPicks);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const suggestions = useMemo(() => {
    if (query === null) return [];
    const q = query.toLocaleLowerCase();
    return people.filter((p) => p.name.toLocaleLowerCase().includes(q)).slice(0, MAX_SUGGESTIONS);
  }, [people, query]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const wire = toWire(text.trim(), picks);
  const tooLong = wire.length > maxChars;

  function look(el: HTMLTextAreaElement) {
    const q = mentionQuery(el.value.slice(0, el.selectionStart));
    setQuery(q);
    setActive(0);
  }

  function pick(p: Person) {
    const el = box.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = el.value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0) return;
    const next = `${el.value.slice(0, at)}@${p.name} ${el.value.slice(caret)}`;
    setText(next);
    setPicks((list) => [...list.filter((x) => x.id !== p.id), { id: p.id, label: p.name }]);
    setQuery(null);
    const pos = at + p.name.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function submit() {
    if (disabled || !wire || tooLong) return;
    onSend(wire);
    if (!editing) {
      setText('');
      setPicks([]);
    }
    setQuery(null);
  }

  return (
    <div className="relative">
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label={t.spaces.chat.hint}
          className="absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg"
        >
          {suggestions.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm',
                  i === active && 'bg-[var(--bg-subtle)]',
                )}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800 dark:bg-brand-800/50">
                  {initial(p.name)}
                </span>
                <span className="truncate">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-2 transition-colors focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/15',
          disabled && 'opacity-60',
        )}
      >
        <textarea
          ref={box}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          enterKeyHint="send"
          className="z-inner-field max-h-[200px] min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-[var(--fg-muted)]"
          onChange={(e) => {
            setText(e.target.value);
            look(e.target);
            if (e.target.value.trim()) onTyping?.();
          }}
          onClick={(e) => look(e.currentTarget)}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setActive((i) => (i + step + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(suggestions[active]!);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setQuery(null);
                return;
              }
            }
            if (e.key === 'Escape' && onCancel) {
              e.preventDefault();
              onCancel();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)]"
            aria-label={t.common.cancel}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !wire || tooLong}
          className="z-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-xl disabled:opacity-40 disabled:filter-none"
          aria-label={editing ? t.common.save : t.spaces.chat.send}
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
      {tooLong && <p className="mt-1 px-2 text-xs text-red-600">{t.spaces.chat.errors.too_long}</p>}
    </div>
  );
}
