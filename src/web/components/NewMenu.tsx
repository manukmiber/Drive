import { useQueryClient } from '@tanstack/react-query';
import {
  FileSpreadsheet,
  FileText,
  FileType2,
  FileUp,
  FolderPlus,
  FolderUp,
  Plus,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { EditorHost } from '../editors/EditorHost';
import type { EditRequest, Tool } from '../editors/files';
import { t } from '../lib/i18n';
import { ApiError } from '../lib/api';
import { useCurrentFolder } from '../lib/explorer-store';
import { createFolder, filesKeys } from '../lib/files';
import { fromInput, resolveTargets } from '../upload/folders';
import { uploads } from '../upload/useUploads';
import { PromptDialog } from './ui/Dialog';
import { Menu, type MenuItem } from './ui/Menu';
import { toast } from './ui/Toast';

export function NewMenu({ variant }: { variant: 'sidebar' | 'fab' }) {
  const folder = useCurrentFolder();
  const qc = useQueryClient();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [naming, setNaming] = useState(false);
  // A new, empty file opens in its editor and is saved into this folder (ADR-051).
  const [blank, setBlank] = useState<EditRequest | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  async function addFiles(list: FileList | null) {
    if (!list?.length || !folder) return;
    try {
      const targets = await resolveTargets(folder.id, fromInput(list));
      await uploads().add(targets);
      void qc.invalidateQueries({ queryKey: filesKeys.allChildren(folder.id) });
    } catch (e) {
      toast(e instanceof ApiError ? t.errors.generic : String(e), { tone: 'error' });
    }
  }

  const create = (tool: Tool, name: string) => () =>
    folder && setBlank({ tool, nodes: [], files: [], blank: { name, folderId: folder.id } });

  const items: MenuItem[] = [
    { label: t.nav.newFolder, icon: FolderPlus, onSelect: () => setNaming(true) },
    { label: t.nav.newDocument, icon: FileType2, onSelect: create('doc', t.editor.untitledDoc) },
    {
      label: t.nav.newSpreadsheet,
      icon: FileSpreadsheet,
      onSelect: create('sheet', t.editor.untitledSheet),
    },
    { label: t.nav.newTextFile, icon: FileText, onSelect: create('text', t.editor.untitledText) },
    { label: t.nav.uploadFile, icon: FileUp, onSelect: () => fileInput.current?.click() },
    { label: t.nav.uploadFolder, icon: FolderUp, onSelect: () => dirInput.current?.click() },
  ];

  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Above the button on phones: about 37px a row.
    setMenu(
      variant === 'fab'
        ? { x: r.right - 200, y: r.top - 12 - items.length * 37 }
        : { x: r.left, y: r.bottom + 4 },
    );
  };

  return (
    <>
      {variant === 'sidebar' ? (
        <button
          type="button"
          onClick={open}
          disabled={!folder}
          className="z-primary inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold disabled:opacity-50"
        >
          <Plus className="h-5 w-5" aria-hidden="true" />
          {t.nav.newButton}
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={open}
            disabled={!folder}
            aria-label={t.nav.newButton}
            className="z-primary fixed right-4 bottom-24 z-30 flex h-14 w-14 items-center justify-center rounded-2xl disabled:opacity-50 md:hidden"
          >
            <Plus className="h-6 w-6" />
          </button>
          {/* Wide screens have "New" in the sidebar; this one only uploads, straight to the picker. */}
          {folder && (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              aria-label={t.nav.uploadFile}
              title={t.nav.uploadFile}
              className="z-primary fixed right-6 bottom-6 z-30 hidden h-14 w-14 items-center justify-center rounded-2xl shadow-lg md:flex"
            >
              <Plus className="h-6 w-6" aria-hidden="true" />
            </button>
          )}
        </>
      )}
      {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={items} />}
      {blank && <EditorHost request={blank} onClose={() => setBlank(null)} />}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))}
      />
      <input
        ref={dirInput}
        type="file"
        hidden
        // @ts-expect-error non-standard but widely supported folder picker attribute
        webkitdirectory=""
        onChange={(e) => void addFiles(e.target.files).finally(() => (e.target.value = ''))}
      />
      <PromptDialog
        open={naming}
        title={t.files.newFolderTitle}
        initial={t.files.newFolderName}
        confirmLabel={t.files.create}
        onCancel={() => setNaming(false)}
        onSubmit={async (name) => {
          setNaming(false);
          if (!folder) return;
          try {
            await createFolder(folder.id, name);
            await qc.invalidateQueries({ queryKey: filesKeys.allChildren(folder.id) });
          } catch (e) {
            toast(
              e instanceof ApiError && e.code === 'INVALID_NAME'
                ? t.errors.invalidName
                : t.errors.generic,
              { tone: 'error' },
            );
          }
        }}
      />
    </>
  );
}
