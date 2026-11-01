// D6 (ADR-090): "search file contents". Off unless the person turns it on (the owner's choice), so
// it is introduced once, the first time they search, and switched in Settings.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSearch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { contentIndexFull, reindexMissing, rememberContentSearch } from '../lib/content-index';
import { driveSettings, setContentSearch } from '../lib/files';
import { t } from '../lib/i18n';
import { Button } from './Button';
import { Dialog } from './ui/Dialog';
import { toast } from './ui/Toast';

const INTRO_SEEN = 'zk_content_search_intro';

function useTurnOn() {
  const qc = useQueryClient();
  return async (on: boolean) => {
    const r = await setContentSearch(on);
    rememberContentSearch(r.contentSearch);
    qc.setQueryData(['drive-settings'], r);
    await qc.invalidateQueries({ queryKey: ['search'] });
    toast(on ? t.contentSearch.turnedOn : t.contentSearch.turnedOff);
  };
}

/** The one-time introduction, shown on a search while the switch is off. */
export function ContentSearchIntro({ off }: { off: boolean }) {
  const [seen, setSeen] = useState(() => Boolean(localStorage.getItem(INTRO_SEEN)));
  const turn = useTurnOn();
  const close = () => {
    localStorage.setItem(INTRO_SEEN, '1');
    setSeen(true);
  };
  return (
    <Dialog
      open={off && !seen}
      title={t.contentSearch.popupTitle}
      onClose={close}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            {t.contentSearch.popupNo}
          </Button>
          <Button
            onClick={() => {
              close();
              void turn(true)
                .then(() => reindexMissing(() => undefined))
                .catch(() => toast(t.errors.generic, { tone: 'error' }));
            }}
          >
            {t.contentSearch.popupYes}
          </Button>
        </div>
      }
    >
      <p className="text-sm text-[var(--fg-muted)]">{t.contentSearch.popupBody}</p>
    </Dialog>
  );
}

/** Settings → Search file contents: the switch and "Index again". */
export function ContentSearchSettings() {
  const q = useQuery({ queryKey: ['drive-settings'], queryFn: driveSettings });
  const turn = useTurnOn();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  const on = q.data?.contentSearch ?? false;

  async function reindex() {
    stop.current = new AbortController();
    setProgress({ done: 0, total: 0 });
    try {
      const n = await reindexMissing(
        (done, total) => setProgress({ done, total }),
        stop.current.signal,
      );
      toast(t.contentSearch.reindexDone(n));
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    } finally {
      setProgress(null);
    }
  }

  return (
    <section className="z-card rounded-2xl p-5" aria-labelledby="cari-isi">
      <div className="flex items-start justify-between gap-3">
        <h2 id="cari-isi" className="flex items-center gap-2 font-medium">
          <FileSearch className="h-4 w-4" aria-hidden="true" /> {t.contentSearch.title}
        </h2>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="cari-isi"
          disabled={!q.data || busy}
          onClick={() => {
            setBusy(true);
            void turn(!on)
              .catch(() => toast(t.errors.generic, { tone: 'error' }))
              .finally(() => setBusy(false));
          }}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${on ? 'bg-brand-600' : 'bg-[var(--border-strong)]'}`}
        >
          <span
            className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-[left] ${on ? 'left-[1.375rem]' : 'left-0.5'}`}
          />
          <span className="sr-only">{on ? t.contentSearch.on : t.contentSearch.off}</span>
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.contentSearch.intro}</p>
      {on && (
        <div className="mt-3">
          <p className="text-xs text-[var(--fg-muted)]">{t.contentSearch.reindexHint}</p>
          <Button
            variant="ghost"
            className="mt-2"
            disabled={progress !== null}
            onClick={() => void reindex()}
          >
            {progress
              ? t.contentSearch.reindexing(progress.done, progress.total)
              : t.contentSearch.reindex}
          </Button>
          {contentIndexFull() && (
            <p className="mt-2 text-xs text-amber-700">{t.contentSearch.full}</p>
          )}
        </div>
      )}
    </section>
  );
}
