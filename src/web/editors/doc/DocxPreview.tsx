// A .docx in the preview (ADR-051): docx-preview draws its pages, which are cleaned before they are
// shown (no scripts, frames, forms or code links; the CSP refuses inline scripts as well).
import { renderAsync } from 'docx-preview';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { cleanInPlace } from '../sanitize';

export function DocxPreview({ url, onFail }: { url: string; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      const res = await fetch(url, { signal: ac.signal, credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Drawn away from the page first, so nothing of the file is live before it is cleaned.
      const box = document.createElement('div');
      await renderAsync(blob, box, box, {
        className: 'docx',
        inWrapper: true,
        ignoreFonts: true,
        useBase64URL: true,
        renderAltChunks: false,
        renderComments: false,
        renderChanges: false,
        experimental: false,
      });
      cleanInPlace(box);
      if (ac.signal.aborted || !host.current) return;
      host.current.replaceChildren(...box.childNodes);
      setReady(true);
    })().catch(() => {
      if (!ac.signal.aborted) onFail();
    });
    return () => ac.abort();
  }, [url, onFail]);

  // Pages are drawn at their paper size; on a phone they are made to fit the width.
  useEffect(() => {
    const el = host.current;
    if (!ready || !el) return;
    const fit = () => {
      const wrapper = el.querySelector<HTMLElement>('.docx-wrapper');
      const page = el.querySelector<HTMLElement>('section.docx');
      if (!wrapper || !page) return;
      wrapper.style.background = 'transparent';
      wrapper.style.zoom = '';
      const room = el.clientWidth - 16;
      const zoom = Math.min(1, room / (page.offsetWidth + 60));
      wrapper.style.zoom = String(zoom);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  return (
    <div className="h-full w-full max-w-5xl overflow-auto rounded-lg bg-neutral-800 text-left text-black">
      {!ready && <p className="p-6 text-center text-sm text-white/70">{t.common.loading}</p>}
      <div ref={host} />
    </div>
  );
}
