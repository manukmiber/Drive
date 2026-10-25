// /alat — the editors for files from this device (ADR-050, ADR-051), or a new empty file. Drive
// files open in the same editors from their ⋮ menu or the preview.
import { Clapperboard, FileCode2, FileImage, FilePen, FileType2, ImageIcon } from 'lucide-react';
import { useRef, useState, type ComponentType } from 'react';
import { formatBytes } from '../../shared/format';
import { Button } from '../components/Button';
import { toast } from '../components/ui/Toast';
import { EditorHost } from '../editors/EditorHost';
import { maxBytes, type EditRequest, type Tool } from '../editors/files';
import { useConfig } from '../editors/ui';
import { t } from '../lib/i18n';

interface Card {
  id: string;
  tool: Tool;
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
  accept: string;
  multiple: boolean;
  fromImages?: boolean;
  /** Can start from nothing: the new file's name (saved to My Drive). */
  blank?: string;
}

const CARDS: Card[] = [
  {
    id: 'photo',
    tool: 'photo',
    icon: ImageIcon,
    title: t.editor.photo,
    body: t.editor.photoDesc,
    accept: 'image/*',
    multiple: false,
  },
  {
    id: 'video',
    tool: 'video',
    icon: Clapperboard,
    title: t.editor.video,
    body: t.editor.videoDesc,
    accept: 'video/*',
    multiple: true,
  },
  {
    id: 'pdf',
    tool: 'pdf',
    icon: FilePen,
    title: t.editor.pdf,
    body: t.editor.pdfDesc,
    accept: 'application/pdf,.pdf',
    multiple: true,
  },
  {
    id: 'images',
    tool: 'pdf',
    icon: FileImage,
    title: t.editor.imagesToPdf,
    body: t.editor.imagesToPdfDesc,
    accept: 'image/*',
    multiple: true,
    fromImages: true,
  },
  {
    id: 'doc',
    tool: 'doc',
    icon: FileType2,
    title: t.editor.doc,
    body: t.editor.docDesc,
    accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    multiple: false,
    blank: t.editor.untitledDoc,
  },
  {
    id: 'text',
    tool: 'text',
    icon: FileCode2,
    title: t.editor.text,
    body: t.editor.textDesc,
    accept: 'text/*,.md,.json,.xml,.yml,.yaml,.toml,.ini,.env,.conf,.log,.srt,.vtt,.csv,.tsv',
    multiple: false,
    blank: t.editor.untitledText,
  },
];

export function Tools() {
  const config = useConfig();
  const [editing, setEditing] = useState<EditRequest | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  function open(card: Card, list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const max = maxBytes(config, card.fromImages ? 'photo' : card.tool);
    if (max && files.some((f) => f.size > max))
      return toast(t.editor.tooLarge(formatBytes(max)), { tone: 'error' });
    setEditing({ tool: card.tool, nodes: [], files, fromImages: card.fromImages });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <header>
        <h1 className="text-xl font-semibold">{t.editor.toolsTitle}</h1>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">{t.editor.toolsSubtitle}</p>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2">
        {CARDS.map((c) => (
          <li key={c.id} className="z-card flex flex-col gap-3 rounded-2xl p-5">
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-[var(--accent-soft)] p-2.5 text-[var(--accent)]">
                <c.icon className="h-5 w-5" />
              </span>
              <h2 className="font-semibold">{c.title}</h2>
            </div>
            <p className="flex-1 text-sm text-[var(--fg-muted)]">{c.body}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => inputs.current.get(c.id)?.click()}
              >
                {t.editor.fromDevice}
              </Button>
              {c.blank && (
                <Button
                  variant="ghost"
                  className="flex-1"
                  onClick={() =>
                    setEditing({ tool: c.tool, nodes: [], files: [], blank: { name: c.blank! } })
                  }
                >
                  {t.editor.newBlank}
                </Button>
              )}
            </div>
            <input
              ref={(el) => {
                if (el) inputs.current.set(c.id, el);
              }}
              type="file"
              accept={c.accept}
              multiple={c.multiple}
              hidden
              onChange={(e) => {
                open(c, e.target.files);
                e.target.value = '';
              }}
            />
          </li>
        ))}
      </ul>
      <p className="text-sm text-[var(--fg-muted)]">{t.editor.fromDriveHint}</p>
      {editing && <EditorHost request={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
