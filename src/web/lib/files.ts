import type { DriveCrumb, DriveNode } from '../../shared/drive-tree';
import { api, postJson, sendJson } from './api';
import { personalTree } from './drive-index';

/** Shared with the Worker and the index reads (ADR-077). */
export type NodeDto = DriveNode;
export type Crumb = DriveCrumb;

export type SortKey = 'name' | 'updated' | 'size' | 'type';

export interface ChildrenPage {
  folder: NodeDto;
  items: NodeDto[];
  nextCursor: string | null;
  path?: Crumb[];
}

export const filesKeys = {
  children: (folderId: string, sort: SortKey, dir: 'asc' | 'desc') =>
    ['children', folderId, sort, dir] as const,
  allChildren: (folderId: string) => ['children', folderId] as const,
  trash: ['trash'] as const,
};

/** A folder: the person's own from their index (ADR-077), anything else from the API. */
export async function listChildren(
  folderId: string,
  sort: SortKey,
  dir: 'asc' | 'desc',
  cursor?: string | null,
): Promise<ChildrenPage> {
  if (!cursor) {
    const tree = await personalTree();
    const folder = tree?.node(folderId);
    if (tree && folder?.kind === 'folder')
      return {
        folder,
        items: tree.children(folderId, sort, dir),
        nextCursor: null,
        path: tree.path(folderId),
      };
  }
  const q = new URLSearchParams({ sort, dir });
  if (cursor) q.set('cursor', cursor);
  return api<ChildrenPage>(`/api/nodes/${folderId}/children?${q}`);
}

export const createFolder = (
  parentId: string,
  name: string,
  onConflict: 'rename' | 'reuse' | 'error' = 'rename',
) => sendJson<{ node: NodeDto }>('POST', '/api/folders', { parentId, name, onConflict });
export const renameNode = (id: string, name: string) =>
  sendJson<{ node: NodeDto }>('PATCH', `/api/nodes/${id}`, { name });
export const trashNodes = (ids: string[]) =>
  sendJson<{ count: number }>('POST', '/api/nodes/trash', { ids });
export const restoreNodes = (ids: string[]) =>
  sendJson<{ nodes: NodeDto[] }>('POST', '/api/nodes/restore', { ids });
export const deleteForever = (ids: string[]) =>
  sendJson<{ count: number }>('POST', '/api/nodes/delete', { ids });
export const copyNode = (id: string, targetId?: string) =>
  sendJson<{ node: NodeDto }>('POST', `/api/nodes/${id}/copy`, targetId ? { targetId } : {});
export const moveNodes = (ids: string[], targetId: string, confirmSpaceChange = false) =>
  sendJson<{ nodes: NodeDto[] }>('POST', '/api/nodes/move', { ids, targetId, confirmSpaceChange });
/** Colour, icon and cover for folders (ADR-058): `null` clears a part, leaving it out keeps it. */
export const decorateFolders = (
  ids: string[],
  patch: { color?: string | null; icon?: string | null; coverId?: string | null },
) => postJson<{ nodes: NodeDto[] }>('/api/nodes/decor', { ids, ...patch });
export const listTrash = () => api<{ items: NodeDto[]; retentionDays: number }>('/api/trash');
export const emptyTrash = () => sendJson<{ count: number }>('POST', '/api/trash/empty');

/** Starts a browser download via the signed, cookie-less URL (SPEC §5.3). */
export async function downloadFile(id: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/api/files/${id}/download`);
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text';
export const previewInfo = (id: string) =>
  api<{ url: string; kind: PreviewKind | null; expiresAt: number }>(`/api/files/${id}/preview`);
export const nodeInfo = (id: string) =>
  api<{
    node: NodeDto;
    path: Crumb[];
    access: { view: boolean; edit: boolean; remove: boolean; isOwner: boolean };
  }>(`/api/nodes/${id}`);
export const setStar = (id: string, on: boolean) =>
  api<void>(`/api/nodes/${id}/star`, { method: on ? 'PUT' : 'DELETE' });
export const searchNodes = (q: string, type?: string) =>
  api<{ items: NodeDto[] }>(`/api/search?${new URLSearchParams({ q, ...(type ? { type } : {}) })}`);
export const listStarred = () => api<{ items: NodeDto[] }>('/api/starred');
export const listRecent = () => api<{ items: NodeDto[] }>('/api/recent');

/**
 * Opening these shows the preview (decided server-side too; .docx is drawn in the app, and a .xlsx
 * or .zip gets the button to its editor).
 */
export function canPreview(n: NodeDto): boolean {
  if (n.kind !== 'file' || n.status === 'rejected' || n.status === 'uploading') return false;
  const m = n.mime ?? '';
  return (
    /^(image\/(jpeg|png|webp|avif|gif|bmp|heic)|video\/|audio\/|text\/|application\/(pdf|json|xml))/.test(
      m,
    ) ||
    /\.(pdf|docx|xlsx|zip|txt|md|csv|json|xml|svg|html?|css|js|ts|py|go|rs|java|c|cpp|sh|ya?ml|toml|sql|log)$/i.test(
      n.name,
    )
  );
}

export interface ShareDto {
  id: string;
  url: string;
  kind: 'file' | 'bundle' | 'folder';
  title: string;
  expiresAt: number | null;
  maxDownloads: number | null;
  downloadCount: number;
  hasPassword: boolean;
  revokedAt: number | null;
  disabledReason: string | null;
  lastDownloadAt: number | null;
  createdAt: number;
  nodeIds: string[];
  /** Folder/bundle links open a list of the files first (ADR-054). */
  showListing: boolean;
}
export const listShares = (nodeId?: string) =>
  api<{ items: ShareDto[] }>(`/api/shares${nodeId ? `?nodeId=${nodeId}` : ''}`);
export const createShare = (body: {
  nodeIds: string[];
  expiresInHours?: number | null;
  maxDownloads?: number | null;
  password?: string | null;
  showListing?: boolean;
}) => postJson<{ share: ShareDto }>('/api/shares', body);
export const updateShare = (
  id: string,
  body: {
    expiresInHours?: number | null;
    maxDownloads?: number | null;
    password?: string | null;
    title?: string;
    showListing?: boolean;
  },
) => sendJson<{ share: ShareDto }>('PATCH', `/api/shares/${id}`, body);
export const revokeShare = (id: string) => api<void>(`/api/shares/${id}`, { method: 'DELETE' });
export const regenerateShare = (id: string) =>
  postJson<{ share: ShareDto }>(`/api/shares/${id}/regenerate`, {});
export const logShareSend = (id: string, channel: string, recipient?: string) =>
  postJson<{ sendId: string; recipient: string | null }>(`/api/shares/${id}/sends`, {
    mode: 'deeplink',
    channel,
    recipient: recipient ?? null,
  });
export const emailShare = (
  id: string,
  recipients: string[],
  message: string | null,
  turnstileToken: string | null = null,
) =>
  postJson<{ queued: number; suppressed: number }>(`/api/shares/${id}/sends`, {
    mode: 'email',
    recipients,
    message,
    turnstileToken,
  });

/** Downloads several items as one ZIP via a signed /z/ link. */
export type ArchiveFormat = 'zip_store' | 'zip_deflate' | 'tar_zst';

export interface ArchiveJob {
  id: string;
  name: string | null;
  format: ArchiveFormat;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  progress: number;
  totalBytes: number;
  outBytes: number | null;
  url: string | null;
  error: string | null;
  createdAt: number;
  expiresAt: number | null;
}

function clickLink(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Streams right away for ZIP; async formats return `{ async: true }` (watch listArchives). */
export async function downloadZip(
  nodeIds: string[],
  format: ArchiveFormat = 'zip_store',
  level?: 'fast' | 'normal' | 'max',
): Promise<{ async: boolean }> {
  const r = await postJson<{ url: string | null; async: boolean }>('/api/archives', {
    nodeIds,
    format,
    ...(level ? { level } : {}),
  });
  if (r.url) clickLink(r.url);
  return { async: r.async };
}

export const estimateArchive = (nodeIds: string[]) =>
  postJson<{ totalBytes: number; fileCount: number; streamDeflateMax: number; asyncMax: number }>(
    '/api/archives/estimate',
    { nodeIds },
  );

export const listArchives = () => api<{ jobs: ArchiveJob[] }>('/api/archives');
export { clickLink };
