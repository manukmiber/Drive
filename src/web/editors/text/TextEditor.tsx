// Text and code editor (ADR-051): CodeMirror 6, the language picked from the file name (and loaded
// only then), find & replace, wrapping, and a preview for Markdown.
import { basicSetup } from 'codemirror';
import { openSearchPanel } from '@codemirror/search';
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Text } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tagHighlighter, tags } from '@lezer/highlight';
import { Eye, Redo2, Search, Undo2, WrapText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { lang, t } from '../../lib/i18n';
import { extOf, resultName, type EditRequest, type Source } from '../files';
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
import { NotTextError, decodeText, encodeText, type TextFile } from './codec';
import { markdownHtml } from './markdown';
import './text.css';

const MARKDOWN = new Set(['md', 'markdown', 'mdx']);

const highlighter = tagHighlighter([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword],
    class: 'tok-keyword',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape, tags.character],
    class: 'tok-string',
  },
  {
    tag: [tags.number, tags.bool, tags.atom, tags.null, tags.literal, tags.unit],
    class: 'tok-number',
  },
  { tag: [tags.comment, tags.meta], class: 'tok-comment' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.variableName),
      tags.macroName,
      tags.labelName,
    ],
    class: 'tok-def',
  },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'tok-type' },
  { tag: tags.tagName, class: 'tok-tag' },
  { tag: tags.heading, class: 'tok-tag tok-heading' },
  { tag: [tags.propertyName, tags.attributeName], class: 'tok-prop' },
  { tag: [tags.link, tags.url], class: 'tok-link' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: [tags.invalid, tags.deleted], class: 'tok-invalid' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--bg)', color: 'var(--fg)' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'var(--fg-muted)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--color-brand-500) 7%, transparent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-brand-500) 28%, transparent) !important',
  },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, #f59e0b 30%, transparent)',
    outline: '1px solid color-mix(in srgb, #f59e0b 60%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, #f59e0b 55%, transparent)',
  },
  '.cm-selectionMatch': {
    backgroundColor: 'color-mix(in srgb, var(--color-brand-500) 14%, transparent)',
  },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '8px 10px', fontSize: '13px' },
  '.cm-textfield': {
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    padding: '4px 8px',
  },
  '.cm-button': {
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
    backgroundImage: 'none',
    backgroundColor: 'var(--bg-subtle)',
    color: 'var(--fg)',
    padding: '4px 10px',
  },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    borderRadius: '8px',
    backgroundColor: 'var(--card)',
    color: 'var(--fg)',
  },
  '.cm-foldPlaceholder': {
    border: 'none',
    backgroundColor: 'var(--bg-subtle)',
    color: 'var(--fg-muted)',
  },
});

export function TextEditor({ request, onClose }: { request: EditRequest; onClose: () => void }) {
  const { sources, progress, error } = useSources(request, 'text');
  const source = sources?.[0] ?? null;
  const [file, setFile] = useState<TextFile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    source.blob
      .arrayBuffer()
      .then((b) => alive && setFile(decodeText(new Uint8Array(b))))
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof NotTextError ? t.editor.notText : t.editor.cannotOpen);
      });
    return () => {
      alive = false;
    };
  }, [source]);

  const title = source?.name ?? t.editor.text;
  if (error || loadError)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Failed message={(error ?? loadError)!} onClose={onClose} />
      </EditorFrame>
    );
  if (!source || !file)
    return (
      <EditorFrame title={title} onClose={onClose}>
        <Busy label={t.editor.loadingFile(Math.round(progress * 100))} progress={progress} />
      </EditorFrame>
    );
  return <Workspace start={source} file={file} onClose={onClose} />;
}

function Workspace({
  start,
  file,
  onClose,
}: {
  start: Source;
  file: TextFile;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedDoc = useRef<Text | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const [source, setSource] = useState(start);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [wrap, setWrap] = useState(true);
  const [preview, setPreview] = useState(false);
  const [previewSrc, setPreviewSrc] = useState('');
  const [edits, setEdits] = useState(0);
  const [results, setResults] = useState<{ list: Result[]; doc: Text } | null>(null);
  const compartments = useMemo(() => ({ wrap: new Compartment(), lang: new Compartment() }), []);
  const markdown = MARKDOWN.has(extOf(source.name));
  const previewOn = preview && markdown;

  // The editor is made once; React only switches its compartments.
  useEffect(() => {
    const phrases = t.editor.codePhrases;
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: file.text,
        extensions: [
          basicSetup,
          syntaxHighlighting(highlighter),
          theme,
          EditorState.phrases.of(phrases),
          compartments.wrap.of(EditorView.lineWrapping),
          compartments.lang.of([]),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                saveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setDirty(!u.state.doc.eq(savedDoc.current!));
              setEdits((n) => n + 1);
            }
            if (u.docChanged || u.selectionSet) {
              const head = u.state.selection.main.head;
              const line = u.state.doc.lineAt(head);
              setCursor({ line: line.number, col: head - line.from + 1 });
            }
            if (u.transactions.length) {
              setHistory({
                undo: undoDepth(u.state) > 0,
                redo: redoDepth(u.state) > 0,
              });
            }
          }),
        ],
      }),
    });
    savedDoc.current = view.state.doc;
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [file, compartments]);

  // The language follows the name (a new file renamed to .md becomes Markdown).
  useEffect(() => {
    let alive = true;
    const desc = LanguageDescription.matchFilename(languages, source.name);
    if (!desc) {
      viewRef.current?.dispatch({ effects: compartments.lang.reconfigure([]) });
      return;
    }
    desc
      .load()
      .then((support) => {
        if (alive) viewRef.current?.dispatch({ effects: compartments.lang.reconfigure(support) });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [source.name, compartments]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.wrap.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap, compartments]);

  // The preview is drawn from the text a moment after typing stops.
  useEffect(() => {
    if (!previewOn) return;
    const id = setTimeout(() => setPreviewSrc(viewRef.current?.state.doc.toString() ?? ''), 200);
    return () => clearTimeout(id);
  }, [previewOn, edits]);
  const previewHtml = useMemo(
    () => (previewOn ? markdownHtml(previewSrc) : ''),
    [previewOn, previewSrc],
  );

  function save() {
    const view = viewRef.current;
    if (!view || results) return;
    const doc = view.state.doc;
    const blob = encodeText(doc.toString(), file, source.blob.type || 'text/plain');
    // A new or already saved file keeps its name; a Drive file is offered as "… (edited)".
    const name = source.node
      ? resultName(source.name, extOf(source.name), t.editor.editSuffix)
      : source.name;
    setResults({ list: [{ blob, name }], doc });
  }
  // Ctrl+S inside the editor reaches the latest one.
  useEffect(() => {
    saveRef.current = save;
  });

  /** Runs a command from the top bar; the text gets the keyboard back unless a panel took it. */
  function exec(cmd: (v: EditorView) => boolean, refocus = true) {
    const v = viewRef.current;
    if (!v) return;
    cmd(v);
    if (refocus) v.focus();
  }

  return (
    <EditorFrame
      title={source.name}
      onClose={onClose}
      dirty={dirty}
      actions={
        <>
          <BarButton
            icon={Undo2}
            label={t.editor.undo}
            onClick={() => exec(undo)}
            disabled={!history.undo}
          />
          <BarButton
            icon={Redo2}
            label={t.editor.redo}
            onClick={() => exec(redo)}
            disabled={!history.redo}
          />
          <BarButton
            icon={Search}
            label={t.editor.findReplace}
            onClick={() => {
              // On a phone the preview covers the text, and the search box lives in the text.
              setPreview(false);
              exec(openSearchPanel, false);
            }}
          />
          <BarButton
            icon={WrapText}
            label={t.editor.wrapLines}
            active={wrap}
            onClick={() => setWrap((w) => !w)}
            // Phones keep wrapping on, and the title keeps the room.
            className="hidden sm:block"
          />
          {markdown && (
            <BarButton
              icon={Eye}
              label={t.editor.mdPreview}
              active={previewOn}
              onClick={() => setPreview((p) => !p)}
            />
          )}
          <Button onClick={save} className="ml-1 h-9 px-4">
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className={cn('flex min-h-0 flex-1', previewOn && 'md:grid md:grid-cols-2')}>
        <div
          ref={host}
          className={cn('z-code min-h-0 min-w-0 flex-1', previewOn && 'hidden md:block')}
        />
        {previewOn && (
          <div className="min-h-0 flex-1 overflow-auto border-[var(--border)] bg-[var(--card)] px-5 py-4 md:border-l">
            <div
              className="z-prose mx-auto max-w-3xl"
              lang={lang}
              // Cleaned by DOMPurify (sanitize.ts); the CSP refuses inline scripts too.
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        )}
      </div>
      <footer className="flex items-center gap-3 border-t border-[var(--border)] bg-[var(--card)] px-3 py-1 text-[11px] text-[var(--fg-muted)]">
        <span>{t.editor.cursorAt(cursor.line, cursor.col)}</span>
        <span className="ml-auto">{t.editor.textFormat(file.crlf)}</span>
      </footer>
      <SaveDialog
        results={results?.list ?? null}
        source={source}
        preferReplace
        onClose={() => setResults(null)}
        onSaved={(saved) => {
          if (results) savedDoc.current = results.doc;
          const view = viewRef.current;
          setDirty(Boolean(view && savedDoc.current && !view.state.doc.eq(savedDoc.current)));
          if (saved) setSource(savedSource(source, saved));
        }}
      />
    </EditorFrame>
  );
}
