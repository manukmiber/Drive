// Shared item actions for every file view (Drive, Cari, Berbintang, Terbaru): open/preview,
// download, rename, copy, compress, star, move, trash (with undo), details — plus the dialogs they need.
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Clapperboard,
  Copy,
  Download,
  Eye,
  FileCode2,
  FilePen,
  FileImage,
  FolderInput,
  FolderOpen,
  ImageIcon,
  Info,
  Minimize2,
  Pencil,
  Share2,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import {
  canPreview,
  copyNode,
  downloadFile,
  moveNodes,
  renameNode,
  restoreNodes,
  setStar,
  trashNodes,
  type NodeDto,
} from '../../lib/files';
import { isCompressible } from '../../lib/compress';
import { EditorHost } from '../../editors/EditorHost';
import {
  editable,
  isImage,
  isPdf,
  isText,
  isVideo,
  toolFor,
  type EditRequest,
} from '../../editors/files';
import { useMe } from '../../lib/session';
import { Button } from '../Button';
import { Dialog, PromptDialog } from '../ui/Dialog';
import type { MenuItem } from '../ui/Menu';
import { toast } from '../ui/Toast';
import { CompressDialog } from './CompressDialog';
import { Details } from './Details';
import { MoveDialog } from './MoveDialog';
import { Preview } from './Preview';
import { ShareDialog } from './ShareDialog';

export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return t.errors.generic;
  const map: Record<string, string> = {
    NAME_CONFLICT: t.errors.nameConflict,
    INVALID_NAME: t.errors.invalidName,
    QUOTA_FULL: t.errors.quotaFull,
    FORBIDDEN: t.errors.forbidden,
    NOT_FOUND: t.errors.notFound,
    READ_ONLY: t.errors.readOnly,
    RATE_LIMITED: t.errors.rateLimited,
    NETWORK: t.errors.network,
  };
  return map[e.code] ?? t.errors.generic;
}

export function useNodeActions(items: NodeDto[]) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const rootId = me.data?.space.personalRootId ?? '';
  const [renaming, setRenaming] = useState<NodeDto | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<{ list: NodeDto[]; index: number } | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [sharing, setSharing] = useState<NodeDto[] | null>(null);
  const [compressing, setCompressing] = useState<NodeDto[] | null>(null);
  const [editing, setEditing] = useState<EditRequest | null>(null);
  /** Opens the editor for one Drive file (from the preview). */
  const edit = useCallback((node: NodeDto) => {
    const tool = toolFor(node.mime, node.name);
    if (tool && editable(node)) {
      setPreview(null);
      setEditing({ tool, nodes: [node], files: [] });
    }
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['children'] }),
      qc.invalidateQueries({ queryKey: ['starred'] }),
      qc.invalidateQueries({ queryKey: ['recent'] }),
      qc.invalidateQueries({ queryKey: ['search'] }),
      qc.invalidateQueries({ queryKey: ['trash'] }),
      qc.invalidateQueries({ queryKey: ['me'] }),
    ]);
  }, [qc]);

  const open = useCallback(
    (node: NodeDto) => {
      if (node.kind === 'folder') {
        void navigate(
          node.id === rootId
            ? { to: '/drive' }
            : { to: '/drive/$folderId', params: { folderId: node.id } },
        );
        return;
      }
      if (canPreview(node)) {
        const list = items.filter((i) => i.kind === 'file' && i.status !== 'rejected');
        setPreview({
          list,
          index: Math.max(
            0,
            list.findIndex((i) => i.id === node.id),
          ),
        });
        return;
      }
      void downloadFile(node.id).catch((e) => toast(errorText(e), { tone: 'error' }));
    },
    [items, navigate, rootId],
  );

  const trash = useCallback(
    async (ids: string[]) => {
      qc.setQueriesData<{ pages: Array<{ items: NodeDto[] }> }>(
        { queryKey: ['children'] },
        (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((p) => ({
                  ...p,
                  items: p.items.filter((i) => !ids.includes(i.id)),
                })),
              }
            : old,
      );
      try {
        await trashNodes(ids);
        toast(t.files.movedToTrash, {
          action: { label: t.common.undo, run: () => void restoreNodes(ids).then(refresh) },
        });
      } catch (e) {
        toast(errorText(e), { tone: 'error' });
      }
      void refresh();
    },
    [qc, refresh],
  );

  const [spaceConfirm, setSpaceConfirm] = useState<{
    ids: string[];
    targetId: string;
    to: string;
  } | null>(null);
  const move = useCallback(
    async (ids: string[], targetId: string, confirmed = false) => {
      try {
        await moveNodes(ids, targetId, confirmed);
        toast(t.files.moved);
      } catch (e) {
        const reason =
          e instanceof ApiError
            ? (e.data as { reason?: string; to?: string } | undefined)
            : undefined;
        if (reason?.reason === 'SPACE_CHANGE') {
          setSpaceConfirm({ ids, targetId, to: reason.to ?? 'family' });
          return;
        }
        toast(errorText(e), { tone: 'error' });
      }
      void refresh();
    },
    [refresh],
  );

  const copy = useCallback(
    async (ids: string[], targetId?: string) => {
      let n = 0;
      for (const id of ids) {
        try {
          await copyNode(id, targetId);
          n++;
        } catch (e) {
          toast(errorText(e), { tone: 'error' });
          break;
        }
      }
      if (n) toast(t.files.copied);
      void refresh();
    },
    [refresh],
  );

  const menuFor = (ids: string[]): MenuItem[] => {
    const nodes = items.filter((i) => ids.includes(i.id));
    const single = nodes.length === 1 ? nodes[0]! : null;
    const files = nodes.filter((n) => n.kind === 'file');
    const list: MenuItem[] = [];
    if (single?.kind === 'folder')
      list.push({ label: t.files.open, icon: FolderOpen, onSelect: () => open(single) });
    if (single?.kind === 'file' && canPreview(single))
      list.push({ label: t.files.preview, icon: Eye, onSelect: () => open(single) });
    if (single?.kind === 'file')
      list.push({
        label: t.common.download,
        icon: Download,
        disabled: single.status === 'rejected',
        onSelect: () =>
          void downloadFile(single.id).catch((e) => toast(errorText(e), { tone: 'error' })),
      });
    if (nodes.length && nodes.every((n) => n.status === 'ready'))
      list.push({ label: t.common.share, icon: Share2, onSelect: () => setSharing(nodes) });
    if (single)
      list.push({ label: t.common.rename, icon: Pencil, onSelect: () => setRenaming(single) });
    if (files.length === nodes.length && files.every((f) => f.status === 'ready'))
      list.push({ label: t.files.makeCopy, icon: Copy, onSelect: () => void copy(ids) });
    if (files.length && files.length === nodes.length && files.every(isCompressible))
      list.push({
        label: t.compress.action,
        icon: Minimize2,
        onSelect: () => setCompressing(files),
      });
    // Editors (ADR-050): ready files of one kind; several videos or PDFs are joined.
    const ready = files.length === nodes.length && files.every(editable);
    const all = (f: (mime: string | null, name: string) => boolean) =>
      ready && files.length > 0 && files.every((n) => f(n.mime, n.name));
    if (single && all(isImage))
      list.push({
        label: t.editor.editPhoto,
        icon: ImageIcon,
        onSelect: () => setEditing({ tool: 'photo', nodes: files, files: [] }),
      });
    if (all(isVideo))
      list.push({
        label: files.length === 1 ? t.editor.editVideo : t.editor.mergeVideos(files.length),
        icon: Clapperboard,
        onSelect: () => setEditing({ tool: 'video', nodes: files, files: [] }),
      });
    if (all(isPdf))
      list.push({
        label: files.length === 1 ? t.editor.openPdf : t.editor.mergePdfs(files.length),
        icon: FilePen,
        onSelect: () => setEditing({ tool: 'pdf', nodes: files, files: [] }),
      });
    if (all(isImage))
      list.push({
        label: t.editor.imagesToPdf,
        icon: FileImage,
        onSelect: () => setEditing({ tool: 'pdf', nodes: files, files: [], fromImages: true }),
      });
    if (single && all(isText) && toolFor(single.mime, single.name) === 'text')
      list.push({
        label: t.editor.editText,
        icon: FileCode2,
        onSelect: () => setEditing({ tool: 'text', nodes: files, files: [] }),
      });
    list.push({ label: t.files.moveTo, icon: FolderInput, onSelect: () => setMoving(ids) });
    if (single)
      list.push({
        label: single.starred ? t.files.unstar : t.files.star,
        icon: single.starred ? StarOff : Star,
        onSelect: () => void setStar(single.id, !single.starred).then(refresh),
      });
    if (single)
      list.push({ label: t.common.details, icon: Info, onSelect: () => setDetails(single.id) });
    list.push({
      label: t.files.moveToTrash,
      icon: Trash2,
      danger: true,
      onSelect: () => void trash(ids),
    });
    return list;
  };

  const ui: ReactNode = (
    <>
      <PromptDialog
        open={Boolean(renaming)}
        title={t.files.renameTitle}
        initial={renaming?.name ?? ''}
        selectBase={renaming?.kind === 'file'}
        confirmLabel={t.common.save}
        onCancel={() => setRenaming(null)}
        onSubmit={async (name) => {
          const node = renaming!;
          setRenaming(null);
          if (name === node.name) return;
          try {
            await renameNode(node.id, name);
            toast(t.files.renamed);
          } catch (e) {
            toast(errorText(e), { tone: 'error' });
          }
          void refresh();
        }}
      />
      <Dialog
        open={Boolean(spaceConfirm)}
        title={t.family.move}
        onClose={() => setSpaceConfirm(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSpaceConfirm(null)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={() => {
                const c = spaceConfirm!;
                setSpaceConfirm(null);
                void move(c.ids, c.targetId, true);
              }}
            >
              {t.family.move}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {spaceConfirm?.to === 'family'
            ? t.family.spaceConfirmFamily
            : t.family.spaceConfirmPrivate}
        </p>
      </Dialog>
      {moving && rootId && (
        <MoveDialog
          rootId={rootId}
          familyRootId={me.data?.space.familyRootId ?? null}
          excludeIds={moving}
          onCancel={() => setMoving(null)}
          onMove={(target) => {
            const ids = moving;
            setMoving(null);
            void move(ids, target);
          }}
        />
      )}
      {preview && (
        <Preview
          items={preview.list}
          index={preview.index}
          onIndex={(index) => setPreview({ ...preview, index })}
          onClose={() => setPreview(null)}
          onEdit={edit}
        />
      )}
      {editing && <EditorHost request={editing} onClose={() => setEditing(null)} />}
      {details && <Details id={details} onClose={() => setDetails(null)} />}
      {sharing && <ShareDialog nodes={sharing} onClose={() => setSharing(null)} />}
      {compressing && <CompressDialog nodes={compressing} onClose={() => setCompressing(null)} />}
    </>
  );

  return { open, trash, move, copy, menuFor, ui, setDetails, setRenaming, refresh };
}
