import { api, postJson, sendJson } from './api';

export interface NodeDto {
  id: string;
  parentId: string | null;
  kind: 'file' | 'folder';
  name: string;
  size: number;
  mime: string | null;
  status: 'uploading' | 'scanning' | 'ready' | 'rejected';
  scanStatus: string | null;
  space: 'personal' | 'family';
  ownerId: string;
  createdBy: string;
  familyCanEdit: boolean;
  starred: boolean;
  hasThumb: boolean;
  trashedAt: number | null;
  purgeAt: number | null;
  createdAt: number;
  updatedAt: number;
  clientModifiedAt: number | null;
}

export interface Crumb {
  id: string;
  name: string;
}

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

export function listChildren(
  folderId: string,
  sort: SortKey,
  dir: 'asc' | 'desc',
  cursor?: string | null,
) {
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

/** Browser-rendered preview is possible for these (decided server-side too). */
export function canPreview(n: NodeDto): boolean {
  if (n.kind !== 'file' || n.status === 'rejected' || n.status === 'uploading') return false;
  const m = n.mime ?? '';
  return (
    /^(image\/(jpeg|png|webp|avif|gif|bmp|heic)|video\/|audio\/|text\/|application\/(pdf|json|xml))/.test(
      m,
    ) ||
    /\.(pdf|txt|md|csv|json|xml|svg|html?|css|js|ts|py|go|rs|java|c|cpp|sh|ya?ml|toml|sql|log)$/i.test(
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
}
export const listShares = (nodeId?: string) =>
  api<{ items: ShareDto[] }>(`/api/shares${nodeId ? `?nodeId=${nodeId}` : ''}`);
export const createShare = (body: {
  nodeIds: string[];
  expiresInHours?: number | null;
  maxDownloads?: number | null;
  password?: string | null;
}) => postJson<{ share: ShareDto }>('/api/shares', body);
export const updateShare = (
  id: string,
  body: { expiresInHours?: number | null; maxDownloads?: number | null; password?: string | null },
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
export const emailShare = (id: string, recipients: string[], message: string | null) =>
  postJson<{ queued: number; suppressed: number }>(`/api/shares/${id}/sends`, {
    mode: 'email',
    recipients,
    message,
  });

/** Downloads several items as one ZIP via a signed /z/ link. */
export async function downloadZip(
  nodeIds: string[],
  format: 'zip_store' | 'zip_deflate' = 'zip_store',
): Promise<void> {
  const { url } = await postJson<{ url: string }>('/api/archives', { nodeIds, format });
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
