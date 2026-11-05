// Spreadsheet (ADR-051): FortuneSheet with formulas, number formats, merged cells, freezing,
// sorting, filters and several sheets. Opens .xlsx (FortuneExcel), .csv and .tsv and new
// spreadsheets; saves .xlsx, or the open sheet as CSV.
import { Workbook, type WorkbookInstance } from '@fortune-sheet/react';
import '@fortune-sheet/react/dist/index.css';
import { FileDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocPerson } from '../../../shared/space-doc';
import { Button } from '../../components/Button';
import { Menu } from '../../components/ui/Menu';
import { toast } from '../../components/ui/Toast';
import { useCatalog } from '../../lib/catalog';
import { useFolderNav } from '../../lib/folder-nav';
import { t } from '../../lib/i18n';
import { isDocFrame } from '../../lib/live-doc';
import { useSpaceRoom } from '../../lib/space-room';
import { colourOf } from '../doc/collab';
import {
  extOf,
  replaceAndWait,
  resultName,
  withExt,
  type EditRequest,
  type Source,
} from '../files';
import { SheetCollab, type SheetPhase } from './collab';
import {
  BarButton,
  Busy,
  EditorFrame,
  Failed,
  SaveDialog,
  savedSource,
  useSources,
  type Result,
} from '../ui';
import {
  detectDelimiter,
  parseCsv,
  rowsOf,
  sheetFromRows,
  toCsv,
  type Delimiter,
  type SheetCell,
  type SheetData,
} from './csv';
import { localizeFortuneSheet } from './locale';

localizeFortuneSheet();

// What the editor offers: FortuneSheet's own list without the parts that need more than a
// browser (screenshots, charts) or have no Indonesian yet (conditional formats, data checks).
const TOOLBAR = [
  'undo',
  'redo',
  'format-painter',
  'clear-format',
  '|',
  'currency-format',
  'percentage-format',
  'number-decrease',
  'number-increase',
  'format',
  '|',
  'font-size',
  '|',
  'bold',
  'italic',
  'strike-through',
  'underline',
  '|',
  'font-color',
  'background',
  'border',
  'merge-cell',
  '|',
  'horizontal-align',
  'vertical-align',
  'text-wrap',
  '|',
  'freeze',
  'filter',
  'link',
  'comment',
  'quick-formula',
  'search',
];
const HEADER_MENU = [
  'copy',
  'paste',
  '|',
  'insert-row',
  'insert-column',
  'delete-row',
  'delete-column',
  'delete-cell',
  'hide-row',
  'hide-column',
  'set-row-height',
  'set-column-width',
  '|',
  'clear',
  'sort',
  'orderAZ',
  'orderZA',
];
const CELL_MENU = [...HEADER_MENU, 'filter', 'link', 'cell-format'];

type Format = 'xlsx' | 'csv';

/** CSV from Excel on Windows is often not UTF-8; such a file is read as Windows-1252. */
function decode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * FortuneSheet starts a sheet on a selection without an end ("A1:NaN" until the first click), and
 * FortuneExcel reads a one-cell selection the same way; such sheets start on A1 instead.
 */
function startOnA1(sheet: SheetData): SheetData {
  const open = (r?: Array<number | null>) => !r || r.length < 2 || r.some((n) => n == null);
  const sel = sheet.luckysheet_select_save;
  if (!sel?.length || sel.some((s) => open(s.row) || open(s.column)))
    sheet.luckysheet_select_save = [{ row: [0, 0], column: [0, 0] }];
  return sheet;
}

async function open(source: Source): Promise<{ sheets: SheetData[]; delimiter: Delimiter }> {
  const ext = extOf(source.name);
  if (!source.blob.size)
    return {
      sheets: [{ name: t.editor.firstSheet, celldata: [], order: 0, status: 1 }],
      delimiter: ',',
    };
  if (ext === 'csv' || ext === 'tsv') {
    const text = decode(await source.blob.arrayBuffer());
    const delimiter = ext === 'tsv' ? '\t' : detectDelimiter(text);
    return { sheets: [sheetFromRows(parseCsv(text, delimiter), t.editor.firstSheet)], delimiter };
  }
  const { readXlsx } = await import('./xlsx');
  return { sheets: await readXlsx(source.blob, source.name), delimiter: ',' };
}

export function SheetEditor({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, 'sheet');
  const source = sources?.[0] ?? null;
  const [start, setStart] = useState<{ sheets: SheetData[]; delimiter: Delimiter } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    open(source)
      .then((s) => {
        if (!alive) return;
        if (s.sheets.length) setStart({ ...s, sheets: s.sheets.map(startOnA1) });
        else setLoadError(t.editor.cannotOpen);
      })
      .catch(() => alive && setLoadError(t.editor.cannotOpen));
    return () => {
      alive = false;
    };
  }, [source]);

  const title = source?.name ?? t.editor.sheet;
  if (error || loadError)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Failed message={(error ?? loadError)!} onClose={onClose} />
      </EditorFrame>
    );
  if (!source || !start)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Busy label={t.editor.loadingFile(Math.round(progress * 100))} progress={progress} />
      </EditorFrame>
    );
  return <Choose source={source} start={start} onClose={onClose} />;
}

/** A Space's .xlsx opens to be edited together (W6, ADR-100); anything else, alone. */
function Choose({
  source,
  start,
  onClose,
}: {
  source: Source;
  start: { sheets: SheetData[]; delimiter: Delimiter };
  onClose: () => void;
}) {
  const area = useFolderNav();
  const catalog = useCatalog();
  const [solo, setSolo] = useState(false);
  const together =
    !solo &&
    source.node?.space === 'team' &&
    extOf(source.name) === 'xlsx' &&
    Boolean(area?.spaceId) &&
    Boolean(catalog.data?.capabilities?.spacesChat);
  if (together)
    return (
      <Together
        source={source}
        start={start}
        spaceId={area!.spaceId!}
        onClose={onClose}
        onAlone={() => setSolo(true)}
      />
    );
  return <Workspace start={source} {...start} onClose={onClose} />;
}

/** How often the saver writes the file while people edit (it is also written on leaving). */
const SAVE_EVERY_MS = 60_000;

interface Shared {
  collab: SheetCollab;
  sheets: SheetData[];
  people: DocPerson[];
  saver: boolean;
}

function Together({
  source,
  start,
  spaceId,
  onClose,
  onAlone,
}: {
  source: Source;
  start: { sheets: SheetData[]; delimiter: Delimiter };
  spaceId: string;
  onClose: () => void;
  onAlone: () => void;
}) {
  const room = useSpaceRoom(spaceId, true);
  const [phase, setPhase] = useState<SheetPhase>('joining');
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [people, setPeople] = useState<DocPerson[]>([]);
  const [saver, setSaver] = useState(false);
  const [refused, setRefused] = useState(false);
  const { send, listen } = room;
  const nodeId = source.node!.id;
  const [collab] = useState(
    () =>
      new SheetCollab({ send }, nodeId, start.sheets, {
        phase: setPhase,
        start: setSheets,
        people: setPeople,
        saver: setSaver,
      }),
  );
  const open = room.state.status === 'open';

  useEffect(() => {
    if (!open) return;
    const off = listen((f) => {
      if (f.t === 'error' && f.nonce === `doc:${nodeId}`) {
        if (collab.phase !== 'live') setRefused(true);
        else toast(t.editor.together.refused, { tone: 'error' });
      } else if (isDocFrame(f)) collab.live.take(f);
    });
    collab.join();
    return () => {
      off();
      collab.leave();
    };
  }, [open, listen, nodeId, collab]);

  const down = ['unavailable', 'removed', 'gone', 'signin'].includes(room.state.status);
  if (refused || (down && phase !== 'live'))
    return (
      <EditorFrame title={source.name} onClose={onClose}>
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="max-w-sm text-sm text-[var(--fg-muted)]">{t.editor.together.cannot}</p>
          <Button variant="secondary" onClick={onAlone}>
            {t.editor.together.alone}
          </Button>
        </div>
      </EditorFrame>
    );
  if (phase !== 'live' || !sheets)
    return (
      <EditorFrame title={source.name} onClose={onClose}>
        <Busy label={t.editor.together.joining} />
      </EditorFrame>
    );
  return (
    <Workspace
      start={source}
      sheets={sheets}
      delimiter={start.delimiter}
      onClose={onClose}
      shared={{ collab, sheets, people, saver }}
    />
  );
}

function People({ people }: { people: DocPerson[] }) {
  if (people.length < 2) return null;
  return (
    <span
      className="mr-1 flex items-center -space-x-1.5"
      title={t.editor.together.with(people.map((p) => p.name).join(', '))}
    >
      {people.slice(0, 4).map((p) => (
        <span
          key={p.user}
          className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-[var(--card)]"
          style={{ background: colourOf(p.user) }}
          aria-label={p.name}
        >
          {(p.name.trim()[0] ?? '?').toUpperCase()}
        </span>
      ))}
    </span>
  );
}

function Workspace({
  start,
  sheets,
  delimiter,
  onClose,
  shared,
}: {
  start: Source;
  sheets: SheetData[];
  delimiter: Delimiter;
  onClose: () => void;
  /** Edited together (W6): the room has the live copy, the saver writes the file. */
  shared?: Shared;
}) {
  const book = useRef<WorkbookInstance>(null);
  const collab = shared?.collab ?? null;
  const [source, setSource] = useState(start);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ list: Result[]; same: boolean } | null>(null);
  const [saveMenu, setSaveMenu] = useState<{ x: number; y: number } | null>(null);
  const ext = extOf(source.name);
  const own: Format = ext === 'csv' || ext === 'tsv' ? 'csv' : 'xlsx';

  async function save(format: Format) {
    const wb = book.current;
    if (!wb) return;
    setBusy(true);
    try {
      let blob: Blob;
      let name: string;
      if (format === 'xlsx') {
        const { writeXlsx } = await import('./xlsx');
        blob = await writeXlsx(wb);
        name = withExt(source.name, 'xlsx');
      } else {
        // A CSV holds one sheet: the open one.
        if (wb.getAllSheets().length > 1) toast(t.editor.csvOneSheet);
        const data = (wb.getSheet().data ?? []) as Array<Array<SheetCell | null>>;
        const tsv = ext === 'tsv';
        blob = new Blob([toCsv(rowsOf(data), tsv ? '\t' : delimiter)], {
          type: tsv ? 'text/tab-separated-values' : 'text/csv',
        });
        name = withExt(source.name, tsv ? 'tsv' : 'csv');
      }
      const same = extOf(name) === ext;
      setResults({
        list: [
          {
            blob,
            name: same && source.node ? resultName(source.name, ext, t.editor.editSuffix) : name,
          },
        ],
        same,
      });
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // W6: the saver writes the file now and then, and when leaving; anyone may write it now.
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const writeNow = useCallback(async (): Promise<boolean> => {
    const wb = book.current;
    if (!wb || !collab || !source.node || writingRef.current) return false;
    writingRef.current = true;
    setWriting(true);
    try {
      collab.live.flush();
      const upto = collab.live.last;
      const { writeXlsx } = await import('./xlsx');
      await replaceAndWait(await writeXlsx(wb), source.node);
      collab.wrote(upto);
      return true;
    } catch {
      toast(t.editor.together.saveFailed, { tone: 'error' });
      return false;
    } finally {
      writingRef.current = false;
      setWriting(false);
    }
  }, [collab, source]);
  const isSaver = Boolean(shared?.saver);
  useEffect(() => {
    if (!isSaver || !collab) return;
    const id = setInterval(() => {
      if (collab.unsaved) void writeNow();
    }, SAVE_EVERY_MS);
    return () => clearInterval(id);
  }, [isSaver, collab, writeNow]);

  async function leave() {
    if (collab && isSaver && collab.unsaved) await writeNow();
    onClose();
  }

  return (
    <EditorFrame
      title={source.name}
      onClose={() => void leave()}
      dirty={!collab && dirty}
      actions={
        <>
          {shared && (
            <>
              <People people={shared.people} />
              <span
                className="mr-1 hidden text-xs text-[var(--fg-muted)] sm:inline"
                aria-live="polite"
              >
                {writing ? t.editor.together.saving : t.editor.together.live}
              </span>
            </>
          )}
          <BarButton
            icon={FileDown}
            label={t.editor.saveAs}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSaveMenu({ x: r.right - 240, y: r.bottom + 4 });
            }}
          />
          <Button
            onClick={() =>
              collab
                ? void writeNow().then((ok) => ok && toast(t.editor.together.saved))
                : void save(own)
            }
            disabled={busy || writing}
            className="ml-1 h-9 px-4"
          >
            {t.common.save}
          </Button>
        </>
      }
    >
      <div
        className="relative min-h-0 flex-1 bg-white text-black [color-scheme:light]"
        // Escape belongs to the sheet here (leaving a cell, closing its menus), not to closing.
        onKeyDown={(e) => {
          if (e.key === 'Escape') e.preventDefault();
        }}
      >
        {/* zk-sheet: the grid takes every touch itself (scrolling it on a phone), so pulling it
            down never reloads the page. */}
        <div className="zk-sheet absolute inset-0">
          <Workbook
            ref={(wb) => {
              book.current = wb;
              collab?.attach(wb);
            }}
            data={sheets as never}
            lang="en"
            currency="Rp"
            toolbarItems={TOOLBAR}
            cellContextMenu={CELL_MENU}
            headerContextMenu={HEADER_MENU}
            // FortuneSheet reports changes while it is still drawing itself.
            onOp={(ops) => (collab ? collab.local(ops) : queueMicrotask(() => setDirty(true)))}
          />
        </div>
      </div>
      {saveMenu && (
        <Menu
          x={saveMenu.x}
          y={saveMenu.y}
          onClose={() => setSaveMenu(null)}
          items={[
            { label: t.editor.sheetFormats.xlsx!, onSelect: () => void save('xlsx') },
            { label: t.editor.sheetFormats.csv!, onSelect: () => void save('csv') },
          ]}
        />
      )}
      {busy && <Busy label={t.editor.working} />}
      <SaveDialog
        results={results?.list ?? null}
        source={source}
        replaceable={results?.same ?? true}
        preferReplace
        onClose={() => setResults(null)}
        onSaved={(where) => {
          if (!results?.same) return;
          setDirty(false);
          if (where) setSource(savedSource(source, where));
        }}
      />
    </EditorFrame>
  );
}
