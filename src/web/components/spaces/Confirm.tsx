import { useState, type ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { Button } from '../Button';
import { Dialog } from '../ui/Dialog';

interface Ask {
  title: string;
  body: string;
  label?: string;
  run: () => unknown;
}

/** A yes/no question in the app's own dialog (not the browser's): `ask(...)`, and render `ui`. */
export function useConfirm(): [(a: Ask) => void, ReactNode] {
  const [q, setQ] = useState<Ask | null>(null);
  const ui = (
    <Dialog
      open={Boolean(q)}
      title={q?.title ?? ''}
      onClose={() => setQ(null)}
      footer={
        <>
          <Button variant="ghost" onClick={() => setQ(null)}>
            {t.common.cancel}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const run = q?.run;
              setQ(null);
              run?.();
            }}
          >
            {q?.label ?? t.common.ok}
          </Button>
        </>
      }
    >
      <p className="text-sm">{q?.body}</p>
    </Dialog>
  );
  return [setQ, ui];
}
