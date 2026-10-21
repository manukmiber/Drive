import { api, sendJson } from './api';

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
export const copyNode = (id: string) =>
  sendJson<{ node: NodeDto }>('POST', `/api/nodes/${id}/copy`, {});
export const moveNodes = (ids: string[], targetId: string) =>
  sendJson<{ nodes: NodeDto[] }>('POST', '/api/nodes/move', { ids, targetId });
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
