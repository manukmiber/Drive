// Document editor (ADR-051): TipTap on a page. Opens .docx (through mammoth) and new documents;
// saves .docx (docx/html), Markdown or a web page.
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Columns3,
  FileDown,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  Link2Off,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  RemoveFormatting,
  Rows3,
  Strikethrough,
  Table2,
  TableCellsMerge,
  Trash2,
  Underline,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { PromptDialog } from '../../components/ui/Dialog';
import { Menu } from '../../components/ui/Menu';
import { toast } from '../../components/ui/Toast';
import type { DocPerson } from '../../../shared/space-doc';
import { useCatalog } from '../../lib/catalog';
import { cn } from '../../lib/cn';
import { useFolderNav } from '../../lib/folder-nav';
import { lang, t } from '../../lib/i18n';
import { isDocFrame } from '../../lib/live-doc';
import { useMe } from '../../lib/session';
import { useSpaceRoom } from '../../lib/space-room';
import { replaceAndWait, resultName, withExt, type EditRequest, type Source } from '../files';
import { DocCollab, colourOf, type DocPhase } from './collab';
import '../prose.css';
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
import { pictureUrl } from './picture';

type Format = 'docx' | 'md' | 'html';

export function DocEditor({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, 'doc');
  const source = sources?.[0] ?? null;
  const [start, setStart] = useState<{ html: string; fromWord: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    // mammoth only for a Word file (a new document starts empty).
    (source.blob.size
      ? import('./read').then((m) => m.readDocx(source.blob))
      : Promise.resolve({ html: '' })
    )
      .then(({ html }) => alive && setStart({ html, fromWord: source.blob.size > 0 }))
      .catch(() => alive && setLoadError(t.editor.cannotOpen));
    return () => {
      alive = false;
    };
  }, [source]);

  const title = source?.name ?? t.editor.doc;
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
  return <Choose source={source} html={start.html} fromWord={start.fromWord} onClose={onClose} />;
}

/** A Space's Word file opens to be edited together (W6, ADR-100); anything else, alone. */
function Choose({
  source,
  html,
  fromWord,
  onClose,
}: {
  source: Source;
  html: string;
  fromWord: boolean;
  onClose: () => void;
}) {
  const area = useFolderNav();
  const catalog = useCatalog();
  const me = useMe();
  const [solo, setSolo] = useState(false);
  const together =
    !solo &&
    Boolean(me.data) &&
    source.node?.space === 'team' &&
    /\.docx$/i.test(source.name) &&
    Boolean(area?.spaceId) &&
    Boolean(catalog.data?.capabilities?.spacesChat);
  if (together)
    return (
      <Together
        source={source}
        html={html}
        spaceId={area!.spaceId!}
        me={{ id: me.data!.user.id, name: me.data!.user.name || me.data!.user.email }}
        onClose={onClose}
        onAlone={() => setSolo(true)}
      />
    );
  return <Workspace start={source} html={html} fromWord={fromWord} onClose={onClose} />;
}

/** How often the saver writes the file while people edit (it is also written on leaving). */
const SAVE_EVERY_MS = 60_000;

interface Shared {
  collab: DocCollab;
  phase: DocPhase;
  people: DocPerson[];
  saver: boolean;
}

function Together({
  source,
  html,
  spaceId,
  me,
  onClose,
  onAlone,
}: {
  source: Source;
  html: string;
  spaceId: string;
  me: { id: string; name: string };
  onClose: () => void;
  onAlone: () => void;
}) {
  const room = useSpaceRoom(spaceId, true);
  const [phase, setPhase] = useState<DocPhase>('joining');
  const [people, setPeople] = useState<DocPerson[]>([]);
  const [saver, setSaver] = useState(false);
  const [refused, setRefused] = useState(false);
  const { send, listen } = room;
  const nodeId = source.node!.id;
  // One shared copy for as long as the editor is open; it joins whenever the room is there.
  const [collab] = useState(
    () =>
      new DocCollab({ send }, nodeId, me, {
        phase: setPhase,
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
  if (phase === 'joining' || phase === 'waiting')
    return (
      <EditorFrame title={source.name} onClose={onClose}>
        <Busy label={t.editor.together.joining} />
      </EditorFrame>
    );
  return (
    <Workspace
      start={source}
      html={html}
      fromWord={false}
      onClose={onClose}
      shared={{ collab, phase, people, saver }}
    />
  );
}

function People({ people, me }: { people: DocPerson[]; me: string | undefined }) {
  const others = people.filter((p) => p.user !== me);
  if (!others.length) return null;
  return (
    <span
      className="mr-1 flex items-center -space-x-1.5"
      title={t.editor.together.with(others.map((p) => p.name).join(', '))}
    >
      {others.slice(0, 4).map((p) => (
        <span
          key={p.user}
          className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-[var(--card)]"
          style={{ background: colourOf(p.user) }}
          aria-label={p.name}
        >
          {(p.name.trim()[0] ?? '?').toUpperCase()}
        </span>
      ))}
      {others.length > 4 && (
        <span className="pl-2.5 text-xs text-[var(--fg-muted)]">+{others.length - 4}</span>
      )}
    </span>
  );
}

function Workspace({
  start,
  html,
  fromWord,
  onClose,
  shared,
}: {
  start: Source;
  html: string;
  fromWord: boolean;
  onClose: () => void;
  /** Edited together (W6): the document lives in the room, the file is written by the saver. */
  shared?: Shared;
}) {
  const me = useMe();
  const collab = shared?.collab ?? null;
  const [source, setSource] = useState(start);
  // The document as last saved, with the editor it belongs to (a document only compares with one
  // of its own editor; React's strict mode makes two in development).
  const [saved, setSaved] = useState<{ editor: Editor; doc: PmNode } | null>(null);
  const [results, setResults] = useState<{ list: Result[]; doc: PmNode; same: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(fromWord);
  const [linking, setLinking] = useState<string | null>(null);
  const [saveMenu, setSaveMenu] = useState<{ x: number; y: number } | null>(null);
  const picture = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      // No extra empty paragraph at the end: opening a file must not change it (the gap cursor
      // still lets you write after a table).
      StarterKit.configure({
        link: { openOnClick: false, defaultProtocol: 'https' },
        trailingNode: false,
        // Edited together, undo is Yjs's own (it undoes only this person's changes).
        ...(collab ? { undoRedo: false as const } : {}),
      }),
      ...(collab
        ? [
            Collaboration.configure({ document: collab.ydoc }),
            CollaborationCaret.configure({
              provider: { awareness: collab.awareness },
              user: collab.awareness.getLocalState()?.user as Record<string, string>,
            }),
          ]
        : []),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Highlight,
      Image.configure({ allowBase64: true }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({
        nested: true,
        a11y: { checkboxLabel: (node) => t.editor.taskCheckbox(node.textContent) },
      }),
      Placeholder.configure({ placeholder: t.editor.docPlaceholder }),
      CharacterCount,
      Markdown,
    ],
    // Edited together the document comes from the room; the first person fills it from the file.
    content: collab ? undefined : html,
    autofocus: 'start',
    editorProps: {
      attributes: {
        class: 'z-prose min-h-[60vh] outline-none',
        lang,
        'aria-label': t.editor.doc,
      },
    },
    // What was opened counts as saved once the editor has tidied it (tables, lists).
    onCreate: ({ editor: e }) => {
      if (collab) {
        if (collab.phase === 'seeding') {
          e.commands.setContent(html);
          collab.seeded();
        }
        return;
      }
      setTimeout(() => setSaved({ editor: e, doc: e.state.doc }));
    },
  });

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null;
      return {
        block: e.isActive('heading', { level: 1 })
          ? 'h1'
          : e.isActive('heading', { level: 2 })
            ? 'h2'
            : e.isActive('heading', { level: 3 })
              ? 'h3'
              : 'p',
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        highlight: e.isActive('highlight'),
        link: e.isActive('link'),
        align:
          (['center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ??
          'left',
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        task: e.isActive('taskList'),
        quote: e.isActive('blockquote'),
        table: e.isActive('table'),
        canMerge: e.can().mergeCells(),
        canSplit: e.can().splitCell(),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        words: (e.storage.characterCount as { words: () => number }).words(),
        dirty: !collab && saved?.editor === e && !e.state.doc.eq(saved.doc),
      };
    },
  });

  // W6: the saver writes the file now and then, and when leaving; anyone may write it now.
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const writeNow = useCallback(async (): Promise<boolean> => {
    if (!editor || !collab || !source.node || writingRef.current) return false;
    writingRef.current = true;
    setWriting(true);
    try {
      collab.live.flush();
      const upto = collab.live.last;
      const { writeDocx } = await import('./write');
      const blob = await writeDocx(editor.getHTML(), source.name.replace(/\.docx$/i, ''));
      await replaceAndWait(blob, source.node);
      collab.wrote(upto);
      return true;
    } catch {
      toast(t.editor.together.saveFailed, { tone: 'error' });
      return false;
    } finally {
      writingRef.current = false;
      setWriting(false);
    }
  }, [editor, collab, source]);
  const isSaver = Boolean(shared?.saver);
  useEffect(() => {
    if (!isSaver || !collab) return;
    const id = setInterval(() => {
      if (collab.unsaved) void writeNow();
    }, SAVE_EVERY_MS);
    return () => clearInterval(id);
  }, [isSaver, collab, writeNow]);

  if (!editor || !s)
    return (
      <EditorFrame title={source.name} onClose={onClose}>
        <Busy label={t.common.loading} />
      </EditorFrame>
    );

  /** Leaving a shared document: the saver writes what the file does not have yet. */
  async function leave() {
    if (collab && isSaver && collab.unsaved) await writeNow();
    onClose();
  }

  const chain = () => editor.chain().focus();

  async function save(format: Format) {
    if (!editor) return;
    setBusy(true);
    try {
      const doc = editor.state.doc;
      const body = editor.getHTML();
      const base = withExt(source.name, format);
      // The writers load on the first save.
      const { htmlPage, writeDocx } = await import('./write');
      let blob: Blob;
      if (format === 'docx') blob = await writeDocx(body, base.replace(/\.docx$/i, ''));
      else if (format === 'md') blob = new Blob([editor.getMarkdown()], { type: 'text/markdown' });
      else blob = htmlPage(body, base.replace(/\.html$/i, ''), lang);
      // The same kind of file keeps its name (and is offered as a replacement); another is a copy.
      const same = format === 'docx';
      const name = same
        ? source.node
          ? resultName(source.name, 'docx', t.editor.editSuffix)
          : source.name
        : base;
      setResults({ list: [{ blob, name }], doc, same });
    } catch {
      toast(t.errors.generic, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function setBlock(v: string) {
    if (v === 'p') chain().setParagraph().run();
    else
      chain()
        .toggleHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 })
        .run();
  }

  function setLink(url: string) {
    setLinking(null);
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    chain().extendMarkRange('link').setLink({ href }).run();
  }

  async function addPicture(file: File | undefined) {
    if (!file) return;
    try {
      const src = await pictureUrl(file);
      chain().setImage({ src, alt: file.name }).run();
    } catch {
      toast(t.editor.cannotOpen, { tone: 'error' });
    }
  }

  return (
    <EditorFrame
      title={source.name}
      onClose={() => void leave()}
      dirty={s.dirty}
      actions={
        <>
          {shared && (
            <>
              <People people={shared.people} me={me.data?.user.id} />
              <span
                className="mr-1 hidden text-xs text-[var(--fg-muted)] sm:inline"
                aria-live="polite"
              >
                {writing ? t.editor.together.saving : t.editor.together.live}
              </span>
            </>
          )}
          <BarButton
            icon={Undo2}
            label={t.editor.undo}
            onClick={() => chain().undo().run()}
            disabled={!s.canUndo}
          />
          <BarButton
            icon={Redo2}
            label={t.editor.redo}
            onClick={() => chain().redo().run()}
            disabled={!s.canRedo}
          />
          <BarButton
            icon={FileDown}
            label={t.editor.saveAs}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSaveMenu({ x: r.right - 220, y: r.bottom + 4 });
            }}
          />
          <Button
            onClick={() =>
              collab
                ? void writeNow().then((ok) => ok && toast(t.editor.together.saved))
                : void save('docx')
            }
            disabled={busy || writing}
            className="ml-1 h-9 px-4"
          >
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="border-b border-[var(--border)] bg-[var(--card)]">
        <div
          className="flex items-center gap-0.5 overflow-x-auto px-2 py-1.5"
          role="toolbar"
          aria-label={t.editor.formatting}
        >
          <select
            value={s.block}
            onChange={(e) => setBlock(e.target.value)}
            aria-label={t.editor.textStyle}
            className="mr-1 h-8 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 text-sm"
          >
            <option value="p">{t.editor.blocks.p}</option>
            <option value="h1">{t.editor.blocks.h1}</option>
            <option value="h2">{t.editor.blocks.h2}</option>
            <option value="h3">{t.editor.blocks.h3}</option>
          </select>
          <Tb
            icon={Bold}
            label={t.editor.bold}
            on={s.bold}
            run={() => chain().toggleBold().run()}
          />
          <Tb
            icon={Italic}
            label={t.editor.italic}
            on={s.italic}
            run={() => chain().toggleItalic().run()}
          />
          <Tb
            icon={Underline}
            label={t.editor.underline}
            on={s.underline}
            run={() => chain().toggleUnderline().run()}
          />
          <Tb
            icon={Strikethrough}
            label={t.editor.strike}
            on={s.strike}
            run={() => chain().toggleStrike().run()}
          />
          <Tb
            icon={Highlighter}
            label={t.editor.highlight}
            on={s.highlight}
            run={() => chain().toggleHighlight().run()}
          />
          <Sep />
          <Tb
            icon={AlignLeft}
            label={t.editor.alignLeft}
            on={s.align === 'left'}
            run={() => chain().setTextAlign('left').run()}
          />
          <Tb
            icon={AlignCenter}
            label={t.editor.alignCenter}
            on={s.align === 'center'}
            run={() => chain().setTextAlign('center').run()}
          />
          <Tb
            icon={AlignRight}
            label={t.editor.alignRight}
            on={s.align === 'right'}
            run={() => chain().setTextAlign('right').run()}
          />
          <Tb
            icon={AlignJustify}
            label={t.editor.alignJustify}
            on={s.align === 'justify'}
            run={() => chain().setTextAlign('justify').run()}
          />
          <Sep />
          <Tb
            icon={List}
            label={t.editor.bulletList}
            on={s.bullet}
            run={() => chain().toggleBulletList().run()}
          />
          <Tb
            icon={ListOrdered}
            label={t.editor.orderedList}
            on={s.ordered}
            run={() => chain().toggleOrderedList().run()}
          />
          <Tb
            icon={ListChecks}
            label={t.editor.taskList}
            on={s.task}
            run={() => chain().toggleTaskList().run()}
          />
          <Tb
            icon={Quote}
            label={t.editor.quote}
            on={s.quote}
            run={() => chain().toggleBlockquote().run()}
          />
          <Sep />
          <Tb
            icon={Link2}
            label={t.editor.link}
            on={s.link}
            run={() => setLinking((editor.getAttributes('link').href as string | undefined) ?? '')}
          />
          {s.link && (
            <Tb icon={Link2Off} label={t.editor.unlink} run={() => chain().unsetLink().run()} />
          )}
          <Tb icon={ImagePlus} label={t.editor.picture} run={() => picture.current?.click()} />
          <Tb
            icon={Table2}
            label={t.editor.table}
            on={s.table}
            run={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          />
          <Tb icon={Minus} label={t.editor.rule} run={() => chain().setHorizontalRule().run()} />
          <Tb
            icon={RemoveFormatting}
            label={t.editor.clearFormat}
            run={() => chain().unsetAllMarks().clearNodes().run()}
          />
        </div>
        {s.table && (
          <div
            className="flex items-center gap-0.5 overflow-x-auto border-t border-[var(--border)] px-2 py-1.5"
            role="toolbar"
            aria-label={t.editor.table}
          >
            <TextTb icon={Rows3} label={t.editor.addRow} run={() => chain().addRowAfter().run()} />
            <TextTb
              icon={Columns3}
              label={t.editor.addColumn}
              run={() => chain().addColumnAfter().run()}
            />
            <TextTb icon={X} label={t.editor.deleteRow} run={() => chain().deleteRow().run()} />
            <TextTb
              icon={X}
              label={t.editor.deleteColumn}
              run={() => chain().deleteColumn().run()}
            />
            {(s.canMerge || s.canSplit) && (
              <TextTb
                icon={TableCellsMerge}
                label={s.canMerge ? t.editor.mergeCells : t.editor.splitCell}
                run={() => (s.canMerge ? chain().mergeCells().run() : chain().splitCell().run())}
              />
            )}
            <TextTb
              icon={Trash2}
              label={t.editor.deleteTable}
              run={() => chain().deleteTable().run()}
            />
          </div>
        )}
      </div>
      {note && (
        <div className="flex items-start gap-2 border-b border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="flex-1">{t.editor.fromWordNote}</p>
          <button
            type="button"
            onClick={() => setNote(false)}
            className="rounded p-0.5 hover:bg-amber-200/50"
            aria-label={t.common.close}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg-subtle)] px-2 py-4 sm:px-6 sm:py-8">
        <div className="mx-auto max-w-[52rem] rounded-xl border border-[var(--border)] bg-[var(--card)] px-5 py-6 shadow-sm sm:px-14 sm:py-12">
          <EditorContent editor={editor} />
        </div>
      </div>
      <footer className="border-t border-[var(--border)] bg-[var(--card)] px-3 py-1 text-[11px] text-[var(--fg-muted)]">
        {t.editor.words(s.words)}
      </footer>
      <input
        ref={picture}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          void addPicture(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {saveMenu && (
        <Menu
          x={saveMenu.x}
          y={saveMenu.y}
          onClose={() => setSaveMenu(null)}
          items={(['docx', 'md', 'html'] as const).map((f) => ({
            label: t.editor.formats[f] ?? f,
            onSelect: () => void save(f),
          }))}
        />
      )}
      <PromptDialog
        open={linking !== null}
        title={t.editor.linkTitle}
        initial={linking ?? ''}
        confirmLabel={t.common.save}
        onCancel={() => setLinking(null)}
        onSubmit={setLink}
      />
      {busy && <Busy label={t.editor.working} />}
      <SaveDialog
        results={results?.list ?? null}
        source={source}
        replaceable={results?.same ?? true}
        preferReplace
        onClose={() => setResults(null)}
        onSaved={(where) => {
          if (!results) return;
          // Another kind of file is a copy: the document still belongs to the .docx.
          if (!results.same) return;
          setSaved({ editor, doc: results.doc });
          if (where) setSource(savedSource(source, where));
        }}
      />
    </EditorFrame>
  );
}

function Tb({
  icon: Icon,
  label,
  run,
  on,
}: {
  icon: LucideIcon;
  label: string;
  run: () => void;
  on?: boolean;
}) {
  return (
    <button
      type="button"
      // Keep the text selection: the editor would lose it to the button on a mouse press.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={cn(
        'shrink-0 rounded-lg p-1.5 text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]',
        on && 'bg-[var(--accent-soft)] text-[var(--accent)] hover:text-[var(--accent)]',
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}

function TextTb({
  icon: Icon,
  label,
  run,
}: {
  icon: LucideIcon;
  label: string;
  run: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[var(--fg-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--fg)]"
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-[var(--border)]" aria-hidden="true" />;
