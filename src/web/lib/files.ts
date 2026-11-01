import type { ActivityItem } from '../../shared/activity';
import type { DriveCrumb, DriveNode } from '../../shared/drive-tree';
import { api, postJson, sendJson } from './api';
import { treeHolding } from './drive-index';

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

/** A folder: from the person's index or their family's (ADR-077, ADR-078), else from the API. */
export async function listChildren(
  folderId: string,
  sort: SortKey,
  dir: 'asc' | 'desc',
  cursor?: string | null,
): Promise<ChildrenPage> {
  if (!cursor) {
    const tree = await treeHolding(folderId);
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
/** D11: files with the same content in the person's own pool, the biggest saving first. */
export interface DuplicateGroup {
  size: number;
  saving: number;
  items: Array<NodeDto & { path: Crumb[]; canRemove: boolean }>;
}
export const findDuplicates = () =>
  api<{ groups: DuplicateGroup[]; saving: number }>('/api/drive/duplicates');
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
/** D2 (ADR-085): who an item is shared with, and what others shared with the person. */
export interface PersonDto {
  id: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  role: 'view' | 'edit';
  pending: boolean;
  expiresAt: number | null;
  createdAt: number;
}
export const listPeople = (id: string) => api<{ items: PersonDto[] }>(`/api/nodes/${id}/people`);
export const addPeople = (id: string, emails: string[], role: 'view' | 'edit') =>
  sendJson<{ items: PersonDto[] }>('POST', `/api/nodes/${id}/people`, { emails, role });
export const setPersonRole = (id: string, gid: string, role: 'view' | 'edit') =>
  sendJson<{ items: PersonDto[] }>('PATCH', `/api/nodes/${id}/people/${gid}`, { role });
export const removePerson = (id: string, gid: string) =>
  sendJson<void>('DELETE', `/api/nodes/${id}/people/${gid}`);
export interface SharedWithMeItem {
  grantId: string;
  role: 'view' | 'edit';
  sharedBy: { id: string; name: string | null };
  sharedAt: number;
  expiresAt: number | null;
  node: NodeDto;
}
export const sharedWithMe = () => api<{ items: SharedWithMeItem[] }>('/api/shared-with-me');
/** D3 (ADR-086): file request links into a folder. */
export interface FileRequestDto {
  id: string;
  url: string;
  folderId: string;
  title: string;
  message: string | null;
  deadlineAt: number | null;
  maxFiles: number | null;
  maxFileBytes: number | null;
  requireName: boolean;
  hasPassword: boolean;
  fileCount: number;
  state: 'open' | 'revoked' | 'expired' | 'full' | 'unavailable';
  createdAt: number;
}
export const listFileRequests = (folderId?: string) =>
  api<{ items: FileRequestDto[] }>(`/api/file-requests${folderId ? `?folderId=${folderId}` : ''}`);
export const createFileRequest = (input: {
  folderId: string;
  title: string;
  message?: string | null;
  deadlineAt?: number | null;
  maxFiles?: number | null;
  maxFileBytes?: number | null;
  requireName?: boolean;
  password?: string | null;
}) => sendJson<{ request: FileRequestDto }>('POST', '/api/file-requests', input);
export const revokeFileRequest = (id: string) =>
  sendJson<void>('DELETE', `/api/file-requests/${id}`);
/** D1: a file's earlier contents, and how many versions each space keeps. */
export interface VersionDto {
  id: string;
  number: number;
  size: number;
  savedAt: number;
  contentAt: number;
  kept: boolean;
  expiresAt: number;
}
export const listVersions = (id: string) =>
  api<{ items: VersionDto[]; keep: number; days: number }>(`/api/nodes/${id}/versions`);
export const versionUrl = (id: string, vid: string) =>
  api<{ url: string; expiresAt: number }>(`/api/nodes/${id}/versions/${vid}/download`);
export const restoreVersion = (id: string, vid: string) =>
  sendJson<{ node: NodeDto }>('POST', `/api/nodes/${id}/versions/${vid}/restore`);
export const keepVersion = (id: string, vid: string, kept: boolean) =>
  sendJson<void>('PUT', `/api/nodes/${id}/versions/${vid}/keep`, { kept });
export const deleteVersion = (id: string, vid: string) =>
  sendJson<void>('DELETE', `/api/nodes/${id}/versions/${vid}`);
export interface VersionSettings {
  personal: { keepVersions: number };
  family: { keepVersions: number; canChange: boolean } | null;
  days: number;
  max: number;
}
export const driveSettings = () => api<{ versions: VersionSettings }>('/api/drive/settings');
export const setKeepVersions = (space: 'personal' | 'family', keepVersions: number) =>
  sendJson<{ versions: VersionSettings }>('PUT', '/api/drive/settings', { space, keepVersions });
/** D4: a node's activity (a folder's includes its direct contents), or the latest overall. */
export const nodeActivity = (id: string) =>
  api<{ items: ActivityItem[] }>(`/api/nodes/${id}/activity`);
export const recentActivity = () => api<{ items: ActivityItem[] }>('/api/activity');
/** D12: the day a node goes to the Trash by itself (YYYY-MM-DD, WIB), or null to clear it. */
export const setExpiry = (id: string, date: string | null) =>
  sendJson<{ node: NodeDto }>('PUT', `/api/nodes/${id}/expiry`, { date });
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
