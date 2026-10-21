import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
} from 'lucide-react';
import type { NodeDto } from '../lib/files';

export function iconFor(node: Pick<NodeDto, 'kind' | 'mime' | 'name'>) {
  if (node.kind === 'folder') return { Icon: Folder, color: 'text-brand-600' };
  const m = node.mime ?? '';
  const ext = node.name.split('.').pop()?.toLowerCase() ?? '';
  if (m.startsWith('image/')) return { Icon: FileImage, color: 'text-rose-500' };
  if (m.startsWith('video/')) return { Icon: FileVideo, color: 'text-purple-500' };
  if (m.startsWith('audio/')) return { Icon: FileAudio, color: 'text-amber-500' };
  if (/zip|rar|7z|tar|gzip|zstd/.test(m) || ['zip', 'rar', '7z', 'gz', 'zst', 'tar'].includes(ext))
    return { Icon: FileArchive, color: 'text-yellow-600' };
  if (/sheet|excel|csv/.test(m) || ['xlsx', 'xls', 'csv', 'ods'].includes(ext))
    return { Icon: FileSpreadsheet, color: 'text-green-600' };
  if (['js', 'ts', 'py', 'json', 'html', 'css', 'go', 'rs', 'java', 'c', 'cpp', 'sh'].includes(ext))
    return { Icon: FileCode, color: 'text-sky-600' };
  if (
    m.startsWith('text/') ||
    m === 'application/pdf' ||
    ['pdf', 'doc', 'docx', 'txt', 'md', 'odt'].includes(ext)
  )
    return { Icon: FileText, color: 'text-blue-600' };
  return { Icon: File, color: 'text-[var(--fg-muted)]' };
}

export function FileIcon({
  node,
  className = 'h-5 w-5',
}: {
  node: Pick<NodeDto, 'kind' | 'mime' | 'name'>;
  className?: string;
}) {
  const { Icon, color } = iconFor(node);
  return <Icon className={`${className} ${color} shrink-0`} aria-hidden="true" />;
}
