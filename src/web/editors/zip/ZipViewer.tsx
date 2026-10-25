// ZIP viewer (ADR-051): the archive's folders and files, opened in the browser. One file can be
// downloaded; the chosen files (or all of them) are unpacked into a new folder named after the ZIP,
// next to it in Drive, through the normal upload queue with their folders kept.
import { ArrowUp, Download, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../../../shared/format';
import { Button } from '../../components/Button';
import { FileIcon } from '../../components/FileIcon';
import { toast } from '../../components/ui/Toast';
import { createFolder } from '../../lib/files';
import { t } from '../../lib/i18n';
import { resolveTargets, type PickedFile } from '../../upload/folders';
import { uploads } from '../../upload/useUploads';
import { downloadBlob, saveFolder, type EditRequest, type Source } from '../files';
import { Busy, EditorFrame, Failed, useConfig, useSources } from '../ui';
import { contents, filesUnder, keyOf } from './tree';
import { isJunk, listZip, readEntry, type ZipEntry } from './zip';

export function ZipViewer({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, 'zip');
  const source = sources?.[0] ?? null;
  const [zip, setZip] = useState<{ bytes: Uint8Array; entries: ZipEntry[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    source.blob
      .arrayBuffer()
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        const entries = listZip(bytes).filter((e) => !e.dir && e.path.length && !isJunk(e.path));
        if (alive) setZip({ bytes, entries });
      })
      .catch(() => alive && setLoadError(t.editor.zipNotZip));
    return () => {
      alive = false;
    };
  }, [source]);

  const title = source?.name ?? t.editor.zip;
  if (error || loadError)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Failed message={(error ?? loadError)!} onClose={onClose} />
      </EditorFrame>
    );
  if (!source || !zip)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Busy label={t.editor.loadingFile(Math.round(progress * 100))} progress={progress} />
      </EditorFrame>
    );
  return <Archive source={source} {...zip} onClose={onClose} />;
}

function Archive({
  source,
  bytes,
  entries,
  onClose,
}: {
  source: Source;
  bytes: Uint8Array;
  entries: ZipEntry[];
  onClose: () => void;
}) {
  const config = useConfig();
  const [cwd, setCwd] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const here = useMemo(() => contents(entries, cwd), [entries, cwd]);
  const total = useMemo(() => entries.reduce((n, e) => n + e.size, 0), [entries]);
  const base = source.name.replace(/\.zip$/i, '') || t.editor.zip;

  // What is unpacked: the ticked files and everything in the ticked folders, or all of it.
  // Password-protected files can't be, and are counted as skipped.
  const { chosen, locked } = useMemo(() => {
    const all = picked.size
      ? [...new Set([...picked].flatMap((k) => filesUnder(entries, k.split('/'))))]
      : entries;
    const chosen = all.filter((e) => !e.encrypted);
    return { chosen, locked: all.length - chosen.length };
  }, [entries, picked]);

  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const keysHere = [
    ...here.folders.map((f) => keyOf([...cwd, f.name])),
    ...here.files.filter((e) => !e.encrypted).map((e) => keyOf(e.path)),
  ];
  const allHere = keysHere.length > 0 && keysHere.every((k) => picked.has(k));
  // Inside a ticked folder everything is ticked with it.
  const coveredHere = cwd.some((_, i) => picked.has(keyOf(cwd.slice(0, i + 1))));

  async function download(e: ZipEntry) {
    try {
      const data = await readEntry(bytes, e);
      downloadBlob(new Blob([data as Uint8Array<ArrayBuffer>]), e.path[e.path.length - 1]!);
    } catch {
      toast(t.editor.zipSkipped(1), { tone: 'error' });
    }
  }

  async function extract() {
    const max = config?.editor_zip_extract_max_bytes ?? 0;
    if (!chosen.length) return toast(t.editor.zipNothing, { tone: 'error' });
    if (max && chosen.reduce((n, e) => n + e.size, 0) > max)
      return toast(t.editor.zipTooMuch(formatBytes(max)), { tone: 'error' });
    setBusy({ done: 0, total: chosen.length });
    try {
      const files: PickedFile[] = [];
      let skipped = locked;
      for (const [i, e] of chosen.entries()) {
        try {
          const data = await readEntry(bytes, e);
          const name = e.path[e.path.length - 1]!;
          files.push({
            file: new File([data as Uint8Array<ArrayBuffer>], name, { lastModified: Date.now() }),
            dirs: e.path.slice(0, -1),
          });
        } catch {
          skipped++;
        }
        setBusy({ done: i + 1, total: chosen.length });
      }
      if (!files.length) return toast(t.editor.zipNothing, { tone: 'error' });
      const { parentId } = await saveFolder(source);
      const { node: folder } = await createFolder(parentId, base, 'rename');
      const targets = await resolveTargets(folder.id, files);
      void uploads().add(
        targets.map((x) => ({ file: x.file, parentId: x.parentId, onConflict: 'rename' as const })),
      );
      toast(t.editor.zipQueued(files.length, folder.name));
      if (skipped) toast(t.editor.zipSkipped(skipped), { tone: 'error' });
      setPicked(new Set());
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <EditorFrame
      title={source.name}
      onClose={onClose}
      actions={
        <Button onClick={() => void extract()} disabled={!!busy} className="h-9 px-4">
          {picked.size ? t.editor.zipExtractSome(chosen.length) : t.editor.zipExtractAll}
        </Button>
      }
    >
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2 text-sm">
          {cwd.length > 0 && (
            <button
              type="button"
              onClick={() => setCwd(cwd.slice(0, -1))}
              className="rounded-full p-1.5 hover:bg-[var(--bg-subtle)]"
              aria-label={t.editor.zipUp}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
          <nav className="min-w-0 flex-1 truncate" aria-label={t.a11y.location}>
            <button type="button" className="hover:underline" onClick={() => setCwd([])}>
              {base}
            </button>
            {cwd.map((seg, i) => (
              <span key={i}>
                {' / '}
                <button
                  type="button"
                  className="hover:underline"
                  onClick={() => setCwd(cwd.slice(0, i + 1))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </nav>
          <span className="shrink-0 text-xs text-[var(--fg-muted)]">
            {t.editor.zipSummary(entries.length, formatBytes(total))}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!entries.length ? (
          <p className="p-6 text-center text-sm text-[var(--fg-muted)]">{t.editor.zipEmpty}</p>
        ) : (
          <ul className="mx-auto max-w-3xl divide-y divide-[var(--border)]">
            <li className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm text-[var(--fg-muted)]">
              <input
                type="checkbox"
                checked={coveredHere || allHere}
                disabled={coveredHere}
                aria-label={t.editor.zipSelectAll}
                onChange={() =>
                  setPicked((p) => {
                    const n = new Set(p);
                    for (const k of keysHere) {
                      if (allHere) n.delete(k);
                      else n.add(k);
                    }
                    return n;
                  })
                }
              />
              {t.editor.zipSelectAll}
            </li>
            {here.folders.map((f) => {
              const key = keyOf([...cwd, f.name]);
              return (
                <li key={key} className="flex min-h-12 items-center gap-3 px-3 py-1">
                  <input
                    type="checkbox"
                    checked={coveredHere || picked.has(key)}
                    disabled={coveredHere}
                    aria-label={t.editor.zipSelect(f.name)}
                    onChange={() => toggle(key)}
                  />
                  <button
                    type="button"
                    onClick={() => setCwd([...cwd, f.name])}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <FileIcon node={{ kind: 'folder', mime: null, name: f.name }} />
                    <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                    <span className="shrink-0 text-xs text-[var(--fg-muted)]">
                      {t.editor.zipFolder(f.files)} · {formatBytes(f.size)}
                    </span>
                  </button>
                </li>
              );
            })}
            {here.files.map((e) => {
              const key = keyOf(e.path);
              const name = e.path[e.path.length - 1]!;
              return (
                <li key={key} className="flex min-h-12 items-center gap-3 px-3 py-1">
                  <input
                    type="checkbox"
                    checked={!e.encrypted && (coveredHere || picked.has(key))}
                    disabled={e.encrypted || coveredHere}
                    aria-label={t.editor.zipSelect(name)}
                    onChange={() => toggle(key)}
                  />
                  <FileIcon node={{ kind: 'file', mime: null, name }} />
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                  {e.encrypted ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--fg-muted)]">
                      <Lock className="h-3.5 w-3.5" />
                      {t.editor.zipLocked}
                    </span>
                  ) : (
                    <>
                      <span className="shrink-0 text-xs text-[var(--fg-muted)]">
                        {formatBytes(e.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void download(e)}
                        className="shrink-0 rounded-full p-2 hover:bg-[var(--bg-subtle)]"
                        aria-label={t.editor.zipDownload(name)}
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {busy && (
        <Busy
          label={t.editor.zipExtracting(busy.done, busy.total)}
          progress={busy.total ? busy.done / busy.total : null}
        />
      )}
    </EditorFrame>
  );
}
